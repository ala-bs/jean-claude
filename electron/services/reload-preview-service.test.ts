import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupReloadPreviewFiles,
  createReloadPreviewReadinessRegistrar,
  exitCurrentPreviewAfterReload,
  launchReloadedPreview,
  orchestrateReloadedPreview,
  runReloadPreviewCommand,
  signalReloadPreviewReady,
  startReloadPreviewLogLimiter,
  stopReloadPreviewActivities,
  terminateReloadPreviewProcessTree,
} from './reload-preview-service';

describe('stopReloadPreviewActivities', () => {
  it('stops active agents for shutdown and running commands', async () => {
    const stopAgents = vi.fn().mockResolvedValue(undefined);
    const stopCommands = vi.fn().mockResolvedValue(undefined);

    await stopReloadPreviewActivities({ stopAgents, stopCommands });

    expect(stopAgents).toHaveBeenCalledWith({ reason: 'shutdown' });
    expect(stopCommands).toHaveBeenCalledOnce();
  });

  it('attempts both shutdowns and reports every failure', async () => {
    const stopAgents = vi.fn(() => {
      throw new Error('agent stop failed');
    });
    const stopCommands = vi
      .fn()
      .mockRejectedValue(new Error('command stop failed'));

    await expect(
      stopReloadPreviewActivities({ stopAgents, stopCommands }),
    ).rejects.toThrow('agent stop failed; command stop failed');

    expect(stopAgents).toHaveBeenCalledOnce();
    expect(stopCommands).toHaveBeenCalledOnce();
  });
});

describe('startReloadPreviewLogLimiter', () => {
  function createLimiterHarness(size: number) {
    let intervalCallback: (() => void) | undefined;
    const intervalHandle: ReturnType<typeof globalThis.setInterval> = {
      id: 1,
    } as unknown as ReturnType<typeof globalThis.setInterval>;
    const clearInterval = vi.fn();
    const getLogSize = vi.fn(() => size);
    const lifecycle = new EventEmitter();
    const onError = vi.fn();
    const setInterval = vi.fn(
      (callback: () => void): ReturnType<typeof globalThis.setInterval> => {
        intervalCallback = callback;
        return intervalHandle;
      },
    );
    const truncateLog = vi.fn();

    startReloadPreviewLogLimiter({
      lifecycle,
      logFilePath: join('temp', 'restart.log'),
      dependencies: {
        clearInterval,
        getLogSize,
        setInterval,
        truncateLog,
      },
      onError,
    });

    return {
      clearInterval,
      getLogSize,
      intervalCallback: () => intervalCallback?.(),
      intervalHandle,
      lifecycle,
      onError,
      setInterval,
      truncateLog,
    };
  }

  it('does not start without a replacement log path', () => {
    const setInterval = vi.fn();

    startReloadPreviewLogLimiter({
      lifecycle: new EventEmitter(),
      dependencies: { setInterval },
      onError: vi.fn(),
    });

    expect(setInterval).not.toHaveBeenCalled();
  });

  it('leaves logs below the cap untouched', () => {
    const harness = createLimiterHarness(1024 * 1024);

    harness.intervalCallback();

    expect(harness.getLogSize).toHaveBeenCalledWith(1);
    expect(harness.truncateLog).not.toHaveBeenCalled();
  });

  it('truncates the inherited stdout descriptor above the cap', () => {
    const harness = createLimiterHarness(1024 * 1024 + 1);

    harness.intervalCallback();

    expect(harness.truncateLog).toHaveBeenCalledWith(1, 0);
    expect(harness.setInterval).toHaveBeenCalledWith(
      expect.any(Function),
      5000,
    );
  });

  it('reports limiter failures without throwing from the timer', () => {
    const harness = createLimiterHarness(1024 * 1024 + 1);
    const truncateError = new Error('truncate failed');
    harness.truncateLog.mockImplementation(() => {
      throw truncateError;
    });

    expect(() => harness.intervalCallback()).not.toThrow();
    expect(harness.onError).toHaveBeenCalledWith(
      'Failed to limit replacement preview startup log',
      truncateError,
    );
  });

  it('clears the limiter timer on process exit', () => {
    const harness = createLimiterHarness(0);

    harness.lifecycle.emit('exit');

    expect(harness.clearInterval).toHaveBeenCalledWith(harness.intervalHandle);
  });
});

