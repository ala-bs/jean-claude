import {
  access,
  mkdir,
  open,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { type ChildProcess, spawn, type SpawnOptions } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  openSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

import { getChildProcessEnv } from '../lib/child-process-env';

const OUTPUT_LIMIT = 4000;
const RELOAD_PREVIEW_POLL_INTERVAL_MS = 100;
const RELOAD_PREVIEW_LOCK_RECOVERY_INTERVAL_MS = 100;
const RELOAD_PREVIEW_LOCK_RECOVERY_MAX_ATTEMPTS = 21;
const RELOAD_PREVIEW_LOG_CHECK_INTERVAL_MS = 5000;
const RELOAD_PREVIEW_LOG_MAX_BYTES = 1024 * 1024;

type SpawnedProcess = Pick<
  ChildProcess,
  'off' | 'once' | 'pid' | 'unref'
>;

type TaskkillProcess = Pick<ChildProcess, 'kill' | 'off' | 'once'>;

type ReloadPreviewChildFailure =
  | { type: 'error'; error: Error }
  | { type: 'exit'; code: number | null; signal: NodeJS.Signals | null };

type SignalReloadPreviewReadyDependencies = {
  mkdir: typeof mkdir;
  randomId: () => string;
  rename: typeof rename;
  rm: typeof rm;
  writeFile: typeof writeFile;
};

type CreateReloadPreviewReadinessRegistrarDependencies = {
  fileExistsSync: (path: string) => boolean;
  removeFileSync: (path: string) => void;
  signalReady: typeof signalReloadPreviewReady;
};

type ReloadPreviewWebContents = {
  once: (event: 'did-finish-load', listener: () => void) => unknown;
};

type ReloadPreviewLifecycle = {
  once: (event: 'exit', listener: () => void) => unknown;
};

type ReloadPreviewLogLimiterDependencies = {
  clearInterval: (timer: ReturnType<typeof setInterval>) => void;
  getLogSize: (fileDescriptor: number) => number;
  setInterval: (
    callback: () => void,
    intervalMs: number,
  ) => ReturnType<typeof setInterval>;
  truncateLog: (fileDescriptor: number, length: number) => void;
};

type LaunchReloadedPreviewDependencies = {
  acknowledgeReady: (readyFilePath: string, ackFilePath: string) => Promise<void>;
  closeLogFile: (fileDescriptor: number) => void;
  markerExists: (path: string) => Promise<boolean>;
  now: () => number;
  openLogFile: (path: string) => number;
  randomId: () => string;
  readLogTail: (path: string) => Promise<string>;
  removeFile: (path: string) => Promise<void>;
  spawnProcess: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => SpawnedProcess;
  tempDirectory: () => string;
  terminateProcessTree: (pid: number) => Promise<void>;
  wait: (durationMs: number) => Promise<void>;
};

type TerminateReloadPreviewProcessTreeDependencies = {
  clearTerminationTimeout: (timeout: ReturnType<typeof setTimeout>) => void;
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => void;
  setTerminationTimeout: (
    callback: () => void,
    durationMs: number,
  ) => ReturnType<typeof setTimeout>;
  spawnTaskkill: (pid: number) => TaskkillProcess;
  wait: (durationMs: number) => Promise<void>;
};

const signalReloadPreviewReadyDependencies: SignalReloadPreviewReadyDependencies =
  {
    mkdir,
    randomId: randomUUID,
    rename,
    rm,
    writeFile,
  };

const createReloadPreviewReadinessRegistrarDependencies: CreateReloadPreviewReadinessRegistrarDependencies =
  {
    fileExistsSync: existsSync,
    removeFileSync: (path) => rmSync(path, { force: true }),
    signalReady: signalReloadPreviewReady,
  };

const reloadPreviewLogLimiterDependencies: ReloadPreviewLogLimiterDependencies =
  {
    clearInterval,
    getLogSize: (fileDescriptor) => fstatSync(fileDescriptor).size,
    setInterval,
    truncateLog: ftruncateSync,
  };

async function markerExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readLogTail(path: string): Promise<string> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, 'r');
    const { size } = await file.stat();
    const length = Math.min(size, OUTPUT_LIMIT);
    const output = Buffer.alloc(length);
    await file.read(output, 0, length, size - length);
    return output.toString('utf8');
  } catch {
    return '';
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

export async function stopReloadPreviewActivities(params: {
  stopAgents: (options: { reason: 'shutdown' }) => Promise<void>;
  stopCommands: () => Promise<void>;
}): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() =>
      params.stopAgents({ reason: 'shutdown' }),
    ),
    Promise.resolve().then(() => params.stopCommands()),
  ]);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [errorMessage(result.reason)] : [],
  );

  if (failures.length > 0) {
    throw new Error(`Failed to stop preview activity: ${failures.join('; ')}`);
  }
}

