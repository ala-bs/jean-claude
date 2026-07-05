import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { describe, expect, it, vi } from 'vitest';

import {
  AcpJsonRpcClient,
  type AcpJsonRpcProcess,
} from './acp-json-rpc-client';

function createFakeProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(),
  });

  return proc as unknown as AcpJsonRpcProcess & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
}

function createHangingWriteProcess() {
  const proc = createFakeProcess();
  proc.stdin.write = vi.fn(() => true) as unknown as PassThrough['write'];

  return proc;
}

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('AcpJsonRpcClient', () => {
  it('writes newline-delimited JSON-RPC requests and resolves responses', async () => {
    const proc = createFakeProcess();
    const client = new AcpJsonRpcClient({ process: proc });
    const written: string[] = [];
    proc.stdin.on('data', (chunk: Buffer) => written.push(chunk.toString()));

    const request = client.request('session/new', { cwd: '/tmp/project' });
    proc.stdout.write('{"id":1,"result":{"sessionId":"session-1"}}\n');

    await expect(request).resolves.toEqual({ sessionId: 'session-1' });
    expect(written).toEqual([
      '{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/tmp/project"}}\n',
    ]);
  });

  it('resolves JSON-RPC responses with string ids', async () => {
    const proc = createFakeProcess();
    const client = new AcpJsonRpcClient({ process: proc });

    const pending = client.request('session/new');
    proc.stdout.write('{"id":"1","result":{"sessionId":"session-1"}}\n');

    await expect(pending).resolves.toEqual({ sessionId: 'session-1' });
  });

  it('emits notifications', async () => {
    const proc = createFakeProcess();
    const client = new AcpJsonRpcClient({ process: proc });
    const seen: unknown[] = [];
    client.onNotification((message) => seen.push(message));

    proc.stdout.write(
      '{"method":"session/update","params":{"sessionId":"session-1"}}\n',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seen).toEqual([
      { method: 'session/update', params: { sessionId: 'session-1' } },
    ]);
  });

  it('emits incoming JSON-RPC requests', async () => {
    const proc = createFakeProcess();
    const client = new AcpJsonRpcClient({ process: proc });
    const seen: unknown[] = [];
    client.onRequest((message) => seen.push(message));

    proc.stdout.write(
      '{"jsonrpc":"2.0","id":"req-1","method":"session/request_permission","params":{"sessionId":"session-1"}}\n',
    );
    await nextTick();

    expect(seen).toEqual([
      {
        id: 'req-1',
        method: 'session/request_permission',
        params: { sessionId: 'session-1' },
      },
    ]);
  });

  it('writes JSON-RPC responses', async () => {
    const proc = createFakeProcess();
    const client = new AcpJsonRpcClient({ process: proc });
    const written: string[] = [];
    proc.stdin.on('data', (chunk: Buffer) => written.push(chunk.toString()));

    await client.respond('req-1', { outcome: { outcome: 'cancelled' } });

    expect(written).toEqual([
      '{"jsonrpc":"2.0","id":"req-1","result":{"outcome":{"outcome":"cancelled"}}}\n',
    ]);
  });

  it('removes request listeners when unsubscribed', async () => {
    const proc = createFakeProcess();
    const client = new AcpJsonRpcClient({ process: proc });
    const listener = vi.fn();
    const unsubscribe = client.onRequest(listener);

    unsubscribe();
    proc.stdout.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    await nextTick();

    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects pending requests and emits errors on stdout errors', async () => {
    const proc = createFakeProcess();
    const client = new AcpJsonRpcClient({ process: proc });
    const errors: Error[] = [];
    client.onError((error) => errors.push(error));
    const stdoutError = new Error('stdout failed');

    const request = client.request('session/new');
    proc.stdout.emit('error', stdoutError);

    await expect(request).rejects.toThrow('stdout failed');
    expect(errors).toEqual([stdoutError]);
  });

  it('rejects notify when stdin write stalls past the request timeout', async () => {
    vi.useFakeTimers();
    try {
      const proc = createHangingWriteProcess();
      const client = new AcpJsonRpcClient({
        process: proc,
        requestTimeoutMs: 10,
      });

      const notify = expect(client.notify('session/cancel')).rejects.toThrow(
        'ACP JSON-RPC write timed out',
      );
      await vi.advanceTimersByTimeAsync(10);

      await notify;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fail terminal when response arrives before stdin write callback', async () => {
    vi.useFakeTimers();
    try {
      const proc = createHangingWriteProcess();
      const client = new AcpJsonRpcClient({
        process: proc,
        requestTimeoutMs: 10,
      });
      const errors: Error[] = [];
      client.onError((error) => errors.push(error));

      const first = client.request('session/new');
      proc.stdout.write('{"id":1,"result":{"sessionId":"session-1"}}\n');
      await expect(first).resolves.toEqual({ sessionId: 'session-1' });

      await vi.advanceTimersByTimeAsync(10);

      expect(errors).toEqual([]);
      const second = client.request('session/info');
      proc.stdout.write('{"id":2,"result":{"ok":true}}\n');
      await expect(second).resolves.toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes notification listeners when unsubscribed', async () => {
    const proc = createFakeProcess();
    const client = new AcpJsonRpcClient({ process: proc });
    const listener = vi.fn();
    const unsubscribe = client.onNotification(listener);

    unsubscribe();
    proc.stdout.write('{"method":"session/update"}\n');
    await nextTick();

    expect(listener).not.toHaveBeenCalled();
  });
});
