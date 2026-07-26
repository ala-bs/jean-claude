import { randomUUID } from 'node:crypto';

import { app } from 'electron';

import type {
  MobilePreviewNetworkRequest,
  MobilePreviewPacketCaptureEvent,
  MobilePreviewPacketCaptureSession,
  MobilePreviewPacketCaptureSessionEvent,
  MobilePreviewPacketCaptureStartParams,
} from '@shared/mobile-simulator-types';

import {
  type MobilePreviewLifecycle,
  registerBeforeQuitCleanup,
} from './mobile-preview-lifecycle';
import { runCommand, spawnManaged } from './mobile-preview-process';

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

type PacketCaptureServiceOptions = {
  spawnProcess?: (
    command: string,
    args: string[],
    options?: { env?: typeof process.env },
  ) => ProcessHandle;
  runCommandImpl?: typeof runCommand;
  lifecycle?: MobilePreviewLifecycle;
  logger?: Pick<typeof console, 'error'>;
};

function nowIso() {
  return new Date().toISOString();
}

function formatCommand(command: string, args: string[]) {
  return [command, ...args].join(' ');
}

function endpointToHostPort(endpoint: string): {
  host: string;
  port: number | null;
} {
  const trimmed = endpoint.replace(/[:,]+$/g, '');
  const lastDot = trimmed.lastIndexOf('.');
  if (lastDot === -1) return { host: trimmed, port: null };

  const portText = trimmed.slice(lastDot + 1);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { host: trimmed, port: null };
  }

  return { host: trimmed.slice(0, lastDot), port };
}

function protocolFromLine(line: string) {
  if (/\bTCP\b/i.test(line) || /\bFlags\b/.test(line)) return 'tcp';
  if (/\bUDP\b/i.test(line)) return 'udp';
  if (/\bICMP\b/i.test(line)) return 'icmp';
  return 'packet';
}

function parsePacketLine(
  sessionId: string,
  line: string,
): MobilePreviewNetworkRequest | null {
  const match = line.match(/\b(?:IP6?|IPv6)\s+\S+\s+>\s+(\S+)/);
  if (!match) return null;

  const destination = endpointToHostPort(match[1]);
  if (!destination.host) return null;

  const protocol = protocolFromLine(line);
  const url =
    destination.port === null
      ? `${protocol}://${destination.host}`
      : `${protocol}://${destination.host}:${destination.port}`;
  const timestamp = nowIso();

  return {
    id: randomUUID(),
    sessionId,
    captureSource: 'packet-only',
    method: protocol.toUpperCase(),
    url,
    status: null,
    requestHeaders: {},
    responseHeaders: {},
    requestBodyPreview: null,
    responseBodyPreview: null,
    clientAddress: null,
    clientPort: null,
    startedAt: timestamp,
    endedAt: null,
    durationMs: null,
    error: null,
    tunnelOnly: true,
    decrypted: false,
  };
}

function createSession({
  params,
  command,
  args,
  status = 'running',
  error = null,
}: {
  params: MobilePreviewPacketCaptureStartParams;
  command: string;
  args: string[];
  status?: MobilePreviewPacketCaptureSession['status'];
  error?: string | null;
}): MobilePreviewPacketCaptureSession {
  return {
    id: randomUUID(),
    platform: params.platform,
    deviceId: params.deviceId,
    status,
    command: formatCommand(command, args),
    error,
    updatedAt: nowIso(),
  };
}

function updateSession(
  session: MobilePreviewPacketCaptureSession,
  patch: Partial<MobilePreviewPacketCaptureSession>,
): MobilePreviewPacketCaptureSession {
  return {
    ...session,
    ...patch,
    updatedAt: nowIso(),
  };
}

async function buildPacketCaptureCommand(
  params: MobilePreviewPacketCaptureStartParams,
  runCommandImpl: typeof runCommand,
): Promise<
  | { command: string; args: string[]; status?: 'running'; error?: null }
  | { command: string; args: string[]; status: 'setup-needed'; error: string }
  | { command: string; args: string[]; status: 'errored'; error: string }