export function startReloadPreviewLogLimiter(params: {
  logFilePath?: string;
  lifecycle: ReloadPreviewLifecycle;
  onError: (message: string, error: unknown) => void;
  fileDescriptor?: number;
  intervalMs?: number;
  maxBytes?: number;
  dependencies?: Partial<ReloadPreviewLogLimiterDependencies>;
}): void {
  if (!params.logFilePath) return;

  const dependencies = {
    ...reloadPreviewLogLimiterDependencies,
    ...params.dependencies,
  };
  const fileDescriptor = params.fileDescriptor ?? 1;
  const maxBytes = params.maxBytes ?? RELOAD_PREVIEW_LOG_MAX_BYTES;
  const interval = dependencies.setInterval(() => {
    try {
      if (dependencies.getLogSize(fileDescriptor) <= maxBytes) return;
      dependencies.truncateLog(fileDescriptor, 0);
    } catch (error) {
      params.onError(
        'Failed to limit replacement preview startup log',
        error,
      );
    }
  }, params.intervalMs ?? RELOAD_PREVIEW_LOG_CHECK_INTERVAL_MS);

  params.lifecycle.once('exit', () => {
    dependencies.clearInterval(interval);
  });
}

const terminateReloadPreviewProcessTreeDependencies: TerminateReloadPreviewProcessTreeDependencies =
  {
    clearTerminationTimeout: clearTimeout,
    killProcessGroup: (pid, signal) => process.kill(-pid, signal),
    setTerminationTimeout: setTimeout,
    spawnTaskkill: (pid) =>
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      }),
    wait,
  };

export async function terminateReloadPreviewProcessTree(params: {
  pid: number;
  platform?: NodeJS.Platform;
  taskkillTimeoutMs?: number;
  dependencies?: Partial<TerminateReloadPreviewProcessTreeDependencies>;
}): Promise<void> {
  const dependencies = {
    ...terminateReloadPreviewProcessTreeDependencies,
    ...params.dependencies,
  };
  const platform = params.platform ?? process.platform;

  if (platform === 'win32') {
    const taskkillTimeoutMs = params.taskkillTimeoutMs ?? 5000;
    let taskkill: TaskkillProcess;
    try {
      taskkill = dependencies.spawnTaskkill(params.pid);
    } catch (error) {
      throw new Error(
        `taskkill failed to start for replacement process ${params.pid}: ${errorMessage(
          error,
        )}`,
      );
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        dependencies.clearTerminationTimeout(timeout);
        taskkill.off('error', handleError);
        taskkill.off('close', handleClose);
        if (error) reject(error);
        else resolve();
      };
      const handleError = (error: Error) => {
        finish(
          new Error(
            `taskkill failed to start for replacement process ${params.pid}: ${error.message}`,
          ),
        );
      };
      const handleClose = (
        code: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        if (code === 0) {
          finish();
          return;
        }
        const status = signal
          ? `signal ${signal}`
          : `exit code ${code ?? 'unknown'}`;
        finish(
          new Error(
            `taskkill failed for replacement process ${params.pid} with ${status}`,
          ),
        );
      };
      const timeout = dependencies.setTerminationTimeout(() => {
        let killFailure = '';
        try {
          taskkill.kill('SIGKILL');
        } catch (error) {
          killFailure = `; failed to stop taskkill: ${errorMessage(error)}`;
        }
        finish(
          new Error(
            `taskkill timed out after ${formatDuration(
              taskkillTimeoutMs,
            )} for replacement process ${params.pid}${killFailure}`,
          ),
        );
      }, taskkillTimeoutMs);

      taskkill.once('error', handleError);
      taskkill.once('close', handleClose);
    });
    return;
  }

  const sendSignal = (signal: NodeJS.Signals): boolean => {
    try {
      dependencies.killProcessGroup(params.pid, signal);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ESRCH') return false;
      throw new Error(
        `Failed to terminate replacement process group ${params.pid} with ${signal}: ${errorMessage(
          error,
        )}`,
      );
    }
  };

  if (!sendSignal('SIGTERM')) return;
  await dependencies.wait(250);
  sendSignal('SIGKILL');
}

