import { dirname, join, relative } from 'path';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { createServer } from 'net';
import { exec } from 'child_process';
import { promisify } from 'util';



import * as nodePty from 'node-pty';
import { glob } from 'glob';


import type {
  CommandRunStatus,
  PackageScriptsResult,
  PortInUse,
  PortsInUseErrorData,
  ProjectCommand,
  ProjectSuggestionCommand,
  ProjectSuggestions,
  RunCommandEnvVar,
  RunCommandLogStream,
  RunStatus,
  WorkspacePackage,
} from '@shared/run-command-types';
import { RUN_COMMAND_ENV_SOURCES } from '@shared/run-command-types';

import { dbg } from '../lib/debug';
import { getChildProcessEnv } from '../lib/child-process-env';
import { ProjectCommandRepository } from '../database/repositories/project-commands';
import { ProjectRepository } from '../database/repositories/projects';
import { TaskRepository } from '../database/repositories/tasks';


const execAsync = promisify(exec);
const RUN_COMMAND_LOG_FLUSH_INTERVAL_MS = 50;
const RUN_COMMAND_LOG_FLUSH_BYTES = 16 * 1024;
const PROJECT_SUGGESTIONS_PATH = '.jean-claude/suggestions.json';
const RUN_COMMAND_ENV_SOURCE_KEYS = new Set(
  RUN_COMMAND_ENV_SOURCES.map((source) => source.key),
);

type ProcessSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';

function parseSuggestionEnvVar(value: unknown): RunCommandEnvVar | null {
  if (typeof value !== 'object' || value === null) return null;

  const item = value as Record<string, unknown>;
  if (
    typeof item.name !== 'string' ||
    !item.name.trim() ||
    typeof item.source !== 'string' ||
    !RUN_COMMAND_ENV_SOURCE_KEYS.has(item.source as RunCommandEnvVar['source'])
  ) {
    return null;
  }

  return {
    source: item.source as RunCommandEnvVar['source'],
    name: item.name.trim(),
    value: typeof item.value === 'string' ? item.value : undefined,
  };
}

function parseSuggestionCommand(value: unknown): ProjectSuggestionCommand | null {
  if (typeof value === 'string') {
    const command = value.trim();
    if (!command) return null;
    return {
      name: null,
      command,
      ports: [],
      portConflictStrategy: 'prompt',
      portOverrideProvider: 'env',
      portOverrideEnvVar: null,
      portOverrideArgs: null,
      envVars: [],
      confirmBeforeRun: false,
      confirmMessage: null,
    };
  }

  if (typeof value !== 'object' || value === null) return null;

  const item = value as Record<string, unknown>;
  if (typeof item.command !== 'string' || !item.command.trim()) return null;

  const ports = Array.isArray(item.ports)
    ? item.ports.filter((port): port is number => Number.isInteger(port))
    : [];
  const envVars = Array.isArray(item.envVars)
    ? item.envVars
        .map(parseSuggestionEnvVar)
        .filter((envVar): envVar is RunCommandEnvVar => Boolean(envVar))
    : [];

  return {
    name: typeof item.name === 'string' && item.name.trim() ? item.name : null,
    command: item.command.trim(),
    ports,
    portConflictStrategy:
      item.portConflictStrategy === 'use-available-port'
        ? 'use-available-port'
        : 'prompt',
    portOverrideProvider: item.portOverrideProvider === 'args' ? 'args' : 'env',
    portOverrideEnvVar:
      typeof item.portOverrideEnvVar === 'string' &&
      item.portOverrideEnvVar.trim()
        ? item.portOverrideEnvVar.trim()
        : null,
    portOverrideArgs:
      typeof item.portOverrideArgs === 'string' && item.portOverrideArgs.trim()
        ? item.portOverrideArgs.trim()
        : null,
    envVars,
    confirmBeforeRun: item.confirmBeforeRun === true,
    confirmMessage:
      typeof item.confirmMessage === 'string' && item.confirmMessage.trim()
        ? item.confirmMessage
        : null,
  };
}

function dedupeSuggestionCommands(
  commands: ProjectSuggestionCommand[],
): ProjectSuggestionCommand[] {
  const seen = new Set<string>();
  return commands.filter((command) => {
    if (seen.has(command.command)) return false;
    seen.add(command.command);
    return true;
  });
}

/**
 * Get all descendant PIDs of a given parent PID.
 * Uses `pgrep -P` on macOS/Linux to recursively find child processes.
 * This is needed because complex apps (e.g. Electron) spawn child processes
 * that may escape the process group and survive a group kill.
 */
