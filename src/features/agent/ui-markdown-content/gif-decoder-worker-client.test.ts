import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decodeGifFramesInWorker } from './gif-decoder-worker-client';
import type { GifDecoderWorkerResponse } from './gif-decoder-worker';

class ControlledWorker {
  static constructorError: Error | undefined;
  static instances: ControlledWorker[] = [];
  static postMessageError: Error | undefined;

  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent<GifDecoderWorkerResponse>) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  postedBuffer: ArrayBuffer | undefined;
  terminateCalls = 0;

  constructor() {
    if (ControlledWorker.constructorError) throw ControlledWorker.constructorError;
    ControlledWorker.instances.push(this);
  }

  postMessage(message: { buffer: ArrayBuffer }, transfer: Transferable[]) {
    if (ControlledWorker.postMessageError) throw ControlledWorker.postMessageError;
    this.postedBuffer = message.buffer;
    structuredClone(message, { transfer });
  }

  emit(response: GifDecoderWorkerResponse) {
    this.onmessage?.({ data: response } as MessageEvent<GifDecoderWorkerResponse>);
  }

  terminate() {
    this.terminateCalls += 1;
  }
}

describe('GIF decoder worker client', () => {
  beforeEach(() => {
    ControlledWorker.constructorError = undefined;
    ControlledWorker.instances = [];
    ControlledWorker.postMessageError = undefined;
    vi.stubGlobal('Worker', ControlledWorker);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('transfers and detaches compressed source bytes', () => {
    const source = new ArrayBuffer(8);
    const pending = decodeGifFramesInWorker(source, new AbortController().signal);
    expect(source.byteLength).toBe(0);
    ControlledWorker.instances[0].emit({
      type: 'decoded',
      requestId: 1,
      width: 1,
      height: 1,
      frames: [new ArrayBuffer(4)],
    });
    return expect(pending).resolves.toMatchObject({ width: 1, height: 1 });
  });

  it('terminates immediately and rejects exactly once on cancellation', async () => {
    const controller = new AbortController();
    let settlements = 0;
    const pending = decodeGifFramesInWorker(new ArrayBuffer(8), controller.signal).finally(
      () => {
        settlements += 1;
      },
    );
    const worker = ControlledWorker.instances[0];
    const staleHandler = worker.onmessage;
    controller.abort();
    staleHandler?.({
      data: { type: 'decoded', requestId: 1, width: 1, height: 1, frames: [new ArrayBuffer(4)] },
    } as MessageEvent<GifDecoderWorkerResponse>);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(settlements).toBe(1);
    expect(worker.terminateCalls).toBe(1);
  });

  it('rejects stale response IDs and closes worker', async () => {
    const pending = decodeGifFramesInWorker(new ArrayBuffer(8), new AbortController().signal);
    const worker = ControlledWorker.instances[0];
    worker.emit({ type: 'error', requestId: 2, message: 'late' });
    await expect(pending).rejects.toThrow('stale or invalid');
    expect(worker.terminateCalls).toBe(1);
  });

  it('handles constructor, postMessage, worker, and message errors', async () => {
    ControlledWorker.constructorError = new Error('blocked');
    expect(() => decodeGifFramesInWorker(new ArrayBuffer(1), new AbortController().signal)).toThrow('blocked');

    ControlledWorker.constructorError = undefined;
    ControlledWorker.postMessageError = new Error('clone failed');
    await expect(decodeGifFramesInWorker(new ArrayBuffer(1), new AbortController().signal)).rejects.toThrow('clone failed');

    ControlledWorker.postMessageError = undefined;
    const crashed = decodeGifFramesInWorker(new ArrayBuffer(1), new AbortController().signal);
    ControlledWorker.instances.at(-1)?.onerror?.({ message: 'crashed', preventDefault: vi.fn() } as unknown as ErrorEvent);
    await expect(crashed).rejects.toThrow('crashed');

    const unreadable = decodeGifFramesInWorker(new ArrayBuffer(1), new AbortController().signal);
    ControlledWorker.instances.at(-1)?.onmessageerror?.({} as MessageEvent);
    await expect(unreadable).rejects.toThrow('unreadable');
  });

  it('rejects malformed decoded buffers', async () => {
    const pending = decodeGifFramesInWorker(new ArrayBuffer(8), new AbortController().signal);
    ControlledWorker.instances[0].emit({
      type: 'decoded', requestId: 1, width: 2, height: 1, frames: [new ArrayBuffer(4)],
    });
    await expect(pending).rejects.toThrow('invalid response');
  });

  it('rejects malformed worker error payloads', async () => {
    const pending = decodeGifFramesInWorker(
      new ArrayBuffer(8),
      new AbortController().signal,
    );
    ControlledWorker.instances[0].emit({
      type: 'error',
      requestId: 1,
      message: '',
    });
    await expect(pending).rejects.toThrow('invalid response');
  });
});