describe('orchestrateReloadedPreview', () => {
  function createDeferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, reject, resolve };
  }

  it('does not exit before the replacement is ready', async () => {
    const readiness = createDeferred();
    const exitCurrentApp = vi.fn();
    const handoff = orchestrateReloadedPreview({
      cwd: join('project', 'root'),
      exitCurrentApp,
      launchPreview: vi.fn().mockReturnValue(readiness.promise),
      reacquireSingleInstanceLock: vi.fn(() => true),
      releaseSingleInstanceLock: vi.fn(),
      timeoutMs: 30_000,
    });

    await Promise.resolve();

    expect(exitCurrentApp).not.toHaveBeenCalled();
    readiness.resolve();
    await handoff;
  });

  it('releases the lock, waits for readiness, then exits', async () => {
    const callOrder: string[] = [];

    await orchestrateReloadedPreview({
      cwd: join('project', 'root'),
      exitCurrentApp: () => callOrder.push('exit'),
      launchPreview: async () => {
        callOrder.push('launch-ready');
      },
      reacquireSingleInstanceLock: vi.fn(() => true),
      releaseSingleInstanceLock: () => callOrder.push('release'),
      timeoutMs: 30_000,
    });

    expect(callOrder).toEqual(['release', 'launch-ready', 'exit']);
  });

  it('reacquires the lock and leaves the current app running on failure', async () => {
    const startupFailure = new Error('replacement failed to start');
    const exitCurrentApp = vi.fn();
    const reacquireSingleInstanceLock = vi.fn(() => true);

    await expect(
      orchestrateReloadedPreview({
        cwd: join('project', 'root'),
        exitCurrentApp,
        launchPreview: vi.fn().mockRejectedValue(startupFailure),
        reacquireSingleInstanceLock,
        releaseSingleInstanceLock: vi.fn(),
        timeoutMs: 30_000,
      }),
    ).rejects.toBe(startupFailure);

    expect(reacquireSingleInstanceLock).toHaveBeenCalledOnce();
    expect(exitCurrentApp).not.toHaveBeenCalled();
  });

  it('retries lock recovery until the current app reacquires it', async () => {
    const startupFailure = new Error('replacement failed to start');
    const exitCurrentApp = vi.fn();
    const reacquireSingleInstanceLock = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const waitForLockRecovery = vi.fn().mockResolvedValue(undefined);

    await expect(
      orchestrateReloadedPreview({
        cwd: join('project', 'root'),
        exitCurrentApp,
        launchPreview: vi.fn().mockRejectedValue(startupFailure),
        lockRecoveryMaxAttempts: 3,
        reacquireSingleInstanceLock,
        releaseSingleInstanceLock: vi.fn(),
        timeoutMs: 30_000,
        waitForLockRecovery,
      }),
    ).rejects.toBe(startupFailure);

    expect(reacquireSingleInstanceLock).toHaveBeenCalledTimes(2);
    expect(waitForLockRecovery).toHaveBeenCalledOnce();
    expect(waitForLockRecovery).toHaveBeenCalledWith(100);
    expect(exitCurrentApp).not.toHaveBeenCalled();
  });

  it('preserves startup failure when lock recovery retries are exhausted', async () => {
    const startupFailure = new Error('replacement startup failed');
    const exitCurrentApp = vi.fn();
    const reacquireSingleInstanceLock = vi.fn(() => false);
    const waitForLockRecovery = vi.fn().mockResolvedValue(undefined);

    await expect(
      orchestrateReloadedPreview({
        cwd: join('project', 'root'),
        exitCurrentApp,
        launchPreview: vi.fn().mockRejectedValue(startupFailure),
        lockRecoveryMaxAttempts: 3,
        reacquireSingleInstanceLock,
        releaseSingleInstanceLock: vi.fn(),
        timeoutMs: 30_000,
        waitForLockRecovery,
      }),
    ).rejects.toSatisfy((error: Error) => {
      expect(error.message).toContain('replacement startup failed');
      expect(error.message).toContain(
        'single-instance lock recovery timed out after 200ms (3 attempts)',
      );
      expect(error.cause).toBe(startupFailure);
      return true;
    });

    expect(reacquireSingleInstanceLock).toHaveBeenCalledTimes(3);
    expect(waitForLockRecovery).toHaveBeenCalledTimes(2);
    expect(exitCurrentApp).not.toHaveBeenCalled();
  });

  it('preserves the startup failure when lock recovery throws', async () => {
    const startupFailure = new Error('replacement startup failed');

    await expect(
      orchestrateReloadedPreview({
        cwd: join('project', 'root'),
        exitCurrentApp: vi.fn(),
        launchPreview: vi.fn().mockRejectedValue(startupFailure),
        reacquireSingleInstanceLock: () => {
          throw new Error('lock API failed');
        },
        releaseSingleInstanceLock: vi.fn(),
        timeoutMs: 30_000,
      }),
    ).rejects.toSatisfy((error: Error) => {
      expect(error.message).toContain('replacement startup failed');
      expect(error.message).toContain('lock API failed');
      expect(error.cause).toBe(startupFailure);
      return true;
    });
  });
});

