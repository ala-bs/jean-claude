import { dirname, join, relative } from 'path';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { createServer } from 'net';
import { exec } from 'child_process';
import { promisify } from 'util';



import * as nodePty from 'node-pty';
import { glob } from 'glob';


import {
  type CommandRunStatus,
  getRunCommandDisplayName,
  type PackageScriptsResult,
  parseProjectRootRunId,
  type PortInUse,
  type PortsInUseErrorData,
  type ProjectCommand,
  type ProjectCommandGroupStage,
  type ProjectSuggestionCommand,
  type ProjectSuggestions,
  resolveCommandGroupRunStages,
  RUN_COMMAND_ENV_SOURCES,
  type RunCommandEnvVar,
  type RunCommandGroupAbortEvent,
  type RunCommandLogStream,
  type RunStatus,
  type StartAdHocRunCommandParams,
  type WorkspacePackage,
} from '@shared/run-command-types';
import { MOBILE_DEV_SERVER_COMMAND_PREFIX } from '@shared/mobile-preview-runtime';

import { dbg } from '../lib/debug';
import { getChildProcessEnv } from '../lib/child-process-env';
import { ProjectCommandRepository } from '../database/repositories/project-commands';
import { ProjectRepository } from '../database/repositories/projects';
import { TaskRepository } from '../database/repositories/tasks';


const execAsync = promisify(exec);
// `lsof`/`netstat` can hang indefinitely (stalled network mounts, name
// resolution, huge fd tables). Never let a port probe outlive this budget.
// Caveat: for the piped win32 `netstat | findstr` probe the signal only reaches
// the shell, so a wedged netstat can outlive us as an orphan — the promise
// still rejects, which is what unblocks the caller.
const PORT_PROBE_TIMEOUT_MS = 3000;
const PORT_PROBE_SLOW_WARN_MS = 500;

/**
 * True when a probe was aborted by our own timeout rather than exiting with a
 * non-zero status (which for `lsof` just means "nothing is listening").
 */
function isPortProbeTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { killed?: boolean }).killed === true
  );
}

async function execPortProbe(command: string): Promise<string> {
  const startedAt = Date.now();
  try {
    const { stdout } = await execAsync(command, {
      timeout: PORT_PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return stdout;
  } finally {
    const durationMs = Date.now() - startedAt;
    if (durationMs >= PORT_PROBE_SLOW_WARN_MS) {
      dbg.runCommand('Slow port probe (%dms): %s', durationMs, command);
    }
  }
}

const RUN_COMMAND_LOG_FLUSH_INTERVAL_MS = 50;
const PORT_SCAN_TAIL_LENGTH = 200;
const RUN_COMMAND_LOG_FLUSH_BYTES = 16 * 1024;
const PROJECT_SUGGESTIONS_PATH = '.jean-claude/suggestions.json';
const RUN_COMMAND_ENV_SOURCE_KEYS = new Set(
  RUN_COMMAND_ENV_SOURCES.map((source) => source.key),
);

type ProcessSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';

/**
 * How long a process gets to shut down cleanly after SIGTERM before we escalate
 * to SIGKILL. Dev servers and build tools often need a couple of seconds to
 * flush state and tear down child processes.
 */
const SIGTERM_GRACE_MS = 5000;

/**
 * A port-conflict override rewrites the command with `--port <n>` (or sets an
 * env var). Prefer that port over the declared one so status consumers point at
 * the server that actually came up.
 */
export function resolveEffectivePorts({
  declaredPorts,
  commandOverride,
  envOverrides,
  portEnvVarName,
  allocatedPort,
}: {
  declaredPorts: number[];
  commandOverride?: string;
  envOverrides?: Record<string, string>;
  /** The env var this command uses to receive an overridden port, if any. */
  portEnvVarName?: string | null;
  /**
   * The port the conflict resolver actually allocated. Authoritative: custom
   * `portOverrideArgs` (e.g. `-p {PORT}`) or an inline `{PORT}` placeholder do
   * not produce a `--port <n>` the regex below can recover.
   */
  allocatedPort?: number;
}): number[] {
  if (
    allocatedPort !== undefined &&
    Number.isInteger(allocatedPort) &&
    allocatedPort > 0 &&
    allocatedPort <= 65_535
  ) {
    return [allocatedPort];
  }

  const envValue = portEnvVarName ? envOverrides?.[portEnvVarName] : undefined;
  const fromEnv = envValue === undefined ? null : Number(envValue);
  if (
    fromEnv !== null &&
    Number.isInteger(fromEnv) &&
    fromEnv > 0 &&
    fromEnv <= 65_535
  ) {
    return [fromEnv];
  }

  const match = commandOverride?.match(/--port[= ](\d{1,5})/);
  const fromArgs = match ? Number(match[1]) : null;
  if (fromArgs && fromArgs > 0 && fromArgs <= 65_535) return [fromArgs];

  return declaredPorts;
}

/**
 * Metro/Expo can bind a different port than requested (its own fallback when
 * the port is taken). Learn the real one from the banner it prints.
 */
export function parseDevServerPortFromOutput(chunk: string): number | null {
  // PTY output carries ANSI styling, and dev-client banners percent-encode the
  // embedded URL (`...%3A8081`), so normalize before matching.
  const text = chunk
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/%3A/gi, ':')
    .replace(/%2F/gi, '/');

  const patterns = [
    /Metro waiting on \S*?:(\d{2,5})(?!\d)/i,
    /(?:Dev server ready|Web is waiting on|Waiting on)\s+\S*?:(\d{2,5})(?!\d)/i,
    /exp\+?[\w.-]*:\/\/[^\s/]*?:(\d{2,5})(?!\d)/i,
    /url=https?:\/\/[^\s]*?:(\d{2,5})(?!\d)/i,
    /(?:Metro|Bundler|Dev server).{0,40}?https?:\/\/[^\s:]+:(\d{2,5})(?!\d)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
  }
  return null;
}

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

function getErrnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

export function signalProcessGroupOrProcess(
  pid: number,
  signal: ProcessSignal,
): void {
  if (pid <= 0) return;

  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if (getErrnoCode(error) !== 'ESRCH') throw error;
    }
  }

  process.kill(pid, signal);
}

