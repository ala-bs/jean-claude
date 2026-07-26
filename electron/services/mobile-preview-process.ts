import { type ChildProcessWithoutNullStreams, spawn } from 'child_process';

export type CommandOptions = {
  cwd?: string;
  timeoutMs?: number;
  env?: typeof process.env;
  input?: string;
  signal?: AbortSignal;
};

type ManagedProcessOptions = {
  cwd?: string;
  env?: typeof process.env;
  signal?: AbortSignal;
};

const KILL_GRACE_MS = 1000;
export const MOBILE_PREVIEW_DEEPLINK_OPEN_TIMEOUT_MS = 5_000;

function quoteCommandPart(value: string): string {
  if (/^[A-Za-z0-9_/:=.-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteCommandPart).join(' ');
}

function buildCommandError({
  command,
  args,
  stderr,
  reason,
}: {
  command: string;
  args: string[];
  stderr: string;
  reason: string;
}): Error {
  const stderrSuffix = stderr.trim() ? `\n${stderr.trim()}` : '';
  return new Error(`${reason}: ${formatCommand(command, args)}${stderrSuffix}`);
}

function buildAbortError({
  command,
  args,
  stderr,
  signal,
}: {
  command: string;
  args: string[];
  stderr: string;
  signal: AbortSignal;
}): Error {
  const reason =
    signal.reason instanceof Error
      ? signal.reason.message
      : signal.reason === undefined
        ? ''
        : String(signal.reason);
  const error = buildCommandError({
    command,
    args,
    stderr,
    reason: `Command aborted${reason ? ` (${reason})` : ''}`,
  });
  error.name = 'AbortError';
  return error;
}

export async function commandExists(
  command: string,
  options: Pick<CommandOptions, 'signal' | 'timeoutMs'> = {},
): Promise<boolean> {
  try {
    const executable = process.platform === 'win32' ? 'where' : 'which';
    if (options.signal || options.timeoutMs) {
      await runCommand(executable, [command], options);
    } else {
      await runCommand(executable, [command]);
    }
    return true;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return false;
  }
}

export function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  if (options.signal?.aborted) {
    return Promise.reject(
      buildAbortError({ command, args, stderr: '', signal: options.signal }),
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let closed = false;
    let terminationError: Error | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let killFallback: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (killFallback) clearTimeout(killFallback);
    };

    const terminateChild = () => {
      if (closed) return;
      child.kill('SIGTERM');
      killFallback = setTimeout(() => {
        if (!closed) child.kill('SIGKILL');
      }, KILL_GRACE_MS);
    };

    const handleAbort = () => {
      if (settled || terminationError || !options.signal) return;
      terminationError = buildAbortError({
        command,
        args,
        stderr,
        signal: options.signal,
      });
      if (timeout) clearTimeout(timeout);
      terminateChild();
    };
    options.signal?.addEventListener('abort', handleAbort, { once: true });

    timeout = options.timeoutMs
      ? setTimeout(() => {
          if (settled || terminationError) return;
          terminationError = buildCommandError({
            command,
            args,
            stderr,
            reason: 'Command timed out',
          });
          terminateChild();
        }, options.timeoutMs)
      : null;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    if (options.input !== undefined) {
      child.stdin.write(options.input);
    }
    child.stdin.end();

    child.on('error', (error) => {
      if (settled || terminationError) return;
      settled = true;
      options.signal?.removeEventListener('abort', handleAbort);
      clearTimers();
      reject(
        buildCommandError({
          command,
          args,
          stderr,
          reason: error.message,
        }),
      );
    });

    child.on('close', (code) => {
      closed = true;
      options.signal?.removeEventListener('abort', handleAbort);
      if (killFallback) clearTimeout(killFallback);
      if (settled) return;
      settled = true;
      clearTimers();

      if (terminationError) {
        reject(terminationError);
        return;
      }

      if (code !== 0) {
        reject(
          buildCommandError({
            command,
            args,
            stderr,
            reason: `Command failed with exit code ${code ?? 'unknown'}`,
          }),
        );
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

export function runBinaryCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<{ stdout: Buffer; stderr: string }> {
  if (options.signal?.aborted) {
    return Promise.reject(
      buildAbortError({ command, args, stderr: '', signal: options.signal }),
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
    });
    const stdoutChunks: Buffer[] = [];
    let stderr = '';
    let settled = false;
    let closed = false;
    let terminationError: Error | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let killFallback: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (killFallback) clearTimeout(killFallback);
    };

    const terminateChild = () => {
      if (closed) return;
      child.kill('SIGTERM');
      killFallback = setTimeout(() => {
        if (!closed) child.kill('SIGKILL');
      }, KILL_GRACE_MS);
    };

    const handleAbort = () => {
      if (settled || terminationError || !options.signal) return;
      terminationError = buildAbortError({
        command,
        args,
        stderr,
        signal: options.signal,
      });
      if (timeout) clearTimeout(timeout);
      terminateChild();
    };
    options.signal?.addEventListener('abort', handleAbort, { once: true });

    timeout = options.timeoutMs
      ? setTimeout(() => {
          if (settled || terminationError) return;
          terminationError = buildCommandError({
            command,
            args,
            stderr,
            reason: 'Command timed out',
          });
          terminateChild();
        }, options.timeoutMs)
      : null;

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (settled || terminationError) return;
      settled = true;
      options.signal?.removeEventListener('abort', handleAbort);
      clearTimers();
      reject(
        buildCommandError({
          command,
          args,
          stderr,
          reason: error.message,
        }),
      );
    });

    child.on('close', (code) => {
      closed = true;
      options.signal?.removeEventListener('abort', handleAbort);
      if (killFallback) clearTimeout(killFallback);
      if (settled) return;
      settled = true;
      clearTimers();

      if (terminationError) {
        reject(terminationError);
        return;
      }

      if (code !== 0) {
        reject(
          buildCommandError({
            command,
            args,
            stderr,
            reason: `Command failed with exit code ${code ?? 'unknown'}`,
          }),
        );
        return;
      }

      resolve({ stdout: Buffer.concat(stdoutChunks), stderr });
    });
  });
}

export function spawnManaged(
  command: string,
  args: string[],
  options: ManagedProcessOptions = {},
): { child: ChildProcessWithoutNullStreams; stop: () => Promise<void> } {
  options.signal?.throwIfAborted();
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
  });
  let closed = false;
  let killFallback: ReturnType<typeof setTimeout> | null = null;
  let stopPromise: Promise<void> | null = null;

  child.once('close', () => {
    closed = true;
    if (killFallback) clearTimeout(killFallback);
  });

  const waitForClose = () =>
    new Promise<void>((resolve) => {
      if (closed) {
        resolve();
        return;
      }

      child.once('close', () => resolve());
    });

  const stop = async (): Promise<void> => {
    if (stopPromise) return stopPromise;

    stopPromise = (async () => {
      if (closed) return;
      child.kill('SIGTERM');
      killFallback = setTimeout(() => {
        if (!closed) child.kill('SIGKILL');
      }, KILL_GRACE_MS);
      await waitForClose();
    })();

    return stopPromise;
  };

  const handleAbort = () => {
    void stop().catch(() => undefined);
  };
  options.signal?.addEventListener('abort', handleAbort, { once: true });
  child.once('close', () => {
    options.signal?.removeEventListener('abort', handleAbort);
  });

  return { child, stop };
}
