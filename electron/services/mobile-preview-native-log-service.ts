import { randomUUID } from 'node:crypto';

import { app } from 'electron';

import type {
  MobilePlatform,
  MobilePreviewNativeLogEvent,
  MobilePreviewNativeLogSession,
  MobilePreviewNativeLogSessionEvent,
  MobilePreviewNativeLogStartParams,
  MobilePreviewNativeLogStream,
} from '@shared/mobile-simulator-types';

import {
  type MobilePreviewLifecycle,
  registerBeforeQuitCleanup,
} from './mobile-preview-lifecycle';
import { spawnManaged } from './mobile-preview-process';

type ProcessHandle = {
  child: {
    stdout: {
      on: (event: 'data', listener: (chunk: Buffer) => void) => unknown;
    };
    stderr: {
      on: (event: 'data', listener: (chunk: Buffer) => void) => unknown;
    };
    on: {
      (event: 'error', listener: (error: Error) => void): unknown;
      (event: 'close', listener: (code: number | null) => void): unknown;
      (event: string, listener: (...args: unknown[]) => void): unknown;
    };
  };
  stop: () => Promise<void>;
};

type NativeLogServiceOptions = {
  spawnProcess?: (
    command: string,
    args: string[],
    options?: { env?: typeof process.env },
  ) => ProcessHandle;
  lifecycle?: MobilePreviewLifecycle;
  logger?: Pick<typeof console, 'error'>;
};

function nowIso() {
  return new Date().toISOString();
}

function formatCommand(command: string, args: string[]) {
  return [command, ...args].join(' ');
}

export function buildNativeLogCommand(
  platform: MobilePlatform,
  deviceId: string,
) {
  if (platform === 'ios') {
    return {
      command: 'xcrun',
      args: [
        'simctl',
        'spawn',
        deviceId,
        'log',
        'stream',
        '--style',
        'compact',
        '--level',
        'debug',
      ],
    };
  }

  return {
    command: 'adb',
    args: ['-s', deviceId, 'logcat', '-v', 'time'],
  };
}

function createSession({
  platform,
  deviceId,
  command,
}: {
  platform: MobilePlatform;
  deviceId: string;
  command: string;
}): MobilePreviewNativeLogSession {
  return {
    id: randomUUID(),
    platform,
    deviceId,
    status: 'running',
    command,
    error: null,
    updatedAt: nowIso(),
  };
}

function updateSession(
  session: MobilePreviewNativeLogSession,
  patch: Partial<MobilePreviewNativeLogSession>,
): MobilePreviewNativeLogSession {
  return {
    ...session,
    ...patch,
    updatedAt: nowIso(),
  };
}

export function createMobilePreviewNativeLogService({
  spawnProcess = spawnManaged,
  lifecycle,
  logger = console,
}: NativeLogServiceOptions = {}) {
  const sessions = new Map<
    string,
    { session: MobilePreviewNativeLogSession; process: ProcessHandle }
  >();
  const sessionListeners = new Set<
    (event: MobilePreviewNativeLogSessionEvent) => void
  >();
  const logListeners = new Set<(event: MobilePreviewNativeLogEvent) => void>();

  function emitSession(session: MobilePreviewNativeLogSession) {
    sessionListeners.forEach((listener) => listener({ session }));
  }

  function emitLog(
    sessionId: string,
    stream: MobilePreviewNativeLogStream,
    text: string,
  ) {
    logListeners.forEach((listener) =>
      listener({ sessionId, stream, text, timestamp: nowIso() }),
    );
  }

  function findSession(params: MobilePreviewNativeLogStartParams) {
    return Array.from(sessions.values()).find(
      (entry) =>
        entry.session.platform === params.platform &&
        entry.session.deviceId === params.deviceId,
    );
  }

  const service = {
    onSession(listener: (event: MobilePreviewNativeLogSessionEvent) => void) {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },

    onLog(listener: (event: MobilePreviewNativeLogEvent) => void) {
      logListeners.add(listener);
      return () => logListeners.delete(listener);
    },

    start(
      params: MobilePreviewNativeLogStartParams,
    ): MobilePreviewNativeLogSession {
      const existing = findSession(params);
      if (existing) return existing.session;

      const { command, args } = buildNativeLogCommand(
        params.platform,
        params.deviceId,
      );
      let session = createSession({
        platform: params.platform,
        deviceId: params.deviceId,
        command: formatCommand(command, args),
      });
      const processHandle = spawnProcess(command, args, {
        env: { ...process.env, FORCE_COLOR: '1' },
      });
      sessions.set(session.id, { session, process: processHandle });
      emitSession(session);
      emitLog(session.id, 'system', `Started logs: ${session.command}\n`);

      processHandle.child.stdout.on('data', (chunk: Buffer) => {
        emitLog(session.id, 'stdout', chunk.toString());
      });
      processHandle.child.stderr.on('data', (chunk: Buffer) => {
        emitLog(session.id, 'stderr', chunk.toString());
      });
      processHandle.child.on('error', (error: Error) => {
        const current = sessions.get(session.id);
        if (!current) return;
        session = updateSession(current.session, {
          status: 'errored',
          error: error.message,
        });
        sessions.set(session.id, { ...current, session });
        emitSession(session);
      });
      processHandle.child.on('close', (code: number | null) => {
        const current = sessions.get(session.id);
        if (!current) return;
        session = updateSession(current.session, {
          status: code === 0 ? 'stopped' : 'errored',
          error:
            code === 0 ? null : `Logs exited with code ${code ?? 'unknown'}`,
        });
        sessions.delete(session.id);
        emitSession(session);
      });

      return session;
    },

    async stop(sessionId: string): Promise<void> {
      const existing = sessions.get(sessionId);
      if (!existing) return;
      await existing.process.stop();
      sessions.delete(sessionId);
      emitSession(
        updateSession(existing.session, {
          status: 'stopped',
          error: null,
        }),
      );
    },

    async stopAll(): Promise<void> {
      await Promise.all(
        Array.from(sessions.keys()).map((id) => service.stop(id)),
      );
    },
  };

  if (lifecycle) {
    registerBeforeQuitCleanup({
      cleanup: service.stopAll,
      lifecycle,
      logger,
    });
  }

  return service;
}

export const mobilePreviewNativeLogService =
  createMobilePreviewNativeLogService({
    lifecycle: app
      ? {
          onBeforeQuit: (callback) => app.on('before-quit', callback),
        }
      : undefined,
  });