describe('exitCurrentPreviewAfterReload', () => {
  it('exits even when the restarting notification fails', () => {
    const notificationError = new Error('renderer disappeared');
    const exitCurrentApp = vi.fn();
    const onNotificationError = vi.fn();

    exitCurrentPreviewAfterReload({
      exitCurrentApp,
      notifyRestarting: () => {
        throw notificationError;
      },
      onNotificationError,
    });

    expect(onNotificationError).toHaveBeenCalledWith(notificationError);
    expect(exitCurrentApp).toHaveBeenCalledOnce();
  });

  it('notifies before exiting when notification succeeds', () => {
    const callOrder: string[] = [];

    exitCurrentPreviewAfterReload({
      exitCurrentApp: () => callOrder.push('exit'),
      notifyRestarting: () => callOrder.push('notify'),
      onNotificationError: vi.fn(),
    });

    expect(callOrder).toEqual(['notify', 'exit']);
  });
});

describe('runReloadPreviewCommand', () => {
  const originalElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  const originalCi = process.env.CI;

  afterEach(() => {
    if (originalElectronRunAsNode === undefined) {
      delete process.env.ELECTRON_RUN_AS_NODE;
    } else {
      process.env.ELECTRON_RUN_AS_NODE = originalElectronRunAsNode;
    }
    if (originalCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCi;
    }
  });

  it('removes Electron environment variables from commands', async () => {
    process.env.ELECTRON_RUN_AS_NODE = '1';

    await expect(
      runReloadPreviewCommand({
        command: process.execPath,
        args: [
          '-e',
          "process.exit(process.env.ELECTRON_RUN_AS_NODE === undefined ? 0 : 1)",
        ],
        cwd: process.cwd(),
        label: 'Environment check',
        timeoutMs: 1000,
      }),
    ).resolves.toBeUndefined();
  });

  it('passes CI mode to non-interactive package-manager commands', async () => {
    await expect(
      runReloadPreviewCommand({
        command: process.execPath,
        args: [
          '-e',
          "process.exit(process.env.CI === 'true' ? 0 : 1)",
        ],
        cwd: process.cwd(),
        envOverrides: { CI: 'true' },
        label: 'pnpm install',
        timeoutMs: 1000,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects with stderr when the command exits non-zero', async () => {
    await expect(
      runReloadPreviewCommand({
        command: process.execPath,
        args: [
          '-e',
          "process.stderr.write('network unavailable'); process.exit(1)",
        ],
        cwd: process.cwd(),
        label: 'Git pull',
        timeoutMs: 1000,
      }),
    ).rejects.toThrow('Git pull failed with exit code 1: network unavailable');
  });

  it('rejects when the command times out', async () => {
    await expect(
      runReloadPreviewCommand({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 1000)'],
        cwd: process.cwd(),
        label: 'Git pull',
        timeoutMs: 25,
      }),
    ).rejects.toThrow(`Git pull timed out after 25ms: ${process.execPath} -e`);
  });
});

describe('signalReloadPreviewReady', () => {
  it('does nothing when the ready path is missing', async () => {
    const mkdir = vi.fn();
    const writeFile = vi.fn();
    const rename = vi.fn();

    await signalReloadPreviewReady({
      dependencies: { mkdir, rename, writeFile },
    });

    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it('creates the parent and atomically renames a temporary marker', async () => {
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const rename = vi.fn().mockResolvedValue(undefined);
    const parentPath = join('temp', 'reload');
    const readyFilePath = join(parentPath, 'ready');
    const temporaryPath = `${readyFilePath}.marker-id.tmp`;

    await signalReloadPreviewReady({
      readyFilePath,
      dependencies: {
        mkdir,
        randomId: () => 'marker-id',
        rename,
        writeFile,
      },
    });

    expect(mkdir).toHaveBeenCalledWith(parentPath, { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(temporaryPath, 'ready\n', 'utf8');
    expect(rename).toHaveBeenCalledWith(temporaryPath, readyFilePath);
    expect(writeFile.mock.invocationCallOrder[0]).toBeLessThan(
      rename.mock.invocationCallOrder[0],
    );
  });

  it('removes the temporary marker when readiness signaling fails', async () => {
    const parentPath = join('temp', 'reload');
    const readyFilePath = join(parentPath, 'ready');
    const temporaryPath = `${readyFilePath}.marker-id.tmp`;
    const rm = vi.fn().mockResolvedValue(undefined);

    await expect(
      signalReloadPreviewReady({
        readyFilePath,
        dependencies: {
          mkdir: vi.fn().mockResolvedValue(undefined),
          randomId: () => 'marker-id',
          rename: vi.fn().mockRejectedValue(new Error('rename failed')),
          rm,
          writeFile: vi.fn().mockResolvedValue(undefined),
        },
      }),
    ).rejects.toThrow('rename failed');

    expect(rm).toHaveBeenCalledWith(temporaryPath, { force: true });
  });
});

describe('createReloadPreviewReadinessRegistrar', () => {
  it('signals only after the renderer finishes loading', async () => {
    const webContents = new EventEmitter();
    const lifecycle = new EventEmitter();
    const signalReady = vi.fn().mockResolvedValue(undefined);

    const registerReadiness = createReloadPreviewReadinessRegistrar({
      lifecycle,
      logFilePath: join('temp', 'restart.log'),
      readyFilePath: join('temp', 'restart.ready'),
      dependencies: {
        removeFileSync: vi.fn(),
        signalReady,
      },
      onError: vi.fn(),
    });
    registerReadiness(webContents);

    expect(signalReady).not.toHaveBeenCalled();

    webContents.emit('did-finish-load');
    await vi.waitFor(() =>
      expect(signalReady).toHaveBeenCalledWith({
        readyFilePath: join('temp', 'restart.ready'),
      }),
    );
  });

  it('signals readiness only once', async () => {
    const webContents = new EventEmitter();
    const signalReady = vi.fn().mockResolvedValue(undefined);

    const registerReadiness = createReloadPreviewReadinessRegistrar({
      lifecycle: new EventEmitter(),
      readyFilePath: join('temp', 'restart.ready'),
      dependencies: {
        removeFileSync: vi.fn(),
        signalReady,
      },
      onError: vi.fn(),
    });
    registerReadiness(webContents);

    webContents.emit('did-finish-load');
    webContents.emit('did-finish-load');
    await vi.waitFor(() => expect(signalReady).toHaveBeenCalledOnce());
  });

  it('does not register readiness when the ready path is absent', () => {
    const webContents = new EventEmitter();
    const lifecycle = new EventEmitter();
    const signalReady = vi.fn();

    const registerReadiness = createReloadPreviewReadinessRegistrar({
      lifecycle,
      dependencies: {
        removeFileSync: vi.fn(),
        signalReady,
      },
      onError: vi.fn(),
    });
    registerReadiness(webContents);

    expect(webContents.listenerCount('did-finish-load')).toBe(0);
    expect(lifecycle.listenerCount('exit')).toBe(0);
    expect(signalReady).not.toHaveBeenCalled();
  });

  it('reports readiness failures without throwing from the event', async () => {
    const webContents = new EventEmitter();
    const readinessError = new Error('marker unavailable');
    const onError = vi.fn();

    const registerReadiness = createReloadPreviewReadinessRegistrar({
      lifecycle: new EventEmitter(),
      readyFilePath: join('temp', 'restart.ready'),
      dependencies: {
        removeFileSync: vi.fn(),
        signalReady: vi.fn().mockRejectedValue(readinessError),
      },
      onError,
    });
    registerReadiness(webContents);

    expect(() => webContents.emit('did-finish-load')).not.toThrow();
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        'Failed to signal replacement preview readiness',
        readinessError,
      ),
    );
  });

  it('preserves the startup log on exit before parent acknowledgment', () => {
    const webContents = new EventEmitter();
    const lifecycle = new EventEmitter();
    const ackFilePath = join('temp', 'restart.ack');
    const logFilePath = join('temp', 'restart.log');
    const removeFileSync = vi.fn();

    const registerReadiness = createReloadPreviewReadinessRegistrar({
      ackFilePath,
      lifecycle,
      logFilePath,
      readyFilePath: join('temp', 'restart.ready'),
      dependencies: {
        fileExistsSync: vi.fn().mockReturnValue(false),
        removeFileSync,
        signalReady: vi.fn().mockResolvedValue(undefined),
      },
      onError: vi.fn(),
    });
    registerReadiness(webContents);

    webContents.emit('did-finish-load');
    expect(removeFileSync).not.toHaveBeenCalled();

    lifecycle.emit('exit');
    expect(removeFileSync).not.toHaveBeenCalled();
  });

  it('removes the acknowledged startup log and acknowledgment on exit', () => {
    const lifecycle = new EventEmitter();
    const ackFilePath = join('temp', 'restart.ack');
    const logFilePath = join('temp', 'restart.log');
    const removeFileSync = vi.fn();

    createReloadPreviewReadinessRegistrar({
      ackFilePath,
      lifecycle,
      logFilePath,
      dependencies: {
        fileExistsSync: vi.fn().mockReturnValue(true),
        removeFileSync,
        signalReady: vi.fn(),
      },
      onError: vi.fn(),
    });

    lifecycle.emit('exit');

    expect(removeFileSync).toHaveBeenCalledWith(logFilePath);
    expect(removeFileSync).toHaveBeenCalledWith(ackFilePath);
    expect(removeFileSync).toHaveBeenCalledTimes(2);
  });

  it('reports acknowledged startup cleanup failures without blocking exit', () => {
    const lifecycle = new EventEmitter();
    const cleanupError = new Error('log is locked');
    const onError = vi.fn();
    const removeFileSync = vi
      .fn()
      .mockImplementationOnce(() => {
        throw cleanupError;
      })
      .mockImplementationOnce(() => undefined);

    createReloadPreviewReadinessRegistrar({
      ackFilePath: join('temp', 'restart.ack'),
      lifecycle,
      logFilePath: join('temp', 'restart.log'),
      dependencies: {
        fileExistsSync: vi.fn().mockReturnValue(true),
        removeFileSync,
        signalReady: vi.fn(),
      },
      onError,
    });

    expect(() => lifecycle.emit('exit')).not.toThrow();
    expect(onError).toHaveBeenCalledWith(
      'Failed to clean up replacement preview files',
      cleanupError,
    );
    expect(removeFileSync).toHaveBeenCalledTimes(2);
  });

  it('allows a second window to signal after the first window fails', async () => {
    const firstWebContents = new EventEmitter();
    const secondWebContents = new EventEmitter();
    const readinessError = new Error('first marker failed');
    const signalReady = vi
      .fn()
      .mockRejectedValueOnce(readinessError)
      .mockResolvedValueOnce(undefined);
    const onError = vi.fn();
    const registerReadiness = createReloadPreviewReadinessRegistrar({
      lifecycle: new EventEmitter(),
      readyFilePath: join('temp', 'restart.ready'),
      dependencies: {
        fileExistsSync: vi.fn(),
        removeFileSync: vi.fn(),
        signalReady,
      },
      onError,
    });

    registerReadiness(firstWebContents);
    registerReadiness(secondWebContents);

    expect(firstWebContents.listenerCount('did-finish-load')).toBe(1);
    expect(secondWebContents.listenerCount('did-finish-load')).toBe(1);

    firstWebContents.emit('did-finish-load');
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        'Failed to signal replacement preview readiness',
        readinessError,
      ),
    );
    secondWebContents.emit('did-finish-load');
    await vi.waitFor(() => expect(signalReady).toHaveBeenCalledTimes(2));
  });

  it('prevents concurrent and duplicate successful readiness signals', async () => {
    const firstWebContents = new EventEmitter();
    const secondWebContents = new EventEmitter();
    let resolveSignal: (() => void) | undefined;
    const signalReady = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSignal = resolve;
        }),
    );
    const registerReadiness = createReloadPreviewReadinessRegistrar({
      lifecycle: new EventEmitter(),
      readyFilePath: join('temp', 'restart.ready'),
      dependencies: {
        fileExistsSync: vi.fn(),
        removeFileSync: vi.fn(),
        signalReady,
      },
      onError: vi.fn(),
    });

    registerReadiness(firstWebContents);
    registerReadiness(secondWebContents);

    firstWebContents.emit('did-finish-load');
    secondWebContents.emit('did-finish-load');
    expect(signalReady).toHaveBeenCalledOnce();

    resolveSignal?.();
    await Promise.resolve();
    await Promise.resolve();

    const thirdWebContents = new EventEmitter();
    registerReadiness(thirdWebContents);
    expect(thirdWebContents.listenerCount('did-finish-load')).toBe(0);
    thirdWebContents.emit('did-finish-load');
    expect(signalReady).toHaveBeenCalledOnce();
  });
});