type StatusChangeCallback = (taskId: string, status: RunStatus) => void;
type GroupAbortCallback = (event: RunCommandGroupAbortEvent) => void;
type LogCallback = (
  taskId: string,
  runCommandId: string,
  stream: RunCommandLogStream,
  text: string,
  generation: number,
) => void;

type StartOptions = {
  afterStop?: () => void | Promise<void>;
};

interface TrackedProcess {
  commandId: string;
  name: string | null;
  command: string;
  ports: number[];
  /** Set once the real listening port has been read from command output. */
  portLearnedFromOutput?: boolean;
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

/**
 * A multi-stage group run holds its members' operation locks for the entire
 * sequence, which can be minutes long. A stop request would therefore queue
 * behind those locks and look frozen. Stop paths raise this signal *before*
 * acquiring any lock; the sequencer races every await against it and bails out,
 * releasing the locks so the queued stop proceeds.
 */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function delay(ms: number): { promise: Promise<true>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

function uniqueBy<T>(items: T[], getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = getKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Resolves the work's value, or `null` if cancellation won the race. */
async function raceCancellation<T>({
  work,
  cancelled$,
}: {
  work: Promise<T>;
  cancelled$: Promise<void>;
}): Promise<T | null> {
  const cancelled = Symbol('cancelled');
  const result = await Promise.race([
    work,
    cancelled$.then(() => cancelled),
  ]);
  return result === cancelled ? null : (result as T);
}

interface GroupRunCancellation {
  taskId: string;
  /** Members whose operation locks this run holds. */
  commandIds: Set<string>;
  cancelled: boolean;
  cancel: () => void;
  cancelled$: Promise<void>;
}

export class RunCommandService {
  private runningProcesses = new Map<string, Map<string, TrackedProcess>>();
  private logGenerations = new Map<string, number>();
  private commandOperationLocks = new Map<string, Promise<void>>();
  private activeGroupRuns = new Set<GroupRunCancellation>();
  private pendingStarts = new Set<Promise<unknown>>();
  private stopAllActive = false;
  private stopAllPromise: Promise<void> | null = null;
  private statusChangeCallbacks: StatusChangeCallback[] = [];
  private logCallbacks: LogCallback[] = [];
  private groupAbortCallbacks: GroupAbortCallback[] = [];

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
    return this.withCommandLocks({
      taskId,
      runCommandIds: [runCommandId],
      operation,
    });
  }

  private async withCommandLocks<T>({
    taskId,
    runCommandIds,
    operation,
  }: {
    taskId: string;
    runCommandIds: string[];
    operation: () => Promise<T>;
  }): Promise<T> {
    const keys = [...new Set(runCommandIds)]
      .map((runCommandId) => this.getCommandKey({ taskId, runCommandId }))
      .sort();
    const locks = keys.map((key) => {
      const previous = this.commandOperationLocks.get(key) ?? Promise.resolve();
      let release = () => {};
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.commandOperationLocks.set(key, current);
      return { key, previous, current, release };
    });

    await Promise.all(locks.map((lock) => lock.previous));
    try {
      return await operation();
    } finally {
      for (const lock of locks) {
        lock.release();
        if (this.commandOperationLocks.get(lock.key) === lock.current) {
          this.commandOperationLocks.delete(lock.key);
        }
      }
    }
  }

  private beginGroupRun({
    taskId,
    runCommandIds,
  }: {
    taskId: string;
    runCommandIds: string[];
  }): GroupRunCancellation {
    let cancel = () => {};
    const cancelled$ = new Promise<void>((resolve) => {
      cancel = resolve;
    });
    const run: GroupRunCancellation = {
      taskId,
      commandIds: new Set(runCommandIds),
      cancelled: false,
      cancelled$,
      cancel: () => {
        run.cancelled = true;
        cancel();
      },
    };
    this.activeGroupRuns.add(run);
    return run;
  }

  /**
   * Interrupts in-flight staged group runs. Called before locks are taken, so
   * it must never await anything.
   *
   * Omit `taskId` to cancel every task (shutdown). Pass `runCommandIds` to only
   * cancel runs that actually hold those commands' locks — an unrelated
   * command starting in the same task must not abort a healthy sequence.
   */
  private cancelGroupRuns({
    taskId,
    runCommandIds,
  }: {
    taskId?: string;
    runCommandIds?: string[];
  } = {}): void {
    for (const run of this.activeGroupRuns) {
      if (taskId !== undefined && run.taskId !== taskId) continue;
      if (
        runCommandIds !== undefined &&
        !runCommandIds.some((id) => run.commandIds.has(id))
      ) {
        continue;
      }
      if (!run.cancelled) {
        dbg.runCommand('Cancelling staged group run for task %s', run.taskId);
      }
      run.cancel();
    }
  }

  private trackStart<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopAllActive) {
      return Promise.reject(
        new Error('Cannot start commands while stopAll is active'),
      );
    }

    const promise = Promise.resolve().then(operation);
    this.pendingStarts.add(promise);
    void promise
      .finally(() => {
        this.pendingStarts.delete(promise);
      })
      .catch(() => {});
    return promise;
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

  onGroupAbort(callback: GroupAbortCallback): () => void {
    this.groupAbortCallbacks.push(callback);
    return () => {
      const index = this.groupAbortCallbacks.indexOf(callback);
      if (index > -1) this.groupAbortCallbacks.splice(index, 1);
    };
  }

  private notifyStatusChange(taskId: string): void {
    const status = this.getRunStatus(taskId);
    this.statusChangeCallbacks.forEach((cb) => cb(taskId, status));
  }

  private notifyGroupAbort(event: RunCommandGroupAbortEvent): void {
    this.groupAbortCallbacks.forEach((cb) => cb(event));
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
    // Probe every port concurrently: a serial scan multiplies any single slow
    // probe by the number of ports and stalls the whole start operation.
    const probes = commands.flatMap((command) =>
      command.ports.map(async (port): Promise<PortInUse | null> => {
        const processInfo = await this.checkPortInUse(port);
        if (!processInfo) return null;
        return {
          port,
          commandId: command.id,
          command: command.command,
          processInfo,
        };
      }),
    );

    const results = await Promise.all(probes);
    return results.filter((result) => result !== null);
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
    Map<
      string,
      {
        envOverrides?: Record<string, string>;
        command?: string;
        port: number;
      }
    >
  > {
    const commandIdsWithConflicts = new Set(
      portsInUse.map((portInfo) => portInfo.commandId),
    );
    const overrides = new Map<
      string,
      { envOverrides?: Record<string, string>; command?: string; port: number }
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
        port,
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
    const isProjectRootRun = parseProjectRootRunId(taskId) !== null;
    const [task, project] = await Promise.all([
      isProjectRootRun ? undefined : TaskRepository.findById(taskId),
      ProjectRepository.findById(projectId),
    ]);

    return {
      // Favorites have no task; don't leak the synthetic run id into templates.
      taskName: isProjectRootRun
        ? 'Project root'
        : task?.name?.trim() || task?.prompt.trim() || taskId,
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
    allocatedPort,
  }: {
    taskId: string;
    workingDir: string;
    command: ProjectCommand;
    context: RunCommandContext;
    envOverrides?: Record<string, string>;
    commandOverride?: string;
    allocatedPort?: number;
  }): Promise<TrackedProcess> {
    const commandValue = commandOverride ?? command.command;
    dbg.runCommand('Spawning command via PTY: %s', commandValue);
    // A port conflict rewrites the command (or env) with a freshly allocated
    // port. Report that port instead of the declared one, otherwise callers
    // (mobile preview: Metro/DevTools/deeplinks) talk to the wrong server.
    const effectivePorts = resolveEffectivePorts({
      declaredPorts: command.ports,
      commandOverride,
      envOverrides,
      portEnvVarName: this.getPortOverrideEnvVar(command),
      allocatedPort,
    });
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

    // Only dev servers advertise their listening port in output; scanning every
    // command would latch onto unrelated localhost URLs.
    const canLearnPort = command.id.startsWith(MOBILE_DEV_SERVER_COMMAND_PREFIX);
    let portScanTail = '';

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
      ports: effectivePorts,
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
      // Dev servers can bind a port of their own choosing; adopt it once so
      // status consumers stop talking to the requested-but-unused port.
      if (canLearnPort && !trackedProcess.portLearnedFromOutput) {
        // Metro's banner can straddle two PTY chunks, so match against a small
        // carry-over window instead of the raw chunk.
        const window = `${portScanTail}${data}`;
        portScanTail = window.slice(-PORT_SCAN_TAIL_LENGTH);
        const observedPort = parseDevServerPortFromOutput(window);
        if (observedPort && trackedProcess.ports?.[0] !== observedPort) {
          trackedProcess.portLearnedFromOutput = true;
          trackedProcess.ports = [observedPort];
          dbg.runCommand(
            'Observed dev server port %d for command %s',
            observedPort,
            trackedProcess.commandId,
          );
          this.notifyStatusChange(taskId);
        } else if (observedPort) {
          trackedProcess.portLearnedFromOutput = true;
        }
      }
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

    return trackedProcess;
  }

  getRunStatus(taskId: string): RunStatus {
    const tracked = this.runningProcesses.get(taskId);
    const commands: CommandRunStatus[] = tracked
      ? [...tracked.values()].map((t) => ({
          id: t.commandId,
          name: t.name,
          command: t.command,
          ports: t.ports,
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
        const stdout = await execPortProbe(`netstat -ano | findstr :${port}`);
        const match = stdout.match(/LISTENING\s+(\d+)/);
        const result = match ? `PID ${match[1]}` : null;
        dbg.runCommand('Port %d: %s', port, result ?? 'available');
        return result;
      } else {
        // -n/-P skip reverse DNS and /etc/services lookups, the most common
        // source of multi-second lsof hangs.
        const stdout = await execPortProbe(`lsof -nP -ti:${port}`);
        const pid = stdout.trim().split('\n')[0];
        if (pid) {
          try {
            const psOut = await execPortProbe(`ps -p ${pid} -o comm=`);
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
    } catch (error) {
      if (isPortProbeTimeout(error)) {
        // We cannot tell whether the port is free, but blocking the start
        // forever is worse: report available and let the command surface its
        // own bind error.
        dbg.runCommand(
          'Port %d check timed out after %dms; treating as available',
          port,
          PORT_PROBE_TIMEOUT_MS,
        );
        return null;
      }
      dbg.runCommand('Port %d check failed (likely available)', port);
      return null;
    }
  }

  async killPort(port: number): Promise<void> {
    dbg.runCommand('Killing processes on port %d', port);
    try {
      if (process.platform === 'win32') {
        const stdout = await execPortProbe(`netstat -ano | findstr :${port}`);
        const match = stdout.match(/LISTENING\s+(\d+)/);
        if (match) {
          const pid = Number(match[1]);
          dbg.runCommand(
            'Killing process tree for PID %d on port %d',
            pid,
            port,
          );
          // Use /T to kill the entire process tree on Windows.
          // Bounded like the probes so a wedged taskkill can't stall a start.
          await execAsync(`taskkill /PID ${pid} /T /F`, {
            timeout: PORT_PROBE_TIMEOUT_MS,
          });
        }
      } else {
        const stdout = await execPortProbe(`lsof -nP -ti:${port}`);
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
    } catch (error) {
      if (isPortProbeTimeout(error)) {
        dbg.runCommand(
          'Port %d kill aborted: lookup timed out after %dms; occupant may still be alive',
          port,
          PORT_PROBE_TIMEOUT_MS,
        );
        return;
      }
      dbg.runCommand('Port %d may already be free', port);
    }
  }

  async startCommand(
    {
      taskId,
      projectId,
      workingDir,
      runCommandId,
    }: {
      taskId: string;
      projectId: string;
      workingDir: string;
      runCommandId: string;
    },
    options: StartOptions = {},
  ): Promise<RunStatus | PortsInUseErrorData> {
    // Deliberately does NOT cancel an in-flight staged group run: an
    // overlapping individual start queues behind the group rather than
    // aborting it. A sequence blocked forever on a `waitForExit` command that
    // never exits is escaped via Stop, which does cancel.
    return this.trackStart(() =>
      this.startCommandAdmitted(
        { taskId, projectId, workingDir, runCommandId },
        options,
      ),
    );
  }

  private async startCommandAdmitted(
    {
      taskId,
      projectId,
      workingDir,
      runCommandId,
    }: {
      taskId: string;
      projectId: string;
      workingDir: string;
      runCommandId: string;
    },
    options: StartOptions = {},
  ): Promise<RunStatus | PortsInUseErrorData> {
    return this.withCommandLock({
      taskId,
      runCommandId,
      operation: () =>
        this.startCommandWithoutLock({
          taskId,
          projectId,
          workingDir,
          runCommandId,
          options,
        }),
    });
  }

  private async startCommandWithoutLock({
    taskId,
    projectId,
    workingDir,
    runCommandId,
    options,
  }: {
    taskId: string;
    projectId: string;
    workingDir: string;
    runCommandId: string;
    options: StartOptions;
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
    // A renderer holding a stale command cache can still ask for a command that
    // has since been hidden, so visibility is enforced here too.
    if (command.isHidden) {
      dbg.runCommand('Command %s is hidden, refusing to start', runCommandId);
      return this.getRunStatus(taskId);
    }

    const didStop = await this.stopCommandWithoutLock({ taskId, runCommandId });
    if (!didStop) {
      return this.getRunStatus(taskId);
    }
    await options.afterStop?.();

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
      allocatedPort: portOverride?.port,
    });

    this.notifyStatusChange(taskId);
    return this.getRunStatus(taskId);
  }

  async startGroup(
    {
      taskId,
      projectId,
      workingDir,
      runCommandIds,
      stages,
    }: {
      taskId: string;
      projectId: string;
      workingDir: string;
      runCommandIds: string[];
      /**
       * Ordered execution plan. Omitted means one implicit stage running every
       * member at once, which is the legacy behavior.
       */
      stages?: ProjectCommandGroupStage[];
    },
    options: StartOptions = {},
  ): Promise<RunStatus | PortsInUseErrorData> {
    const commandIds = [...new Set(runCommandIds)];
    // Re-running a group while an earlier sequence still holds these commands'
    // locks would deadlock, so retire the overlapping run first.
    this.cancelGroupRuns({ taskId, runCommandIds: commandIds });

    // Resolves once the group has STARTED (first stage spawned), not when the
    // whole sequence ends. Callers hold locks of their own while awaiting this
    // (the PR lifecycle lock, the renderer's "starting" state), and a sequence
    // is unbounded in duration.
    return this.trackStart(() =>
      this.startGroupAdmitted(
        { taskId, projectId, workingDir, runCommandIds: commandIds, stages },
        options,
        (sequence) => this.trackPendingSequence(sequence),
      ),
    );
  }

  /**
   * Keeps the remaining stages in `pendingStarts` after the start acknowledgement
   * has resolved, so shutdown still drains them (it cancels them first).
   */
  private trackPendingSequence(sequence: Promise<unknown>): void {
    this.pendingStarts.add(sequence);
    void sequence
      .finally(() => {
        this.pendingStarts.delete(sequence);
      })
      .catch(() => {});
  }

  private async startGroupAdmitted(
    {
      taskId,
      projectId,
      workingDir,
      runCommandIds,
      stages,
    }: {
      taskId: string;
      projectId: string;
      workingDir: string;
      runCommandIds: string[];
      stages?: ProjectCommandGroupStage[];
    },
    options: StartOptions = {},
    onSequence?: (sequence: Promise<unknown>) => void,
  ): Promise<RunStatus | PortsInUseErrorData> {
    // Registered before the locks are acquired: the prologue (stopping members,
    // afterStop hooks, port probes) runs inside the lock and can take seconds,
    // and a stop arriving in that window must not find an empty run set.
    const groupRun = this.beginGroupRun({ taskId, runCommandIds });

    const started = createDeferred<RunStatus | PortsInUseErrorData>();
    let settled = false;
    const settle = (result: RunStatus | PortsInUseErrorData) => {
      if (settled) return;
      settled = true;
      started.resolve(result);
    };

    const sequence = this.withCommandLocks({
        taskId,
        runCommandIds,
        operation: async () => {
          const commands = await Promise.all(
            runCommandIds.map((runCommandId) =>
              ProjectCommandRepository.findById(runCommandId),
            ),
          );
          const invalidIndex = commands.findIndex(
            (command) => !command || command.projectId !== projectId,
          );
          if (invalidIndex !== -1) {
            throw new Error(
              `Command ${runCommandIds[invalidIndex]} not found for project ${projectId}`,
            );
          }
          // Hidden members are dropped rather than rejected so a group stays
          // runnable when only some of its commands are hidden.
          const validCommands = (commands as ProjectCommand[]).filter(
            (command) => !command.isHidden,
          );
          if (validCommands.length === 0) {
            dbg.runCommand(
              'All commands in group are hidden, refusing to start: %o',
              runCommandIds,
            );
            return this.getRunStatus(taskId);
          }
          return this.startGroupWithoutLock({
            taskId,
            projectId,
            workingDir,
            validCommands,
            groupRun,
            onStarted: settle,
            stages: resolveCommandGroupRunStages({
              stages: stages ?? [
                {
                  id: 'implicit',
                  delayMs: 0,
                  entries: validCommands.map((command) => ({
                    commandId: command.id,
                    waitForExit: false,
                  })),
                },
              ],
              commands: validCommands,
            }),
            options,
          });
        },
      })
      .then(
        (final) => {
          // Groups that never reached a stage (all hidden, ports in use) settle
          // with whatever the sequence returned.
          settle(final);
          return final;
        },
        (error: unknown) => {
          if (!settled) {
            settled = true;
            started.reject(error);
          }
          throw error;
        },
      )
      .finally(() => {
        this.activeGroupRuns.delete(groupRun);
      });

    onSequence?.(sequence);
    // The caller only awaits the start acknowledgement; keep the tail from
    // surfacing as an unhandled rejection.
    void sequence.catch(() => {});

    return started.promise;
  }

  private async startGroupWithoutLock({
    taskId,
    projectId,
    workingDir,
    validCommands,
    stages,
    groupRun,
    onStarted,
    options,
  }: {
    taskId: string;
    projectId: string;
    workingDir: string;
    validCommands: ProjectCommand[];
    stages: ProjectCommandGroupStage[];
    groupRun: GroupRunCancellation;
    onStarted: (result: RunStatus | PortsInUseErrorData) => void;
    options: StartOptions;
  }): Promise<RunStatus | PortsInUseErrorData> {
    const stopResults = await Promise.all(
      validCommands.map((command) =>
        this.stopCommandWithoutLock({ taskId, runCommandId: command.id }),
      ),
    );
    if (stopResults.some((didStop) => !didStop)) {
      const status = this.getRunStatus(taskId);
      onStarted(status);
      return status;
    }
    await options.afterStop?.();

    const portsInUse = await this.getPortsInUse(validCommands);
    const blockingPortsInUse = this.getBlockingPortsInUse(
      portsInUse,
      validCommands,
    );
    if (blockingPortsInUse.length > 0) {
      dbg.runCommand('Group ports in use, cannot start: %o', blockingPortsInUse);
      const portsError: PortsInUseErrorData = {
        type: 'PortsInUseError',
        message: `Ports in use: ${blockingPortsInUse.map((p) => p.port).join(', ')}`,
        portsInUse: blockingPortsInUse,
      };
      onStarted(portsError);
      return portsError;
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

    const commandsById = new Map(
      validCommands.map((command) => [command.id, command]),
    );

    if (groupRun.cancelled) {
      dbg.runCommand('Group run cancelled during startup, not spawning');
      const status = this.getRunStatus(taskId);
      onStarted(status);
      return status;
    }

    try {
      for (const [stageIndex, stage] of stages.entries()) {
        if (groupRun.cancelled) {
          dbg.runCommand(
            'Group run cancelled before stage %d/%d',
            stageIndex + 1,
            stages.length,
          );
          break;
        }

        // Only the first occurrence of a command id in a stage can run: the
        // service tracks one process per command id.
        const entries = uniqueBy(stage.entries, (entry) => entry.commandId);

        const spawned = await Promise.all(
          entries.map(async (entry) => {
            const command = commandsById.get(entry.commandId);
            if (!command) return null;

            // A command repeated in a later stage restarts: tear down the
            // instance a previous stage left behind before respawning.
            if (
              this.getTaskProcesses(taskId).get(command.id)?.status ===
              'running'
            ) {
              const didStop = await this.stopCommandWithoutLock({
                taskId,
                runCommandId: command.id,
              });
              // Spawning over a process that refused to die would overwrite its
              // tracking entry and leave it running, unkillable and still
              // holding its ports.
              if (!didStop) {
                dbg.runCommand(
                  'Could not restart %s for a later stage; it is still running',
                  command.id,
                );
                return { entry, tracked: null };
              }
            }

            const portOverride = portOverrides.get(command.id);
            const tracked = await this.spawnTrackedCommand({
              taskId,
              workingDir,
              command,
              context,
              envOverrides: portOverride?.envOverrides,
              commandOverride: portOverride?.command,
              allocatedPort: portOverride?.port,
            });
            return { entry, tracked };
          }),
        );

        // A member that could not be restarted aborts the sequence: later
        // stages would otherwise race a process we failed to control.
        const unrestartable = spawned.find(
          (item) => item !== null && item.tracked === null,
        );
        if (unrestartable) {
          this.notifyGroupAbort({
            taskId,
            skippedStageCount: stages.length - stageIndex - 1,
            reason: {
              type: 'restartFailed',
              commandName: getRunCommandDisplayName(
                commandsById.get(unrestartable.entry.commandId) ?? {
                  command: unrestartable.entry.commandId,
                },
              ),
            },
          });
          break;
        }

        // Surface the stage's processes before blocking on them.
        this.notifyStatusChange(taskId);
        // The group is now "started"; later stages continue in the background.
        onStarted(this.getRunStatus(taskId));

        const blocking = spawned.filter(
          (item): item is { entry: (typeof stage.entries)[number]; tracked: TrackedProcess } =>
            item !== null && item.tracked !== null && item.entry.waitForExit,
        );
        if (blocking.length > 0) {
          dbg.runCommand(
            'Stage %d/%d waiting on %d command(s) to exit',
            stageIndex + 1,
            stages.length,
            blocking.length,
          );
          const exits = await raceCancellation({
            work: Promise.all(blocking.map((item) => item.tracked.exitPromise)),
            cancelled$: groupRun.cancelled$,
          });
          if (!exits) break;

          const failedIndex = exits.findIndex((exit) => exit.exitCode !== 0);
          if (failedIndex !== -1) {
            // Abort the rest of the sequence but leave already-started
            // commands running, so a failed check does not kill a dev server.
            const failed = blocking[failedIndex];
            dbg.runCommand(
              'Group run aborted: %s exited with code %d',
              failed.tracked.commandId,
              exits[failedIndex].exitCode,
            );
            this.notifyGroupAbort({
              taskId,
              skippedStageCount: stages.length - stageIndex - 1,
              reason: {
                type: 'commandFailed',
                commandName: getRunCommandDisplayName({
                  name: failed.tracked.name,
                  command: failed.tracked.command,
                }),
                exitCode: exits[failedIndex].exitCode,
              },
            });
            break;
          }
        }

        const isLastStage = stageIndex === stages.length - 1;
        if (stage.delayMs > 0 && !isLastStage) {
          const pause = delay(stage.delayMs);
          const waited = await raceCancellation({
            work: pause.promise,
            cancelled$: groupRun.cancelled$,
          });
          // Losing the race leaves the timer pending for up to 10 minutes,
          // which would keep a handle alive across app quit.
          pause.cancel();
          if (!waited) break;
        }
      }
    } finally {
      // Deregistration is owned by startGroupAdmitted, which still holds the
      // locks at this point; removing it here would make the run
      // uncancellable during that window.
      this.notifyStatusChange(taskId);
    }
    return this.getRunStatus(taskId);
  }

  async startAdHocCommand({
    taskId,
    projectId,
    workingDir,
    runCommandId,
    name,
    command,
    ports,
    availablePort,
    envVars = [],
  }: StartAdHocRunCommandParams): Promise<RunStatus | PortsInUseErrorData> {
    const adHocCommand: ProjectCommand = {
      id: runCommandId,
      projectId,
      name,
      command,
      ports,
      portConflictStrategy: availablePort ? 'use-available-port' : 'prompt',
      portOverrideProvider: availablePort?.provider ?? 'env',
      portOverrideEnvVar:
        availablePort?.provider === 'env' ? (availablePort.envVar ?? null) : null,
      portOverrideArgs:
        availablePort?.provider === 'args' ? (availablePort.args ?? null) : null,
      envVars,
      confirmBeforeRun: false,
      confirmMessage: null,
      isFavorite: false,
      isHidden: false,
      sortOrder: 0,
      createdAt: new Date().toISOString(),
    };

    return this.trackStart(() =>
      this.withCommandLock({
        taskId,
        runCommandId,
        operation: async () => {
          const didStop = await this.stopCommandWithoutLock({
            taskId,
            runCommandId,
          });
          if (!didStop) return this.getRunStatus(taskId);

          const portsInUse = await this.getPortsInUse([adHocCommand]);
          const blockingPortsInUse = this.getBlockingPortsInUse(portsInUse, [
            adHocCommand,
          ]);
          if (blockingPortsInUse.length > 0) {
            return {
              type: 'PortsInUseError',
              message: `Ports in use: ${blockingPortsInUse.map((p) => p.port).join(', ')}`,
              portsInUse: blockingPortsInUse,
            };
          }

          const portOverrides = await this.getPortOverrides({
            commands: [adHocCommand],
            portsInUse,
          });
          const portOverride = portOverrides.get(adHocCommand.id);
          const context = await this.getRunCommandContext({
            taskId,
            projectId,
            workingDir,
          });

          await this.spawnTrackedCommand({
            taskId,
            workingDir,
            command: adHocCommand,
            context,
            envOverrides: portOverride?.envOverrides,
            commandOverride: portOverride?.command,
            allocatedPort: portOverride?.port,
          });

          this.notifyStatusChange(taskId);
          return this.getRunStatus(taskId);
        },
      }),
    );
  }

  async stopCommand({
    taskId,
    runCommandId,
  }: {
    taskId: string;
    runCommandId: string;
  }): Promise<boolean> {
    // Raise the cancel flag before queueing on the lock, otherwise a staged
    // group run would hold it for the rest of its sequence.
    this.cancelGroupRuns({ taskId, runCommandIds: [runCommandId] });
    return this.stopCommandWithLock({ taskId, runCommandId });
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
    } catch (error) {
      if (getErrnoCode(error) !== 'ESRCH') throw error;
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
        exited = await this.waitForExit({
          tracked,
          timeoutMs: SIGTERM_GRACE_MS,
        });

        if (!exited) {
          dbg.runCommand(
            'SIGTERM timeout for PTY process %d, sending SIGKILL',
            pid,
          );
          signalProcessGroupOrProcess(pid, 'SIGKILL');
          exited = await this.waitForExit({ tracked, timeoutMs: 1500 });
        }
      } catch (error) {
        if (getErrnoCode(error) !== 'ESRCH') throw error;
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
          } catch (error) {
            if (getErrnoCode(error) !== 'ESRCH') throw error;
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

  stopAllCommands(): Promise<void> {
    if (this.stopAllPromise) return this.stopAllPromise;

    this.stopAllActive = true;
    // performStopAllCommands awaits pendingStarts; without this a staged group
    // run would delay app shutdown for the length of its sequence.
    this.cancelGroupRuns();
    const operation = this.performStopAllCommands();
    const sharedOperation = operation.finally(() => {
      if (this.stopAllPromise === sharedOperation) {
        this.stopAllPromise = null;
        this.stopAllActive = false;
      }
    });
    this.stopAllPromise = sharedOperation;
    return sharedOperation;
  }

  private async performStopAllCommands(): Promise<void> {
    await Promise.allSettled([...this.pendingStarts]);
    const commands = [...this.runningProcesses].flatMap(
      ([taskId, taskProcesses]) =>
        [...taskProcesses.keys()].map((runCommandId) => ({
          taskId,
          runCommandId,
        })),
    );
    dbg.runCommand('Stopping all running commands (%d)', commands.length);
    const results = await Promise.allSettled(
      commands.map((params) => this.stopCommand(params)),
    );
    const failureCount = results.filter(
      (result) => result.status === 'rejected',
    ).length;
    let runningCount = 0;
    for (const taskProcesses of this.runningProcesses.values()) {
      for (const tracked of taskProcesses.values()) {
        if (tracked.status === 'running') runningCount++;
      }
    }

    if (failureCount > 0 || runningCount > 0) {
      dbg.runCommand(
        'Failed to stop all commands: %d stop failures, %d commands still running',
        failureCount,
        runningCount,
      );
      throw new Error(
        `Failed to stop all commands: ${failureCount} stop request(s) failed; ${runningCount} command(s) still running`,
      );
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

  async stopCommandsForTask(taskId: string): Promise<boolean> {
    this.cancelGroupRuns({ taskId });
    const taskProcesses = this.runningProcesses.get(taskId);
    if (!taskProcesses) {
      return true;
    }

    let stopped = true;
    for (const runCommandId of [...taskProcesses.keys()]) {
      if (!(await this.stopCommandWithLock({ taskId, runCommandId }))) {
        stopped = false;
      }
    }
    return stopped;
  }

  resetTaskAfterReactivation(taskId: string): void {
    const taskProcesses = this.runningProcesses.get(taskId);
    if (!taskProcesses) return;

    // Only drop already-terminated entries. Dropping live processes would
    // orphan them (ports held, never stoppable, missed on shutdown cleanup)
    // — reachable because reactivation can happen without a prior stop.
    let removed = false;
    for (const [runCommandId, tracked] of [...taskProcesses]) {
      if (tracked.status === 'running' && !tracked.exited) continue;
      taskProcesses.delete(runCommandId);
      removed = true;
    }
    if (taskProcesses.size === 0) this.runningProcesses.delete(taskId);
    if (removed) this.notifyStatusChange(taskId);
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
