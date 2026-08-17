import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  GifEncoderWorkerRequest,
  GifEncoderWorkerResponse,
} from './gif-encoder-worker';
import { createGifEncoderWorkerClient } from './gif-encoder-worker-client';

class ControlledWorker {
  static constructorError: Error | undefined;
  static instances: ControlledWorker[] = [];
  static postMessageError: Error | undefined;

  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent<GifEncoderWorkerResponse>) => void) | null =
    null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  posted: GifEncoderWorkerRequest[] = [];
  terminateCalls = 0;

  constructor() {
    if (ControlledWorker.constructorError) {
      throw ControlledWorker.constructorError;
    }
    ControlledWorker.instances.push(this);
  }

  static reset() {
    ControlledWorker.constructorError = undefined;
    ControlledWorker.instances = [];
    ControlledWorker.postMessageError = undefined;
  }

  emit(response: GifEncoderWorkerResponse) {
    this.onmessage?.({ data: response } as MessageEvent);
  }

  emitError(message: string) {
    this.onerror?.({
      message,
      preventDefault: vi.fn(),
    } as unknown as ErrorEvent);
  }

  emitMessageError() {
    this.onmessageerror?.({} as MessageEvent);
  }

  postMessage(message: GifEncoderWorkerRequest) {
    if (ControlledWorker.postMessageError) {
      throw ControlledWorker.postMessageError;
    }
    this.posted.push(message);
  }

  terminate() {
    this.terminateCalls += 1;
  }
}

function initializedClient() {
  const controller = new AbortController();
  const client = createGifEncoderWorkerClient(controller.signal);
  const worker = ControlledWorker.instances[0];
  if (!worker) throw new Error('Controlled worker was not created');
  const initialized = client.initialize({
    width: 1,
    height: 1,
    colors: 32,
    delay: 42,
  });
  worker.emit({ type: 'initialized' });
  return { client, controller, initialized, worker };
}

describe('GIF encoder worker client failures', () => {
  beforeEach(() => {
    ControlledWorker.reset();
    vi.stubGlobal('Worker', ControlledWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('propagates Worker constructor failure', () => {
    ControlledWorker.constructorError = new Error('worker blocked');

    expect(() =>
      createGifEncoderWorkerClient(new AbortController().signal),
    ).toThrow('worker blocked');
    expect(ControlledWorker.instances).toHaveLength(0);
  });

  it('rejects postMessage throws exactly once and leaves client closed', async () => {
    ControlledWorker.postMessageError = new Error('clone failed');
    const client = createGifEncoderWorkerClient(new AbortController().signal);
    const worker = ControlledWorker.instances[0];
    if (!worker) throw new Error('Controlled worker was not created');
    let settlements = 0;

    await expect(
      client
        .initialize({
          width: 1,
          height: 1,
          colors: 32,
          delay: 42,
        })
        .finally(() => {
          settlements += 1;
        }),
    ).rejects.toThrow('clone failed');
    worker.emit({ type: 'initialized' });
    await expect(client.finish()).rejects.toThrow('unavailable');
    expect(settlements).toBe(1);
    expect(worker.terminateCalls).toBe(1);
  });

  it.each(['frame', 'finish'] as const)(
    'settles pending %s request when worker errors',
    async (phase) => {
      const { client, initialized, worker } = initializedClient();
      await initialized;
      const pending =
        phase === 'frame'
          ? client.encodeFrame(0, new ArrayBuffer(4))
          : client.finish();

      worker.emitError(`${phase} crashed`);

      await expect(pending).rejects.toThrow(`${phase} crashed`);
      expect(worker.terminateCalls).toBe(1);
      await expect(client.finish()).rejects.toThrow('unavailable');
    },
  );

  it('rejects unreadable worker messages without leaking pending request', async () => {
    const { client, initialized, worker } = initializedClient();
    await initialized;
    const pending = client.finish();

    worker.emitMessageError();

    await expect(pending).rejects.toThrow('unreadable response');
    expect(worker.terminateCalls).toBe(1);
    await expect(client.finish()).rejects.toThrow('unavailable');
  });

  it('rejects mismatched frame acknowledgements', async () => {
    const { client, initialized, worker } = initializedClient();
    await initialized;
    const pending = client.encodeFrame(0, new ArrayBuffer(4));

    worker.emit({ type: 'frame-encoded', frameIndex: 1, sizeBytes: 10 });

    await expect(pending).rejects.toThrow('unexpected response');
    expect(worker.terminateCalls).toBe(1);
  });

  it('closes on duplicate acknowledgement after settled request', async () => {
    const { client, initialized, worker } = initializedClient();
    await initialized;

    worker.emit({ type: 'initialized' });

    expect(worker.terminateCalls).toBe(1);
    await expect(client.finish()).rejects.toThrow('unavailable');
  });

  it('settles once when abort wins race against frame acknowledgement', async () => {
    const { client, controller, initialized, worker } = initializedClient();
    await initialized;
    let rejected = 0;
    let resolved = 0;
    const pending = client.encodeFrame(0, new ArrayBuffer(4)).then(
      () => {
        resolved += 1;
      },
      (error: unknown) => {
        rejected += 1;
        throw error;
      },
    );

    controller.abort();
    worker.emit({ type: 'frame-encoded', frameIndex: 0, sizeBytes: 10 });

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect({ rejected, resolved }).toEqual({ rejected: 1, resolved: 0 });
    expect(worker.terminateCalls).toBe(1);
  });

  it('settles once when acknowledgement wins race against abort', async () => {
    const { client, controller, initialized, worker } = initializedClient();
    await initialized;
    let rejected = 0;
    let resolved = 0;
    const pending = client.encodeFrame(0, new ArrayBuffer(4)).then(
      (response) => {
        resolved += 1;
        return response;
      },
      (error: unknown) => {
        rejected += 1;
        throw error;
      },
    );

    worker.emit({ type: 'frame-encoded', frameIndex: 0, sizeBytes: 10 });
    controller.abort();

    await expect(pending).resolves.toMatchObject({ frameIndex: 0 });
    expect({ rejected, resolved }).toEqual({ rejected: 0, resolved: 1 });
    expect(worker.terminateCalls).toBe(1);
  });

  it('allows sequential requests after each acknowledgement without pending leak', async () => {
    const { client, initialized, worker } = initializedClient();
    await initialized;
    const frame0 = client.encodeFrame(0, new ArrayBuffer(4));
    worker.emit({ type: 'frame-encoded', frameIndex: 0, sizeBytes: 10 });
    await expect(frame0).resolves.toMatchObject({ frameIndex: 0 });

    const frame1 = client.encodeFrame(1, new ArrayBuffer(4));
    worker.emit({ type: 'frame-encoded', frameIndex: 1, sizeBytes: 20 });
    await expect(frame1).resolves.toMatchObject({ frameIndex: 1 });

    const finished = client.finish();
    worker.emit({ type: 'finished', bytes: new ArrayBuffer(3) });
    await expect(finished).resolves.toMatchObject({ type: 'finished' });
    expect(worker.posted.map(({ type }) => type)).toEqual([
      'initialize',
      'encode-frame',
      'encode-frame',
      'finish',
    ]);
    client.terminate();
    expect(worker.terminateCalls).toBe(1);
  });
});