function createLaunchHarness(params?: {
  markerChecks?: boolean[];
  onMarkerCheck?: (markerExists: boolean) => void;
  onWait?: () => void;
  output?: string;
}) {
  const child = Object.assign(new EventEmitter(), {
    pid: 4321,
    unref: vi.fn(),
  });
  const spawnProcess = vi.fn().mockReturnValue(child);
  const terminateProcessTree = vi.fn().mockResolvedValue(undefined);
  const removeFile = vi.fn().mockResolvedValue(undefined);
  const markerChecks = [...(params?.markerChecks ?? [true])];
  const tempDirectory = join('temp', 'preview-reload');
  const readyFilePath = join(
    tempDirectory,
    'jean-claude-preview-restart-restart-id.ready',
  );
  const ackFilePath = join(
    tempDirectory,
    'jean-claude-preview-restart-restart-id.ack',
  );
  const logFilePath = join(
    tempDirectory,
    'jean-claude-preview-restart-restart-id.log',
  );
  let currentTime = 0;

  return {
    child,
    dependencies: {
      acknowledgeReady: vi.fn().mockResolvedValue(undefined),
      closeLogFile: vi.fn(),
      markerExists: vi.fn(async () => {
        const exists = markerChecks.shift() ?? false;
        params?.onMarkerCheck?.(exists);
        return exists;
      }),
      now: () => currentTime,
      openLogFile: vi.fn().mockReturnValue(12),
      randomId: () => 'restart-id',
      readLogTail: vi.fn().mockResolvedValue(params?.output ?? ''),
      removeFile,
      spawnProcess,
      tempDirectory: () => tempDirectory,
      terminateProcessTree,
      wait: vi.fn(async (durationMs: number) => {
        currentTime += durationMs;
        params?.onWait?.();
      }),
    },
    ackFilePath,
    logFilePath,
    readyFilePath,
    removeFile,
    spawnProcess,
    terminateProcessTree,
  };
}