const launchReloadedPreviewDependencies: LaunchReloadedPreviewDependencies = {
  acknowledgeReady: rename,
  closeLogFile: closeSync,
  markerExists,
  now: Date.now,
  openLogFile: (path) => openSync(path, 'a'),
  randomId: randomUUID,
  readLogTail,
  removeFile,
  spawnProcess: spawn,
  tempDirectory: tmpdir,
  terminateProcessTree: (pid) => terminateReloadPreviewProcessTree({ pid }),
  wait,
};

function appendOutput(current: string, chunk: Buffer): string {
  const next = current + chunk.toString();
  return next.length > OUTPUT_LIMIT ? next.slice(-OUTPUT_LIMIT) : next;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

function buildFailureMessage(params: {
  label: string;
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}): string {
  const output = (params.stderr.trim() || params.stdout.trim()).trim();
  const status = params.signal
    ? `signal ${params.signal}`
    : `exit code ${params.code ?? 'unknown'}`;

  if (!output) return `${params.label} failed with ${status}`;
  return `${params.label} failed with ${status}: ${output}`;
}

function buildReloadPreviewChildFailure(params: {
  failure: ReloadPreviewChildFailure;
  output: string;
}): Error {
  if (params.failure.type === 'error') {
    return new Error(
      `Replacement preview failed to start: ${params.failure.error.message}${
        params.output ? `: ${params.output}` : ''
      }`,
    );
  }

  const status = params.failure.signal
    ? `signal ${params.failure.signal}`
    : `exit code ${params.failure.code ?? 'unknown'}`;
  return new Error(
    `Replacement preview exited with ${status} before becoming ready${
      params.output ? `: ${params.output}` : ''
    }`,
  );
}

function appendFailureContext(primaryError: Error, contexts: Error[]): Error {
  if (contexts.length === 0) return primaryError;
  return new Error(
    `${primaryError.message}. Additional restart cleanup failures: ${contexts
      .map((error) => error.message)
      .join('; ')}`,
    { cause: primaryError },
  );
}

export async function cleanupReloadPreviewFiles(params: {
  ackFilePath?: string;
  readyFilePath?: string;
  logFilePath?: string;
  dependencies?: { removeFile: (path: string) => Promise<void> };
}): Promise<void> {
  const remove = params.dependencies?.removeFile ?? removeFile;
  const paths = [
    params.readyFilePath,
    params.ackFilePath,
    params.logFilePath,
  ].filter(
    (path): path is string => Boolean(path),
  );
  const results = await Promise.allSettled(paths.map((path) => remove(path)));
  const failures = results.flatMap((result, index) =>
    result.status === 'rejected'
      ? [`Failed to remove ${paths[index]}: ${errorMessage(result.reason)}`]
      : [],
  );

  if (failures.length > 0) {
    throw new Error(failures.join('; '));
  }
}

export async function signalReloadPreviewReady(params: {
  readyFilePath?: string;
  dependencies?: Partial<SignalReloadPreviewReadyDependencies>;
}): Promise<void> {
  if (!params.readyFilePath) return;

  const dependencies = {
    ...signalReloadPreviewReadyDependencies,
    ...params.dependencies,
  };
  const temporaryPath = `${params.readyFilePath}.${dependencies.randomId()}.tmp`;

  await dependencies.mkdir(dirname(params.readyFilePath), { recursive: true });
  try {
    await dependencies.writeFile(temporaryPath, 'ready\n', 'utf8');
    await dependencies.rename(temporaryPath, params.readyFilePath);
  } catch (error) {
    await dependencies.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createReloadPreviewReadinessRegistrar(params: {
  ackFilePath?: string;
  readyFilePath?: string;
  logFilePath?: string;
  lifecycle: ReloadPreviewLifecycle;
  onError: (message: string, error: unknown) => void;
  dependencies?: Partial<CreateReloadPreviewReadinessRegistrarDependencies>;
}): (webContents: ReloadPreviewWebContents) => void {
  const dependencies = {
    ...createReloadPreviewReadinessRegistrarDependencies,
    ...params.dependencies,
  };
  let signalComplete = false;
  let signalInProgress = false;
  let retryRequested = false;

  if (params.ackFilePath) {
    const ackFilePath = params.ackFilePath;
    const cleanupPaths = [params.logFilePath, ackFilePath].filter(
      (path): path is string => Boolean(path),
    );
    params.lifecycle.once('exit', () => {
      try {
        if (!dependencies.fileExistsSync(ackFilePath)) return;
      } catch (error) {
        params.onError(
          'Failed to inspect replacement preview acknowledgment',
          error,
        );
        return;
      }

      for (const path of cleanupPaths) {
        try {
          dependencies.removeFileSync(path);
        } catch (error) {
          params.onError('Failed to clean up replacement preview files', error);
        }
      }
    });
  }

  const attemptSignal = () => {
    if (signalComplete) return;
    if (signalInProgress) {
      retryRequested = true;
      return;
    }

    signalInProgress = true;
    void dependencies
      .signalReady({ readyFilePath: params.readyFilePath })
      .then(() => {
        signalComplete = true;
      })
      .catch((error) => {
        params.onError(
          'Failed to signal replacement preview readiness',
          error,
        );
      })
      .finally(() => {
        signalInProgress = false;
        if (!signalComplete && retryRequested) {
          retryRequested = false;
          attemptSignal();
        }
      });
  };

  return (webContents) => {
    if (signalComplete || !params.readyFilePath) return;

    webContents.once('did-finish-load', () => {
      attemptSignal();
    });
  };
}

export async function launchReloadedPreview(params: {
  cwd: string;
  timeoutMs: number;
  pollIntervalMs?: number;
  dependencies?: Partial<LaunchReloadedPreviewDependencies>;
}): Promise<void> {
  const dependencies = {
    ...launchReloadedPreviewDependencies,
    ...params.dependencies,
  };
  const identifier = dependencies.randomId();
  const pathPrefix = join(
    dependencies.tempDirectory(),
    `jean-claude-preview-restart-${identifier}`,
  );
  const readyFilePath = `${pathPrefix}.ready`;
  const ackFilePath = `${pathPrefix}.ack`;
  const logFilePath = `${pathPrefix}.log`;
  const pollIntervalMs =
    params.pollIntervalMs ?? RELOAD_PREVIEW_POLL_INTERVAL_MS;
  const startedAt = dependencies.now();
  let child: SpawnedProcess | undefined;
  let startupFailure: Error | undefined;
  let replacementReady = false;
  const childStatus: { failure?: ReloadPreviewChildFailure } = {};

  const handleError = (error: Error) => {
    childStatus.failure = { type: 'error', error };
  };
  const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
    childStatus.failure = { type: 'exit', code, signal };
  };

  try {
    const logFileDescriptor = dependencies.openLogFile(logFilePath);
    try {
      child = dependencies.spawnProcess('pnpm preview:skip-build', [], {
        cwd: params.cwd,
        detached: true,
        env: getChildProcessEnv({
          overrides: {
            JC_PREVIEW_RESTART_ACK_FILE: ackFilePath,
            JC_PREVIEW_RESTART_LOG_FILE: logFilePath,
            JC_PREVIEW_RESTART_READY_FILE: readyFilePath,
          },
        }),
        shell: true,
        stdio: ['ignore', logFileDescriptor, logFileDescriptor],
      });
    } finally {
      dependencies.closeLogFile(logFileDescriptor);
    }

    child.once('error', handleError);
    child.once('exit', handleExit);
    child.unref();

    while (true) {
      const readyMarkerExists = await dependencies.markerExists(readyFilePath);
      const childFailure = childStatus.failure;
      if (childFailure) {
        const output = (await dependencies.readLogTail(logFilePath))
          .slice(-OUTPUT_LIMIT)
          .trim();
        throw buildReloadPreviewChildFailure({ failure: childFailure, output });
      }

      if (readyMarkerExists) {
        await dependencies.acknowledgeReady(readyFilePath, ackFilePath);
        const childFailureAfterAcknowledgment = childStatus.failure;
        if (childFailureAfterAcknowledgment) {
          const output = (await dependencies.readLogTail(logFilePath))
            .slice(-OUTPUT_LIMIT)
            .trim();
          throw buildReloadPreviewChildFailure({
            failure: childFailureAfterAcknowledgment,
            output,
          });
        }
        replacementReady = true;
        break;
      }

      if (dependencies.now() - startedAt >= params.timeoutMs) {
        const output = (await dependencies.readLogTail(logFilePath))
          .slice(-OUTPUT_LIMIT)
          .trim();
        throw new Error(
          `Replacement preview timed out after ${formatDuration(
            params.timeoutMs,
          )}${output ? `: ${output}` : ''}`,
        );
      }

      await dependencies.wait(pollIntervalMs);
    }
  } catch (error) {
    startupFailure =
      error instanceof Error ? error : new Error(errorMessage(error));
  }

  child?.off('error', handleError);
  child?.off('exit', handleExit);

  if (replacementReady && !startupFailure) {
    return;
  }

  const cleanupFailures: Error[] = [];
  if (child?.pid !== undefined) {
    try {
      await dependencies.terminateProcessTree(child.pid);
    } catch (error) {
      cleanupFailures.push(
        new Error(
          `Failed to terminate replacement process: ${errorMessage(error)}`,
        ),
      );
    }
  }

  try {
    await cleanupReloadPreviewFiles({
      ackFilePath,
      dependencies: { removeFile: dependencies.removeFile },
      logFilePath,
      readyFilePath,
    });
  } catch (error) {
    cleanupFailures.push(
      error instanceof Error ? error : new Error(errorMessage(error)),
    );
  }

  throw appendFailureContext(
    startupFailure ?? new Error('Replacement preview failed before readiness'),
    cleanupFailures,
  );
}

export async function orchestrateReloadedPreview(params: {
  cwd: string;
  timeoutMs: number;
  releaseSingleInstanceLock: () => void;
  reacquireSingleInstanceLock: () => boolean;
  launchPreview?: typeof launchReloadedPreview;
  exitCurrentApp: () => void;
  lockRecoveryIntervalMs?: number;
  lockRecoveryMaxAttempts?: number;
  waitForLockRecovery?: (durationMs: number) => Promise<void>;
}): Promise<void> {
  const launchPreview = params.launchPreview ?? launchReloadedPreview;

  params.releaseSingleInstanceLock();
  try {
    await launchPreview({ cwd: params.cwd, timeoutMs: params.timeoutMs });
  } catch (error) {
    const startupFailure =
      error instanceof Error ? error : new Error(errorMessage(error));
    let recoveryFailure: Error | undefined;
    const intervalMs = Math.max(
      0,
      params.lockRecoveryIntervalMs ??
        RELOAD_PREVIEW_LOCK_RECOVERY_INTERVAL_MS,
    );
    const maxAttempts = Math.max(
      1,
      Math.floor(
        params.lockRecoveryMaxAttempts ??
          RELOAD_PREVIEW_LOCK_RECOVERY_MAX_ATTEMPTS,
      ),
    );
    const waitForLockRecovery = params.waitForLockRecovery ?? wait;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        if (params.reacquireSingleInstanceLock()) {
          recoveryFailure = undefined;
          break;
        }
      } catch (lockError) {
        recoveryFailure = new Error(
          `single-instance lock recovery threw: ${errorMessage(lockError)}`,
        );
        break;
      }

      if (attempt === maxAttempts) {
        recoveryFailure = new Error(
          `single-instance lock recovery timed out after ${formatDuration(
            intervalMs * (maxAttempts - 1),
          )} (${maxAttempts} attempts)`,
        );
        break;
      }

      try {
        await waitForLockRecovery(intervalMs);
      } catch (waitError) {
        recoveryFailure = new Error(
          `single-instance lock recovery wait failed: ${errorMessage(waitError)}`,
        );
        break;
      }
    }

    if (recoveryFailure) {
      throw new Error(
        `${startupFailure.message}. Failed to recover the current app: ${recoveryFailure.message}`,
        { cause: startupFailure },
      );
    }

    throw startupFailure;
  }

  params.exitCurrentApp();
}