async function getDescendantPids(parentPid: number): Promise<number[]> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execAsync(
        `wmic process where (ParentProcessId=${parentPid}) get ProcessId`,
      );
      const childPids = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^\d+$/.test(line))
        .map(Number);

      const allDescendants: number[] = [];
      for (const childPid of childPids) {
        allDescendants.push(childPid);
        const grandchildren = await getDescendantPids(childPid);
        allDescendants.push(...grandchildren);
      }
      return allDescendants;
    } catch {
      return [];
    }
  }

  // macOS / Linux: use pgrep -P
  try {
    const { stdout } = await execAsync(`pgrep -P ${parentPid}`);
    const childPids = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number)
      .filter(Number.isFinite);

    const allDescendants: number[] = [];
    for (const childPid of childPids) {
      allDescendants.push(childPid);
      const grandchildren = await getDescendantPids(childPid);
      allDescendants.push(...grandchildren);
    }
    return allDescendants;
  } catch {
    // pgrep returns exit code 1 when no processes found
    return [];
  }
}

/**
 * Kill a process and all its descendants. First collects the full process tree,
 * then sends the signal to all PIDs (leaf-first to avoid orphan reparenting).
 */
async function killProcessTree(
  pid: number,
  signal: string | number,
): Promise<void> {
  const descendants = await getDescendantPids(pid);

  // Kill descendants in reverse order (deepest children first)
  for (const descendantPid of descendants.reverse()) {
    try {
      process.kill(descendantPid, signal);
    } catch {
      // Process may already be dead
    }
  }

  // Kill the root process itself
  try {
    process.kill(pid, signal);
  } catch {
    // Process may already be dead
  }
}

function signalProcessGroupOrProcess(pid: number, signal: ProcessSignal): void {
  if (pid <= 0) return;

  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to the PTY shell process if group signaling fails.
    }
  }

  process.kill(pid, signal);
}

type StatusChangeCallback = (taskId: string, status: RunStatus) => void;
type LogCallback = (
  taskId: string,
  runCommandId: string,
  stream: RunCommandLogStream,
  text: string,
  generation: number,
) => void;

interface TrackedProcess {
  commandId: string;
  name: string | null;
  command: string;
  pty: nodePty.IPty;
  pid: number;
  status: 'running' | 'stopped' | 'errored';
  pendingLogBatches: Record<RunCommandLogStream, string>;
  logFlushTimer: ReturnType<typeof setTimeout> | null;
  logGeneration: number;
  /** Set to true once the 'exit' event fires */
  exited: boolean;
  /** Resolves when the process exits */
  exitPromise: Promise<{ exitCode: number; signal?: number }>;
}

interface RunCommandContext {
  taskName: string;
  projectName: string;
  worktreePath: string;
  projectPath: string;
  taskBranch: string;
  sourceBranch: string;
  defaultBranch: string;
  prId: string;
  prUrl: string;
}

class RunCommandService {
  private runningProcesses = new Map<string, Map<string, TrackedProcess>>();
  private logGenerations = new Map<string, number>();
  private commandOperationLocks = new Map<string, Promise<void>>();
  private statusChangeCallbacks: StatusChangeCallback[] = [];
  private logCallbacks: LogCallback[] = [];

  private getCommandKey({
    taskId,
    runCommandId,
  }: {
    taskId: string;
    runCommandId: string;
  }): string {
    return `${taskId}:${runCommandId}`;
  }

  private getLogGeneration(taskId: string, runCommandId: string): number {
    return (
      this.logGenerations.get(this.getCommandKey({ taskId, runCommandId })) ?? 0
    );
  }

  private setLogGeneration(
    taskId: string,
    runCommandId: string,
    generation: number,
  ): void {
    this.logGenerations.set(
      this.getCommandKey({ taskId, runCommandId }),
      generation,
    );
  }

  private async withCommandLock<T>({
    taskId,
    runCommandId,
    operation,
  }: {
    taskId: string;
    runCommandId: string;
    operation: () => Promise<T>;
  }): Promise<T> {
    const key = this.getCommandKey({ taskId, runCommandId });
    const previous = this.commandOperationLocks.get(key) ?? Promise.resolve();

    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.commandOperationLocks.set(key, current);
    await previous;

    try {
      return await operation();
    } finally {
      release();
      if (this.commandOperationLocks.get(key) === current) {
        this.commandOperationLocks.delete(key);
      }
    }
  }