describe('launchReloadedPreview', () => {
  it('resolves only after the readiness marker exists', async () => {
    const harness = createLaunchHarness({ markerChecks: [false, true] });

    await expect(
      launchReloadedPreview({
        cwd: '/project',
        dependencies: harness.dependencies,
        timeoutMs: 1000,
      }),
    ).resolves.toBeUndefined();

    expect(harness.spawnProcess).toHaveBeenCalledWith(
      'pnpm preview:skip-build',
      [],
      expect.objectContaining({
        cwd: '/project',
        detached: true,
        env: expect.objectContaining({
          JC_PREVIEW_RESTART_ACK_FILE: harness.ackFilePath,
          JC_PREVIEW_RESTART_LOG_FILE: harness.logFilePath,
          JC_PREVIEW_RESTART_READY_FILE: harness.readyFilePath,
        }),
        shell: true,
        stdio: ['ignore', 12, 12],
      }),
    );
    expect(harness.dependencies.openLogFile).toHaveBeenCalledWith(
      harness.logFilePath,
    );
    expect(harness.dependencies.closeLogFile).toHaveBeenCalledWith(12);
    expect(harness.child.unref).toHaveBeenCalledOnce();
    expect(harness.terminateProcessTree).not.toHaveBeenCalled();
    expect(harness.dependencies.acknowledgeReady).toHaveBeenCalledWith(
      harness.readyFilePath,
      harness.ackFilePath,
    );
    expect(harness.removeFile).not.toHaveBeenCalled();
  });

  it('rejects and removes all restart files when acknowledgment fails', async () => {
    const harness = createLaunchHarness({ markerChecks: [true] });
    harness.dependencies.acknowledgeReady.mockRejectedValue(
      new Error('ack rename failed'),
    );

    await expect(
      launchReloadedPreview({
        cwd: join('project', 'root'),
        dependencies: harness.dependencies,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow('ack rename failed');

    expect(harness.terminateProcessTree).toHaveBeenCalledWith(4321);
    expect(harness.dependencies.acknowledgeReady).toHaveBeenCalledWith(
      harness.readyFilePath,
      harness.ackFilePath,
    );
    expect(harness.removeFile).toHaveBeenCalledWith(harness.readyFilePath);
    expect(harness.removeFile).toHaveBeenCalledWith(harness.ackFilePath);
    expect(harness.removeFile).toHaveBeenCalledWith(harness.logFilePath);
    expect(harness.removeFile).toHaveBeenCalledTimes(3);
  });

  it('rejects when the child exits while readiness is being acknowledged', async () => {
    const harness = createLaunchHarness({
      markerChecks: [true],
      output: 'replacement exited after acknowledgment',
    });
    harness.dependencies.acknowledgeReady.mockImplementation(async () => {
      harness.child.emit('exit', 1, null);
    });

    await expect(
      launchReloadedPreview({
        cwd: join('project', 'root'),
        dependencies: harness.dependencies,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(
      'Replacement preview exited with exit code 1 before becoming ready: replacement exited after acknowledgment',
    );

    expect(harness.dependencies.readLogTail).toHaveBeenCalledWith(
      harness.logFilePath,
    );
    expect(
      harness.dependencies.readLogTail.mock.invocationCallOrder[0],
    ).toBeLessThan(harness.removeFile.mock.invocationCallOrder[0]);
    expect(harness.terminateProcessTree).toHaveBeenCalledWith(4321);
    expect(harness.removeFile).toHaveBeenCalledWith(harness.readyFilePath);
    expect(harness.removeFile).toHaveBeenCalledWith(harness.ackFilePath);
    expect(harness.removeFile).toHaveBeenCalledWith(harness.logFilePath);
    expect(harness.removeFile).toHaveBeenCalledTimes(3);
  });

  it('rejects when the child exits as the readiness marker is detected', async () => {
    let child: EventEmitter;
    const harness = createLaunchHarness({
      markerChecks: [true],
      onMarkerCheck: (exists) => {
        if (exists) child.emit('exit', 1, null);
      },
      output: 'failed during readiness handoff',
    });
    child = harness.child;

    await expect(
      launchReloadedPreview({
        cwd: join('project', 'root'),
        dependencies: harness.dependencies,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(
      'Replacement preview exited with exit code 1 before becoming ready: failed during readiness handoff',
    );

    expect(harness.terminateProcessTree).toHaveBeenCalledWith(4321);
    expect(harness.dependencies.acknowledgeReady).not.toHaveBeenCalled();
    expect(harness.removeFile).toHaveBeenCalledWith(harness.readyFilePath);
    expect(harness.removeFile).toHaveBeenCalledWith(harness.ackFilePath);
    expect(harness.removeFile).toHaveBeenCalledWith(harness.logFilePath);
    expect(harness.removeFile).toHaveBeenCalledTimes(3);
  });

  it('rejects with captured output and terminates after an early exit', async () => {
    let child: EventEmitter;
    const harness = createLaunchHarness({
      markerChecks: [false, false],
      onWait: () => child.emit('exit', 1, null),
      output: 'replacement boot failed',
    });
    child = harness.child;

    await expect(
      launchReloadedPreview({
        cwd: '/project',
        dependencies: harness.dependencies,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(
      'Replacement preview exited with exit code 1 before becoming ready: replacement boot failed',
    );

    expect(harness.terminateProcessTree).toHaveBeenCalledWith(4321);
    expect(harness.removeFile).toHaveBeenCalledWith(harness.readyFilePath);
    expect(harness.removeFile).toHaveBeenCalledWith(harness.ackFilePath);
    expect(harness.removeFile).toHaveBeenCalledWith(harness.logFilePath);
    expect(harness.removeFile).toHaveBeenCalledTimes(3);
  });

  it('rejects bounded output and cleans up when the child emits an error', async () => {
    let child: EventEmitter;
    const output = `old output${'x'.repeat(5000)}latest spawn failure`;
    const harness = createLaunchHarness({
      markerChecks: [false, false],
      onWait: () => child.emit('error', new Error('spawn interrupted')),
      output,
    });
    child = harness.child;

    await expect(
      launchReloadedPreview({
        cwd: join('project', 'root'),
        dependencies: harness.dependencies,
        timeoutMs: 1000,
      }),
    ).rejects.toSatisfy((error: Error) => {
      expect(error.message).toContain(
        'Replacement preview failed to start: spawn interrupted',
      );
      expect(error.message).toContain('latest spawn failure');
      expect(error.message).not.toContain('old output');
      expect(error.message.length).toBeLessThan(4200);
      return true;
    });

    expect(harness.terminateProcessTree).toHaveBeenCalledWith(4321);
    expect(harness.removeFile).toHaveBeenCalledWith(harness.readyFilePath);
    expect(harness.removeFile).toHaveBeenCalledWith(harness.ackFilePath);
    expect(harness.removeFile).toHaveBeenCalledWith(harness.logFilePath);
    expect(harness.removeFile).toHaveBeenCalledTimes(3);
  });

  it('rejects with bounded output and terminates after timing out', async () => {
    const output = `old output${'x'.repeat(5000)}latest failure`;
    const harness = createLaunchHarness({ markerChecks: [false], output });

    await expect(
      launchReloadedPreview({
        cwd: '/project',
        dependencies: harness.dependencies,
        pollIntervalMs: 25,
        timeoutMs: 50,
      }),
    ).rejects.toSatisfy((error: Error) => {
      expect(error.message).toContain(
        'Replacement preview timed out after 50ms',
      );
      expect(error.message).toContain('latest failure');
      expect(error.message).not.toContain('old output');
      expect(error.message.length).toBeLessThan(4200);
      return true;
    });

    expect(harness.terminateProcessTree).toHaveBeenCalledWith(4321);
    expect(harness.removeFile).toHaveBeenCalledWith(harness.readyFilePath);
    expect(harness.removeFile).toHaveBeenCalledWith(harness.ackFilePath);
    expect(harness.removeFile).toHaveBeenCalledWith(harness.logFilePath);
    expect(harness.removeFile).toHaveBeenCalledTimes(3);
  });

  it('preserves startup failure details when termination and cleanup fail', async () => {
    const harness = createLaunchHarness({ markerChecks: [false] });
    harness.terminateProcessTree.mockRejectedValue(
      new Error('termination permission denied'),
    );
    harness.removeFile.mockRejectedValue(new Error('cleanup permission denied'));

    await expect(
      launchReloadedPreview({
        cwd: join('project', 'root'),
        dependencies: harness.dependencies,
        pollIntervalMs: 25,
        timeoutMs: 50,
      }),
    ).rejects.toSatisfy((error: Error) => {
      expect(error.message).toContain(
        'Replacement preview timed out after 50ms',
      );
      expect(error.message).toContain('termination permission denied');
      expect(error.message).toContain('cleanup permission denied');
      return true;
    });
  });
});

describe('cleanupReloadPreviewFiles', () => {
  it('attempts every provided file and reports cleanup failures', async () => {
    const ackFilePath = join('temp', 'restart.ack');
    const readyFilePath = join('temp', 'restart.ready');
    const logFilePath = join('temp', 'restart.log');
    const removeFile = vi
      .fn()
      .mockRejectedValueOnce(new Error('ready file locked'))
      .mockResolvedValueOnce(undefined);

    await expect(
      cleanupReloadPreviewFiles({
        ackFilePath,
        dependencies: { removeFile },
        logFilePath,
        readyFilePath,
      }),
    ).rejects.toThrow(`Failed to remove ${readyFilePath}: ready file locked`);

    expect(removeFile).toHaveBeenCalledWith(readyFilePath);
    expect(removeFile).toHaveBeenCalledWith(ackFilePath);
    expect(removeFile).toHaveBeenCalledWith(logFilePath);
  });
});

describe('terminateReloadPreviewProcessTree', () => {
  it('treats ESRCH as an already-terminated POSIX process group', async () => {
    const killProcessGroup = vi.fn(() => {
      throw Object.assign(new Error('missing'), { code: 'ESRCH' });
    });

    await expect(
      terminateReloadPreviewProcessTree({
        dependencies: { killProcessGroup },
        pid: 4321,
        platform: 'darwin',
      }),
    ).resolves.toBeUndefined();

    expect(killProcessGroup).toHaveBeenCalledWith(4321, 'SIGTERM');
  });

  it('surfaces POSIX termination permission errors', async () => {
    const killProcessGroup = vi.fn(() => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    });

    await expect(
      terminateReloadPreviewProcessTree({
        dependencies: { killProcessGroup },
        pid: 4321,
        platform: 'linux',
      }),
    ).rejects.toThrow(
      'Failed to terminate replacement process group 4321 with SIGTERM: not permitted',
    );
  });

  it('rejects when Windows taskkill exits nonzero', async () => {
    const taskkill = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const promise = terminateReloadPreviewProcessTree({
      dependencies: { spawnTaskkill: vi.fn().mockReturnValue(taskkill) },
      pid: 4321,
      platform: 'win32',
    });
    taskkill.emit('close', 1, null);

    await expect(promise).rejects.toThrow(
      'taskkill failed for replacement process 4321 with exit code 1',
    );
  });

  it('rejects when Windows taskkill fails to start', async () => {
    const taskkill = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const promise = terminateReloadPreviewProcessTree({
      dependencies: { spawnTaskkill: vi.fn().mockReturnValue(taskkill) },
      pid: 4321,
      platform: 'win32',
    });
    taskkill.emit('error', new Error('taskkill unavailable'));

    await expect(promise).rejects.toThrow(
      'taskkill failed to start for replacement process 4321: taskkill unavailable',
    );
  });

  it('times out and kills a stuck Windows taskkill process', async () => {
    const taskkill = Object.assign(new EventEmitter(), { kill: vi.fn() });
    let timeoutCallback: (() => void) | undefined;
    const clearTerminationTimeout = vi.fn();
    const promise = terminateReloadPreviewProcessTree({
      dependencies: {
        clearTerminationTimeout,
        setTerminationTimeout: vi.fn((callback: () => void) => {
          timeoutCallback = callback;
          return 1 as never;
        }),
        spawnTaskkill: vi.fn().mockReturnValue(taskkill),
      },
      pid: 4321,
      platform: 'win32',
      taskkillTimeoutMs: 250,
    });
    timeoutCallback?.();

    await expect(promise).rejects.toThrow(
      'taskkill timed out after 250ms for replacement process 4321',
    );
    expect(taskkill.kill).toHaveBeenCalledWith('SIGKILL');
    expect(clearTerminationTimeout).toHaveBeenCalled();
  });
});