> {
  if (params.command) {
    return { command: params.command, args: params.args ?? [] };
  }

  if (params.platform === 'android') {
    try {
      await runCommandImpl('adb', [
        '-s',
        params.deviceId,
        'shell',
        'which',
        'tcpdump',
      ]);
    } catch {
      return {
        command: 'adb',
        args: ['-s', params.deviceId, 'shell', 'tcpdump', '-l', '-n'],
        status: 'setup-needed',
        error:
          'Android packet capture requires tcpdump on the device. Install tcpdump or provide a custom packet capture command.',
      };
    }

    return {
      command: 'adb',
      args: ['-s', params.deviceId, 'shell', 'tcpdump', '-l', '-n'],
    };
  }

  if (params.platform === 'ios') {
    return {
      command: 'sudo',
      args: ['tcpdump', '-l', '-n', '-i', 'any'],
      status: 'setup-needed',
      error:
        'iOS packet capture requires a privileged host command. Run manually if needed: sudo tcpdump -l -n -i any',
    };
  }

  return {
    command: 'tcpdump',
    args: ['-l', '-n'],
  };
}

export function createMobilePreviewPacketCaptureService({
  spawnProcess = spawnManaged,
  runCommandImpl = runCommand,
  lifecycle,
  logger = console,
}: PacketCaptureServiceOptions = {}) {
  const sessions = new Map<
    string,
    {
      session: MobilePreviewPacketCaptureSession;
      process: ProcessHandle;
      stdoutBuffer: string;
      stopping: boolean;
    }
  >();
  const sessionListeners = new Set<
    (event: MobilePreviewPacketCaptureSessionEvent) => void
  >();
  const requestListeners = new Set<
    (event: MobilePreviewPacketCaptureEvent) => void
  >();

  function emitSession(session: MobilePreviewPacketCaptureSession) {
    sessionListeners.forEach((listener) => listener({ session }));
  }

  function emitRequest(request: MobilePreviewNetworkRequest) {
    requestListeners.forEach((listener) =>
      listener({ sessionId: request.sessionId, request }),
    );
  }

  const service = {
    onSession(listener: (event: MobilePreviewPacketCaptureSessionEvent) => void) {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },

    onRequest(listener: (event: MobilePreviewPacketCaptureEvent) => void) {
      requestListeners.add(listener);
      return () => requestListeners.delete(listener);
    },

    async start(
      params: MobilePreviewPacketCaptureStartParams,
    ): Promise<MobilePreviewPacketCaptureSession> {
      const { command, args, status, error } = await buildPacketCaptureCommand(
        params,
        runCommandImpl,
      );
      let session = createSession({ params, command, args, status, error });
      if (session.status !== 'running') {
        emitSession(session);
        return session;
      }

      const processHandle = spawnProcess(command, args, {
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      sessions.set(session.id, {
        session,
        process: processHandle,
        stdoutBuffer: '',
        stopping: false,
      });
      emitSession(session);

      processHandle.child.stdout.on('data', (chunk: Buffer) => {
        const current = sessions.get(session.id);
        if (!current) return;

        const lines = `${current.stdoutBuffer}${chunk.toString()}`.split(
          /\r?\n/,
        );
        const stdoutBuffer = lines.pop() ?? '';
        sessions.set(session.id, { ...current, stdoutBuffer });

        lines
          .map((line) => line.trim())
          .filter(Boolean)
          .forEach((line) => {
            const request = parsePacketLine(session.id, line);
            if (request) emitRequest(request);
          });
      });

      processHandle.child.stderr.on('data', () => {
        // stderr is currently not surfaced; close/error events update the session.
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
          status: code === 0 || current.stopping ? 'stopped' : 'errored',
          error:
            code === 0 || current.stopping
              ? null
              : `Packet capture exited with code ${code ?? 'unknown'}`,
        });
        sessions.delete(session.id);
        emitSession(session);
      });

      return session;
    },

    async stop(sessionId: string): Promise<void> {
      const existing = sessions.get(sessionId);
      if (!existing) return;
      sessions.set(sessionId, { ...existing, stopping: true });
      await existing.process.stop();
      const current = sessions.get(sessionId);
      if (!current) return;
      sessions.delete(sessionId);
      emitSession(
        updateSession(current.session, {
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

export const mobilePreviewPacketCaptureService =
  createMobilePreviewPacketCaptureService({
    lifecycle: app
      ? {
          onBeforeQuit: (callback) => app.on('before-quit', callback),
        }
      : undefined,
  });
