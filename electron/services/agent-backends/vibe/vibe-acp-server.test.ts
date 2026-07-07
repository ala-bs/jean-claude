import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const spawn = vi.fn();
  const execFile = vi.fn((_command, _args, _options, callback) => {
    callback(null, 'vibe-acp 0.1.0\n', '');
  });
  const dbgAgent = vi.fn();
  const requestImplementations: Array<() => Promise<unknown>> = [];
  const notifyImplementations: Array<() => Promise<void>> = [];
  const clientInstances: Array<{
    process: unknown;
    request: ReturnType<typeof vi.fn>;
    notify: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];

  class AcpJsonRpcClient {
    private readonly process: { kill: () => void };
    readonly request = vi.fn(() => {
      const implementation = requestImplementations.shift();
      return implementation?.() ?? Promise.resolve({});
    });
    readonly notify = vi.fn(() => {
      const implementation = notifyImplementations.shift();
      return implementation?.() ?? Promise.resolve(undefined);
    });
    readonly dispose = vi.fn(() => this.process.kill());

    constructor(options: { process: { kill: () => void } }) {
      this.process = options.process;
      clientInstances.push({
        process: options.process,
        request: this.request,
        notify: this.notify,
        dispose: this.dispose,
      });
    }
  }

  return {
    spawn,
    execFile,
    dbgAgent,
    requestImplementations,
    notifyImplementations,
    clientInstances,
    AcpJsonRpcClient,
  };
});

vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
  spawn: mocks.spawn,
}));

vi.mock('../../../lib/debug', () => ({
  dbg: { agent: mocks.dbgAgent },
}));

vi.mock('../acp-json-rpc-client', () => ({
  AcpJsonRpcClient: mocks.AcpJsonRpcClient,
}));

import {
  getOrCreateVibeAcpServer,
  resetVibeAcpServerForTest,
} from './vibe-acp-server';

function createFakeProcess(pid = 1234) {
  const proc = Object.assign(new EventEmitter(), {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  proc.kill.mockImplementation(() => {
    proc.emit('exit', 0, null);
    proc.emit('close', 0, null);
  });
  return proc;
}

describe('Vibe ACP server process manager', () => {
  beforeEach(() => {
    mocks.spawn.mockReset();
    mocks.execFile.mockReset();
    mocks.execFile.mockImplementation((_command, _args, _options, callback) => {
      callback(null, 'vibe-acp 0.1.0\n', '');
    });
    mocks.dbgAgent.mockReset();
    mocks.requestImplementations.length = 0;
    mocks.notifyImplementations.length = 0;
    mocks.clientInstances.length = 0;
  });

  afterEach(async () => {
    await resetVibeAcpServerForTest();
  });

  it('checks availability, spawns vibe-acp over stdio, and performs ACP handshake', async () => {
    const proc = createFakeProcess();
    mocks.spawn.mockReturnValue(proc);

    const handle = await getOrCreateVibeAcpServer();

    expect(mocks.execFile).toHaveBeenCalledWith(
      'vibe-acp',
      ['--version'],
      { timeout: 5_000 },
      expect.any(Function),
    );
    expect(mocks.spawn).toHaveBeenCalledWith(
      'vibe-acp',
      [],
      expect.objectContaining({
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
    expect(handle.client).toBeInstanceOf(mocks.AcpJsonRpcClient);
    expect(handle.rootPid).toBe(1234);
    expect(mocks.clientInstances).toHaveLength(1);
    expect(mocks.clientInstances[0].process).toBe(proc);
    expect(mocks.clientInstances[0].request).toHaveBeenCalledWith(
      'initialize',
      {
        protocolVersion: 1,
        clientInfo: {
          name: 'jean_claude',
          title: 'Jean-Claude',
          version: '0.0.1',
        },
        clientCapabilities: {
          terminal: false,
          fs: { readTextFile: false, writeTextFile: false },
          fieldMeta: { 'terminal-auth': false },
        },
      },
    );
    expect(mocks.clientInstances[0].notify).toHaveBeenCalledWith(
      'initialized',
      {},
    );
    expect(
      mocks.clientInstances[0].request.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.clientInstances[0].notify.mock.invocationCallOrder[0]);
  });

  it('fails clearly when vibe-acp is missing', async () => {
    const missingError = Object.assign(new Error('spawn vibe-acp ENOENT'), {
      code: 'ENOENT',
    });
    mocks.execFile.mockImplementationOnce(
      (_command, _args, _options, callback) => {
        callback(missingError, '', '');
      },
    );

    await expect(getOrCreateVibeAcpServer()).rejects.toThrow(
      /Install mistral-vibe.*MISTRAL_API_KEY/,
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('logs stderr from vibe-acp', async () => {
    const proc = createFakeProcess();
    mocks.spawn.mockReturnValue(proc);

    await getOrCreateVibeAcpServer();
    proc.stderr.write('server warning\n');

    expect(mocks.dbgAgent).toHaveBeenCalledWith(
      'Vibe ACP stderr: %s',
      'server warning',
    );
  });

  it('reuses and disposes singleton server', async () => {
    const firstProc = createFakeProcess();
    const secondProc = createFakeProcess();
    mocks.spawn.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

    const first = await getOrCreateVibeAcpServer();
    const reused = await getOrCreateVibeAcpServer();
    await first.dispose();
    const second = await getOrCreateVibeAcpServer();

    expect(reused).toBe(first);
    expect(second).not.toBe(first);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(mocks.clientInstances[0].dispose).toHaveBeenCalledTimes(1);
    expect(firstProc.kill).toHaveBeenCalledTimes(1);
    expect(firstProc.stderr.listenerCount('data')).toBe(0);
  });

  it('removes stderr listener when startup initialize fails and retries cleanly', async () => {
    const firstProc = createFakeProcess();
    const secondProc = createFakeProcess();
    mocks.spawn.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);
    mocks.requestImplementations.push(
      () => Promise.reject(new Error('initialize failed')),
      () => Promise.resolve({}),
    );

    await expect(getOrCreateVibeAcpServer()).rejects.toThrow(
      'initialize failed',
    );
    const second = await getOrCreateVibeAcpServer();

    expect(second.rootPid).toBe(secondProc.pid);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(mocks.clientInstances[0].dispose).toHaveBeenCalledTimes(1);
    expect(firstProc.kill).toHaveBeenCalledTimes(1);
    expect(firstProc.stderr.listenerCount('data')).toBe(0);
  });

  it('clears singleton after process exits at runtime', async () => {
    const firstProc = createFakeProcess();
    const secondProc = createFakeProcess();
    mocks.spawn.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

    const first = await getOrCreateVibeAcpServer();
    firstProc.emit('exit', 1, null);
    const second = await getOrCreateVibeAcpServer();

    expect(second).not.toBe(first);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });
});