  private waitForExit({
    tracked,
    timeoutMs,
  }: {
    tracked: TrackedProcess;
    timeoutMs: number;
  }): Promise<boolean> {
    if (tracked.exited) {
      return Promise.resolve(true);
    }

    return Promise.race([
      tracked.exitPromise.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), timeoutMs),
      ),
    ]);
  }

  onStatusChange(callback: StatusChangeCallback): () => void {
    this.statusChangeCallbacks.push(callback);
    return () => {
      const index = this.statusChangeCallbacks.indexOf(callback);
      if (index > -1) this.statusChangeCallbacks.splice(index, 1);
    };
  }

  onLog(callback: LogCallback): () => void {
    this.logCallbacks.push(callback);
    return () => {
      const index = this.logCallbacks.indexOf(callback);
      if (index > -1) this.logCallbacks.splice(index, 1);
    };
  }

  private notifyStatusChange(taskId: string): void {
    const status = this.getRunStatus(taskId);
    this.statusChangeCallbacks.forEach((cb) => cb(taskId, status));
  }

  private notifyLog(
    taskId: string,
    runCommandId: string,
    stream: RunCommandLogStream,
    text: string,
    generation: number,
  ): void {
    this.logCallbacks.forEach((cb) =>
      cb(taskId, runCommandId, stream, text, generation),
    );
  }

  private getTaskProcesses(taskId: string): Map<string, TrackedProcess> {
    if (!this.runningProcesses.has(taskId)) {
      this.runningProcesses.set(taskId, new Map<string, TrackedProcess>());
    }
    return this.runningProcesses.get(taskId)!;
  }

  private flushLogBatches({
    taskId,
    tracked,
  }: {
    taskId: string;
    tracked: TrackedProcess;
  }): void {
    if (tracked.logFlushTimer) {
      clearTimeout(tracked.logFlushTimer);
      tracked.logFlushTimer = null;
    }

    for (const stream of ['stdout', 'stderr'] as const) {
      const text = tracked.pendingLogBatches[stream];
      if (!text) continue;
      tracked.pendingLogBatches[stream] = '';
      this.notifyLog(
        taskId,
        tracked.commandId,
        stream,
        text,
        tracked.logGeneration,
      );
    }
  }

  private appendLogChunk({
    taskId,
    tracked,
    stream,
    chunk,
  }: {
    taskId: string;
    tracked: TrackedProcess;
    stream: RunCommandLogStream;
    chunk: string;
  }): void {
    tracked.pendingLogBatches[stream] += chunk;

    if (
      tracked.pendingLogBatches[stream].length >= RUN_COMMAND_LOG_FLUSH_BYTES
    ) {
      this.flushLogBatches({ taskId, tracked });
      return;
    }

    if (!tracked.logFlushTimer) {
      tracked.logFlushTimer = setTimeout(() => {
        this.flushLogBatches({ taskId, tracked });
      }, RUN_COMMAND_LOG_FLUSH_INTERVAL_MS);
    }
  }

  private async getPortsInUse(
    commands: ProjectCommand[],
  ): Promise<PortInUse[]> {
    const portsInUse: PortInUse[] = [];

    for (const command of commands) {
      for (const port of command.ports) {
        const processInfo = await this.checkPortInUse(port);
        if (processInfo) {
          portsInUse.push({
            port,
            commandId: command.id,
            command: command.command,
            processInfo,
          });
        }
      }
    }

    return portsInUse;
  }

  private getPortOverrideEnvVar(command: ProjectCommand): string | null {
    if (command.portConflictStrategy !== 'use-available-port') return null;
    if (command.portOverrideProvider !== 'env') return null;

    const envVarName = command.portOverrideEnvVar?.trim();
    return envVarName || 'PORT';
  }

  private shouldOverridePortWithArgs(command: ProjectCommand): boolean {
    return (
      command.portConflictStrategy === 'use-available-port' &&
      command.portOverrideProvider === 'args'
    );
  }

  private replacePortPlaceholder(value: string, port: string): string {
    return value.replaceAll('{PORT}', port);
  }

  private getCommandWithPortArgs({
    command,
    port,
  }: {
    command: ProjectCommand;
    port: string;
  }): string {
    const commandValue = this.replacePortPlaceholder(command.command, port);
    if (command.command.includes('{PORT}')) return commandValue;

    const args =
      command.portOverrideArgs?.trim() ||
      '--port {PORT}';

    return `${commandValue} ${this.replacePortPlaceholder(args, port)}`;
  }

  private getBlockingPortsInUse(
    portsInUse: PortInUse[],
    commands: ProjectCommand[],
  ): PortInUse[] {
    const commandsById = new Map(commands.map((command) => [command.id, command]));
    return portsInUse.filter((portInfo) => {
      const command = commandsById.get(portInfo.commandId);
      return (
        !command ||
        (!this.getPortOverrideEnvVar(command) &&
          !this.shouldOverridePortWithArgs(command))
      );
    });
  }

  private async getPortOverrides({
    commands,
    portsInUse,
  }: {
    commands: ProjectCommand[];
    portsInUse: PortInUse[];
  }): Promise<
    Map<string, { envOverrides?: Record<string, string>; command?: string }>
  > {
    const commandIdsWithConflicts = new Set(
      portsInUse.map((portInfo) => portInfo.commandId),
    );
    const overrides = new Map<
      string,
      { envOverrides?: Record<string, string>; command?: string }
    >();
    const excludedPorts = new Set(commands.flatMap((command) => command.ports));

    for (const command of commands) {
      if (!commandIdsWithConflicts.has(command.id)) continue;

      const envVarName = this.getPortOverrideEnvVar(command);
      const usesArgs = this.shouldOverridePortWithArgs(command);
      if (!envVarName && !usesArgs) continue;

      const port = await this.getAvailablePort({ excludedPorts });
      excludedPorts.add(port);
      const portValue = String(port);

      overrides.set(command.id, {
        envOverrides: envVarName ? { [envVarName]: portValue } : undefined,
        command: usesArgs
          ? this.getCommandWithPortArgs({ command, port: portValue })
          : undefined,
      });
    }

    return overrides;
  }

  private async getAvailablePort({
    excludedPorts = new Set<number>(),
  }: {
    excludedPorts?: Set<number>;
  } = {}): Promise<number> {
    while (true) {
      const port = await new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, () => {
          const address = server.address();
          server.close(() => {
            if (address && typeof address === 'object') {
              resolve(address.port);
              return;
            }
            reject(new Error('Failed to allocate available port'));
          });
        });
      });

      if (!excludedPorts.has(port)) {
        return port;
      }
    }
  }

  private async getRunCommandContext({
    taskId,
    projectId,
    workingDir,
  }: {
    taskId: string;
    projectId: string;
    workingDir: string;
  }): Promise<RunCommandContext> {
    const [task, project] = await Promise.all([
      TaskRepository.findById(taskId),
      ProjectRepository.findById(projectId),
    ]);

    return {
      taskName: task?.name?.trim() || task?.prompt.trim() || taskId,
      projectName: project?.name ?? projectId,
      worktreePath: workingDir,
      projectPath: project?.path ?? '',
      taskBranch: task?.branchName ?? '',
      sourceBranch: task?.sourceBranch ?? '',
      defaultBranch: project?.defaultBranch ?? '',
      prId: task?.pullRequestId ?? '',
      prUrl: task?.pullRequestUrl ?? '',
    };
  }

  private async getCommandEnv({
    command,
    context,
  }: {
    command: ProjectCommand;
    context: RunCommandContext;
  }): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    const addEnv = (name: string | undefined, value: string) => {
      const trimmed = name?.trim();
      if (trimmed) env[trimmed] = value;
    };

    const shouldAllocateAvailablePort = command.envVars.some(
      (envVar) => envVar.source === 'availablePort' && envVar.name.trim(),
    );
    const availablePort = shouldAllocateAvailablePort
      ? String(await this.getAvailablePort())
      : '';

    for (const envVar of command.envVars) {
      if (!envVar.name.trim()) continue;

      const value =
        envVar.source === 'custom'
          ? (envVar.value ?? '')
          : envVar.source === 'availablePort'
            ? availablePort
            : context[envVar.source];
      addEnv(envVar.name, value);
    }

    return env;
  }

  private async spawnTrackedCommand({
    taskId,
    workingDir,
    command,
    context,
    envOverrides = {},
    commandOverride,
  }: {
    taskId: string;
    workingDir: string;
    command: ProjectCommand;
    context: RunCommandContext;
    envOverrides?: Record<string, string>;
    commandOverride?: string;
  }): Promise<void> {
    const commandValue = commandOverride ?? command.command;
    dbg.runCommand('Spawning command via PTY: %s', commandValue);
    const commandEnv = await this.getCommandEnv({ command, context });

    const shell =
      process.platform === 'win32' ? 'cmd.exe' : process.env.SHELL || '/bin/sh';
    const shellArgs =
      process.platform === 'win32'
        ? ['/c', commandValue]
        : ['-c', commandValue];

    const ptyProcess = nodePty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: workingDir,
      env: getChildProcessEnv({ overrides: { ...commandEnv, ...envOverrides } }),
    });

    let exitResolve: (value: { exitCode: number; signal?: number }) => void;
    const exitPromise = new Promise<{ exitCode: number; signal?: number }>(
      (resolve) => {
        exitResolve = resolve;
      },
    );

    const trackedProcess: TrackedProcess = {
      commandId: command.id,
      name: command.name,
      command: commandValue,
      pty: ptyProcess,
      pid: ptyProcess.pid,
      status: 'running',
      pendingLogBatches: { stdout: '', stderr: '' },
      logFlushTimer: null,
      logGeneration: this.getLogGeneration(taskId, command.id),
      exited: false,
      exitPromise,
    };

    const taskProcesses = this.getTaskProcesses(taskId);
    taskProcesses.set(command.id, trackedProcess);

    dbg.runCommand(
      'PTY process started with PID %d for command: %s',
      trackedProcess.pid,
      commandValue,
    );

    ptyProcess.onData((data: string) => {
      this.appendLogChunk({
        taskId,
        tracked: trackedProcess,
        stream: 'stdout',
        chunk: data,
      });
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      if (trackedProcess.exited) return;

      dbg.runCommand(
        'PTY process %d exited with code %d signal %d',
        trackedProcess.pid,
        exitCode,
        signal,
      );
      this.flushLogBatches({ taskId, tracked: trackedProcess });
      trackedProcess.exited = true;
      trackedProcess.status = exitCode === 0 ? 'stopped' : 'errored';
      exitResolve!({ exitCode, signal });
      this.notifyStatusChange(taskId);
    });
  }

  getRunStatus(taskId: string): RunStatus {
    const tracked = this.runningProcesses.get(taskId);
    const commands: CommandRunStatus[] = tracked
      ? [...tracked.values()].map((t) => ({
          id: t.commandId,
          name: t.name,
          command: t.command,
          status: t.status,
          pid: t.pid,
        }))
      : [];
    return {
      isRunning: commands.some((c) => c.status === 'running'),
      commands,
    };
  }

  /** Returns taskIds that currently have at least one running command. */
  getTaskIdsWithRunningCommands(): string[] {
    const result: string[] = [];
    for (const [taskId, tracked] of this.runningProcesses) {
      const hasRunning = [...tracked.values()].some(
        (t) => t.status === 'running',
      );
      if (hasRunning) {
        result.push(taskId);
      }
    }
    return result;
  }

  async checkPortInUse(port: number): Promise<string | null> {
    dbg.runCommand('Checking if port %d is in use', port);
    try {
      if (process.platform === 'win32') {
        const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);
        const match = stdout.match(/LISTENING\s+(\d+)/);
        const result = match ? `PID ${match[1]}` : null;
        dbg.runCommand('Port %d: %s', port, result ?? 'available');
        return result;
      } else {
        const { stdout } = await execAsync(`lsof -ti:${port}`);
        const pid = stdout.trim().split('\n')[0];
        if (pid) {
          try {
            const { stdout: psOut } = await execAsync(`ps -p ${pid} -o comm=`);
            const result = `${psOut.trim()} (PID ${pid})`;
            dbg.runCommand('Port %d in use by: %s', port, result);
            return result;
          } catch {
            dbg.runCommand('Port %d in use by PID %s', port, pid);
            return `PID ${pid}`;
          }
        }
        dbg.runCommand('Port %d is available', port);
        return null;
      }
    } catch {
      dbg.runCommand('Port %d check failed (likely available)', port);
      return null;
    }
  }

  async killPort(port: number): Promise<void> {
    dbg.runCommand('Killing processes on port %d', port);
    try {
      if (process.platform === 'win32') {
        const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);
        const match = stdout.match(/LISTENING\s+(\d+)/);
        if (match) {
          const pid = Number(match[1]);
          dbg.runCommand(
            'Killing process tree for PID %d on port %d',
            pid,
            port,
          );
          // Use /T to kill the entire process tree on Windows
          await execAsync(`taskkill /PID ${pid} /T /F`);
        }
      } else {
        const { stdout } = await execAsync(`lsof -ti:${port}`);
        const pids = stdout.trim().split('\n').filter(Boolean).map(Number);
        for (const pid of pids) {
          dbg.runCommand(
            'Killing process tree for PID %d on port %d',
            pid,
            port,
          );
          await killProcessTree(pid, 'SIGKILL');
        }
      }
      dbg.runCommand('Port %d killed successfully', port);
    } catch {
      dbg.runCommand('Port %d may already be free', port);
    }
  }

  async startCommand({
    taskId,
    projectId,
    workingDir,
    runCommandId,
  }: {
    taskId: string;
    projectId: string;
    workingDir: string;
    runCommandId: string;
  }): Promise<RunStatus | PortsInUseErrorData> {
    return this.withCommandLock({
      taskId,
      runCommandId,
      operation: () =>
        this.startCommandWithoutLock({
          taskId,
          projectId,
          workingDir,
          runCommandId,
        }),
    });
  }

  private async startCommandWithoutLock({
    taskId,
    projectId,
    workingDir,
    runCommandId,
  }: {
    taskId: string;
    projectId: string;
    workingDir: string;
    runCommandId: string;
  }): Promise<RunStatus | PortsInUseErrorData> {
    dbg.runCommand(
      'Starting command %s for task %s in %s',
      runCommandId,
      taskId,
      workingDir,
    );
    const command = await ProjectCommandRepository.findById(runCommandId);
    if (!command || command.projectId !== projectId) {
      dbg.runCommand(
        'Command %s not found for project %s',
        runCommandId,
        projectId,
      );
      return this.getRunStatus(taskId);
    }

    const didStop = await this.stopCommandWithoutLock({ taskId, runCommandId });
    if (!didStop) {
      return this.getRunStatus(taskId);
    }

    const commands = [command];
    const portsInUse = await this.getPortsInUse(commands);
    const blockingPortsInUse = this.getBlockingPortsInUse(portsInUse, commands);

    if (blockingPortsInUse.length > 0) {
      dbg.runCommand('Ports in use, cannot start: %o', blockingPortsInUse);
      return {
        type: 'PortsInUseError',
        message: `Ports in use: ${blockingPortsInUse.map((p) => p.port).join(', ')}`,
        portsInUse: blockingPortsInUse,
      };
    }

    const portOverrides = await this.getPortOverrides({
      commands,
      portsInUse,
    });
    const portOverride = portOverrides.get(command.id);

    const context = await this.getRunCommandContext({
      taskId,
      projectId,
      workingDir,
    });
    await this.spawnTrackedCommand({
      taskId,
      workingDir,
      command,
      context,
      envOverrides: portOverride?.envOverrides,
      commandOverride: portOverride?.command,
    });

    this.notifyStatusChange(taskId);
    return this.getRunStatus(taskId);
  }

  async startGroup({
    taskId,
    projectId,
    workingDir,
    runCommandIds,
  }: {
    taskId: string;
    projectId: string;
    workingDir: string;
    runCommandIds: string[];
  }): Promise<RunStatus | PortsInUseErrorData> {
    const commandIds = [...new Set(runCommandIds)];
    const commands = await Promise.all(
      commandIds.map((runCommandId) =>
        ProjectCommandRepository.findById(runCommandId),
      ),
    );
    const validCommands = commands.filter(
      (command): command is ProjectCommand =>
        command != null && command.projectId === projectId,
    );

    const stopResults = await Promise.all(
      validCommands.map((command) =>
        this.stopCommandWithLock({ taskId, runCommandId: command.id }),
      ),
    );
    if (stopResults.some((didStop) => !didStop)) {
      return this.getRunStatus(taskId);
    }

    const portsInUse = await this.getPortsInUse(validCommands);
    const blockingPortsInUse = this.getBlockingPortsInUse(
      portsInUse,
      validCommands,
    );
    if (blockingPortsInUse.length > 0) {
      dbg.runCommand('Group ports in use, cannot start: %o', blockingPortsInUse);
      return {
        type: 'PortsInUseError',
        message: `Ports in use: ${blockingPortsInUse.map((p) => p.port).join(', ')}`,
        portsInUse: blockingPortsInUse,
      };
    }

    const portOverrides = await this.getPortOverrides({
      commands: validCommands,
      portsInUse,
    });

    const context = await this.getRunCommandContext({
      taskId,
      projectId,
      workingDir,
    });

    try {
      await Promise.all(
        validCommands.map((command) =>
          {
            const portOverride = portOverrides.get(command.id);
            return this.spawnTrackedCommand({
              taskId,
              workingDir,
              command,
              context,
              envOverrides: portOverride?.envOverrides,
              commandOverride: portOverride?.command,
            });
          },
        ),
      );
    } finally {
      this.notifyStatusChange(taskId);
    }
    return this.getRunStatus(taskId);
  }

  async stopCommand({
    taskId,
    runCommandId,
  }: {
    taskId: string;
    runCommandId: string;
  }): Promise<void> {
    await this.stopCommandWithLock({ taskId, runCommandId });
  }

  private async stopCommandWithLock({
    taskId,
    runCommandId,
  }: {
    taskId: string;
    runCommandId: string;
  }): Promise<boolean> {
    return this.withCommandLock({
      taskId,
      runCommandId,
      operation: () => this.stopCommandWithoutLock({ taskId, runCommandId }),
    });
  }

  sendInput({
    taskId,
    runCommandId,
    input,
  }: {
    taskId: string;
    runCommandId: string;
    input: string;
  }): void {
    const taskProcesses = this.runningProcesses.get(taskId);
    if (!taskProcesses) return;

    const tracked = taskProcesses.get(runCommandId);
    if (!tracked || tracked.status !== 'running') return;

    tracked.pty.write(input);
  }

  resetLogs({
    taskId,
    runCommandId,
    generation,
  }: {
    taskId: string;
    runCommandId: string;
    generation: number;
  }): number {
    const nextGeneration = Math.max(
      this.getLogGeneration(taskId, runCommandId) + 1,
      generation,
    );
    this.setLogGeneration(taskId, runCommandId, nextGeneration);

    const taskProcesses = this.runningProcesses.get(taskId);
    if (!taskProcesses) return nextGeneration;

    const tracked = taskProcesses.get(runCommandId);
    if (!tracked) return nextGeneration;

    if (tracked.logFlushTimer) {
      clearTimeout(tracked.logFlushTimer);
      tracked.logFlushTimer = null;
    }
    tracked.pendingLogBatches = { stdout: '', stderr: '' };
    tracked.logGeneration = nextGeneration;
    return nextGeneration;
  }

  private static VALID_SIGNALS = new Set(['SIGINT', 'SIGTERM']);

  sendSignal({
    taskId,
    runCommandId,
    signal,
  }: {
    taskId: string;
    runCommandId: string;
    signal: string;
  }): void {
    if (!RunCommandService.VALID_SIGNALS.has(signal)) return;

    const taskProcesses = this.runningProcesses.get(taskId);
    if (!taskProcesses) return;

    const tracked = taskProcesses.get(runCommandId);
    if (!tracked || tracked.status !== 'running') return;

    try {
      signalProcessGroupOrProcess(tracked.pid, signal as ProcessSignal);
    } catch {
      // Process may already be dead
    }
  }

  private async stopCommandWithoutLock({
    taskId,
    runCommandId,
  }: {
    taskId: string;
    runCommandId: string;
  }): Promise<boolean> {
    const taskProcesses = this.runningProcesses.get(taskId);
    if (!taskProcesses) {
      return true;
    }

    const tracked = taskProcesses.get(runCommandId);
    if (!tracked) {
      return true;
    }

    if (tracked.status === 'running') {
      let exited = false;
      const pid = tracked.pid;

      // Collect descendant PIDs before killing, since the tree may become
      // partially orphaned after the signal
      const descendantPids = await getDescendantPids(pid);

      try {
        dbg.runCommand(
          'Sending SIGTERM to PTY process %d (%s)',
          pid,
          tracked.command,
        );
        signalProcessGroupOrProcess(pid, 'SIGTERM');
        exited = await this.waitForExit({ tracked, timeoutMs: 1500 });

        if (!exited) {
          dbg.runCommand(
            'SIGTERM timeout for PTY process %d, sending SIGKILL',
            pid,
          );
          signalProcessGroupOrProcess(pid, 'SIGKILL');
          exited = await this.waitForExit({ tracked, timeoutMs: 1500 });
        }
      } catch {
        dbg.runCommand('PTY process %d may already be dead', pid);
        exited = true;
      }

      // Kill any remaining descendant processes that survived.
      if (descendantPids.length > 0) {
        dbg.runCommand(
          'Killing %d remaining descendant processes of %d',
          descendantPids.length,
          pid,
        );
        for (const descendantPid of descendantPids.reverse()) {
          try {
            process.kill(descendantPid, 'SIGKILL');
          } catch {
            // Process may already be dead
          }
        }

        if (!exited) {
          exited = await this.waitForExit({ tracked, timeoutMs: 1500 });
        }
      }

      if (!exited) {
        dbg.runCommand(
          'Process %d did not exit; keeping tracked as running',
          pid,
        );
        this.notifyStatusChange(taskId);
        return false;
      }
    }

    taskProcesses.delete(runCommandId);
    if (taskProcesses.size === 0) {
      this.runningProcesses.delete(taskId);
    }

    this.notifyStatusChange(taskId);
    return true;
  }

  async killPortsForCommand(
    projectId: string,
    commandId: string,
  ): Promise<void> {
    const command = await ProjectCommandRepository.findById(commandId);
    if (!command || command.projectId !== projectId) return;

    for (const port of command.ports) {
      await this.killPort(port);
    }
  }

  async stopAllCommands(): Promise<void> {
    const taskIds = [...this.runningProcesses.keys()];
    dbg.runCommand('Stopping all commands for %d tasks', taskIds.length);
    for (const taskId of taskIds) {
      await this.stopCommandsForTask(taskId);
    }
    dbg.runCommand('All commands stopped');
  }

  /**
   * Synchronous last-resort cleanup: sends SIGTERM to every tracked process.
   * Registered on `process.on('exit')` so it fires even on unexpected shutdown
   * (SIGINT, SIGTERM, uncaught exception). Cannot help with SIGKILL (kill -9).
   */
  killAllProcessGroupsSync(): void {
    for (const taskProcesses of this.runningProcesses.values()) {
      for (const tracked of taskProcesses.values()) {
        if (tracked.status === 'running') {
          try {
            signalProcessGroupOrProcess(tracked.pid, 'SIGTERM');
          } catch {
            // Process may already be dead
          }
        }
      }
    }
  }

  async stopCommandsForTask(taskId: string): Promise<void> {
    const taskProcesses = this.runningProcesses.get(taskId);
    if (!taskProcesses) {
      return;
    }

    for (const runCommandId of [...taskProcesses.keys()]) {
      await this.stopCommand({ taskId, runCommandId });
    }
  }

  async getPackageScripts(projectPath: string): Promise<PackageScriptsResult> {
    const packageJsonPath = join(projectPath, 'package.json');

    // Read root package.json
    let scripts: string[] = [];
    let rootPkg: {
      scripts?: Record<string, string>;
      workspaces?: string[] | { packages: string[] };
    } = {};
    try {
      const content = await readFile(packageJsonPath, 'utf-8');
      rootPkg = JSON.parse(content);
      scripts = Object.keys(rootPkg.scripts ?? {});
    } catch {
      // Invalid or missing package.json
      return {
        scripts: [],
        packageManager: null,
        isWorkspace: false,
        workspacePackages: [],
      };
    }

    // Detect package manager
    const packageManager = await this.detectPackageManager(projectPath);

    // Prefix root scripts with package manager
    const prefixedScripts = packageManager
      ? scripts.map((s) => `${packageManager} ${s}`)
      : scripts;

    // Detect workspace globs
    const workspaceGlobs = await this.detectWorkspaceGlobs(
      projectPath,
      rootPkg,
    );
    if (!workspaceGlobs || workspaceGlobs.length === 0) {
      return {
        scripts: prefixedScripts,
        packageManager,
        isWorkspace: false,
        workspacePackages: [],
      };
    }

    // Resolve globs to package directories
    const packageDirs = await this.resolveWorkspaceGlobs(
      projectPath,
      workspaceGlobs,
    );

    // Read each sub-package in parallel
    const workspacePackagesResults = await Promise.all(
      packageDirs.map(async (dir) => {
        try {
          const pkgContent = await readFile(join(dir, 'package.json'), 'utf-8');
          const pkg = JSON.parse(pkgContent) as {
            name?: string;
            scripts?: Record<string, string>;
          };
          if (!pkg.name) return null; // Skip packages without a name
          const pkgScripts = Object.keys(pkg.scripts ?? {}).map((s) =>
            this.formatFilterCommand(packageManager, pkg.name!, s),
          );
          return {
            name: pkg.name,
            path: relative(projectPath, dir),
            scripts: pkgScripts,
          };
        } catch {
          return null; // Skip invalid packages
        }
      }),
    );

    const workspacePackages = workspacePackagesResults.filter(
      (p): p is WorkspacePackage => p !== null,
    );

    return {
      scripts: prefixedScripts,
      packageManager,
      isWorkspace: true,
      workspacePackages,
    };
  }

  async getProjectSuggestions(projectPath: string): Promise<ProjectSuggestions> {
    try {
      const content = await readFile(
        join(projectPath, PROJECT_SUGGESTIONS_PATH),
        'utf-8',
      );
      const parsed = JSON.parse(content) as unknown;
      const runCommandsSource =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>).runCommands
          : [];

      return {
        runCommands: dedupeSuggestionCommands(
          Array.isArray(runCommandsSource)
            ? runCommandsSource
                .map(parseSuggestionCommand)
                .filter((command): command is ProjectSuggestionCommand =>
                  Boolean(command),
                )
            : [],
        ),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        dbg.runCommand('Could not read project suggestions: %O', error);
      }
      return { runCommands: [] };
    }
  }

  async saveProjectSuggestions({
    projectPath,
    suggestions,
  }: {
    projectPath: string;
    suggestions: ProjectSuggestions;
  }): Promise<ProjectSuggestions> {
    const filePath = join(projectPath, PROJECT_SUGGESTIONS_PATH);
    const runCommands = dedupeSuggestionCommands(
      suggestions.runCommands
        .map(parseSuggestionCommand)
        .filter((command): command is ProjectSuggestionCommand =>
          Boolean(command),
        ),
    );

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      `${JSON.stringify({ runCommands }, null, 2)}\n`,
      'utf-8',
    );

    return { runCommands };
  }

  private async detectPackageManager(
    projectPath: string,
  ): Promise<PackageScriptsResult['packageManager']> {
    const checks: [string, PackageScriptsResult['packageManager']][] = [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['bun.lockb', 'bun'],
      ['package-lock.json', 'npm'],
    ];

    for (const [file, manager] of checks) {
      try {
        await stat(join(projectPath, file));
        return manager;
      } catch {
        // File doesn't exist
      }
    }

    return null;
  }

  private async detectWorkspaceGlobs(
    projectPath: string,
    rootPkg: { workspaces?: string[] | { packages: string[] } },
  ): Promise<string[] | null> {
    // Check pnpm-workspace.yaml first
    try {
      const pnpmWorkspacePath = join(projectPath, 'pnpm-workspace.yaml');
      const content = await readFile(pnpmWorkspacePath, 'utf-8');
      // Simple YAML parsing for packages field
      const match = content.match(/packages:\s*\n((?:\s+-\s+.+\n?)+)/);
      if (match) {
        const packages = match[1]
          .split('\n')
          .map((line) => line.replace(/^\s*-\s*['"]?|['"]?\s*$/g, ''))
          .filter(Boolean);
        if (packages.length > 0) return packages;
      }
    } catch {
      // No pnpm-workspace.yaml
    }

    // Check package.json workspaces field
    if (rootPkg.workspaces) {
      if (Array.isArray(rootPkg.workspaces)) {
        return rootPkg.workspaces;
      }
      if (rootPkg.workspaces.packages) {
        return rootPkg.workspaces.packages;
      }
    }

    return null;
  }

  private async resolveWorkspaceGlobs(
    projectPath: string,
    globs: string[],
  ): Promise<string[]> {
    const results: string[] = [];

    for (const pattern of globs) {
      const matches = await glob(pattern, {
        cwd: projectPath,
        absolute: true,
      });
      results.push(...matches);
    }

    // Filter to only directories with package.json
    const validDirs: string[] = [];
    await Promise.all(
      results.map(async (dir) => {
        try {
          await stat(join(dir, 'package.json'));
          validDirs.push(dir);
        } catch {
          // No package.json, skip
        }
      }),
    );

    return validDirs;
  }

  private formatFilterCommand(
    packageManager: PackageScriptsResult['packageManager'],
    packageName: string,
    script: string,
  ): string {
    switch (packageManager) {
      case 'pnpm':
        return `pnpm --filter ${packageName} ${script}`;
      case 'npm':
        return `npm -w ${packageName} run ${script}`;
      case 'yarn':
        return `yarn workspace ${packageName} ${script}`;
      case 'bun':
        return `bun --filter ${packageName} ${script}`;
      default:
        return script;
    }
  }
}

export const runCommandService = new RunCommandService();