export function exitCurrentPreviewAfterReload(params: {
  notifyRestarting: () => void;
  onNotificationError: (error: unknown) => void;
  exitCurrentApp: () => void;
}): void {
  try {
    params.notifyRestarting();
  } catch (error) {
    params.onNotificationError(error);
  } finally {
    params.exitCurrentApp();
  }
}

export async function runReloadPreviewCommand(params: {
  command: string;
  args?: string[];
  cwd: string;
  label: string;
  timeoutMs: number;
  onStdout?: (data: Buffer) => void;
  onStderr?: (data: Buffer) => void;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(params.command, params.args ?? [], {
      cwd: params.cwd,
      env: getChildProcessEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(
        new Error(
          `${params.label} timed out after ${formatDuration(
            params.timeoutMs,
          )}: ${formatCommand(params.command, params.args ?? [])}`,
        ),
      );
    }, params.timeoutMs);

    child.stdout?.on('data', (data: Buffer) => {
      stdout = appendOutput(stdout, data);
      params.onStdout?.(data);
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr = appendOutput(stderr, data);
      params.onStderr?.(data);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`${params.label} failed to start: ${error.message}`));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          buildFailureMessage({
            label: params.label,
            code,
            signal,
            stdout,
            stderr,
          }),
        ),
      );
    });
  });
}
