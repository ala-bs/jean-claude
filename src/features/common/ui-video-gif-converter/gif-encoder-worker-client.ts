import type {
  GifEncoderWorkerRequest,
  GifEncoderWorkerResponse,
} from './gif-encoder-worker';

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Conversion cancelled', 'AbortError');
}

export function createGifEncoderWorkerClient(signal: AbortSignal) {
  signal.throwIfAborted();
  const worker = new Worker(new URL('./gif-encoder-worker.ts', import.meta.url), {
    type: 'module',
  });
  let pending:
    | {
        expectedType: GifEncoderWorkerResponse['type'];
        frameIndex?: number;
        resolve: (response: GifEncoderWorkerResponse) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  let terminated = false;

  const rejectPending = (error: Error) => {
    pending?.reject(error);
    pending = undefined;
  };

  const terminate = (reason?: Error) => {
    if (terminated) return;
    terminated = true;
    signal.removeEventListener('abort', onAbort);
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
    rejectPending(reason ?? new DOMException('GIF worker terminated', 'AbortError'));
  };

  const onAbort = () => terminate(abortReason(signal));
  signal.addEventListener('abort', onAbort, { once: true });

  const fail = (error: Error) => {
    rejectPending(error);
    terminate(error);
  };

  worker.onmessage = (event: MessageEvent<GifEncoderWorkerResponse>) => {
    const response = event.data;
    if (response.type === 'error') {
      fail(new Error(response.message));
      return;
    }
    const request = pending;
    if (
      !request ||
      response.type !== request.expectedType ||
      (response.type === 'frame-encoded' &&
        response.frameIndex !== request.frameIndex)
    ) {
      fail(new Error('GIF encoder worker returned an unexpected response.'));
      return;
    }
    pending = undefined;
    request.resolve(response);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    fail(new Error(event.message || 'GIF encoder worker crashed.'));
  };
  worker.onmessageerror = () => {
    fail(new Error('GIF encoder worker returned an unreadable response.'));
  };

  const request = <T extends GifEncoderWorkerResponse>({
    message,
    expectedType,
    frameIndex,
    transfer,
  }: {
    message: GifEncoderWorkerRequest;
    expectedType: T['type'];
    frameIndex?: number;
    transfer?: Transferable[];
  }) => {
    if (terminated) {
      return Promise.reject(new Error('GIF encoder worker is unavailable.'));
    }
    if (pending) {
      return Promise.reject(
        new Error('GIF encoder worker already has a frame in flight.'),
      );
    }
    return new Promise<T>((resolve, reject) => {
      pending = {
        expectedType,
        frameIndex,
        resolve: (response) => resolve(response as T),
        reject,
      };
      try {
        worker.postMessage(message, transfer ?? []);
      } catch (error) {
        fail(
          error instanceof Error
            ? error
            : new Error('Failed to send data to GIF encoder worker.'),
        );
      }
    });
  };

  return {
    initialize(config: {
      width: number;
      height: number;
      colors: number;
      delay: number;
    }) {
      return request<{ type: 'initialized' }>({
        message: { type: 'initialize', ...config },
        expectedType: 'initialized',
      });
    },
    encodeFrame(frameIndex: number, rgba: ArrayBuffer) {
      return request<{
        type: 'frame-encoded';
        frameIndex: number;
        sizeBytes: number;
      }>({
        message: { type: 'encode-frame', frameIndex, rgba },
        expectedType: 'frame-encoded',
        frameIndex,
        transfer: [rgba],
      });
    },
    finish() {
      return request<{ type: 'finished'; bytes: ArrayBuffer }>({
        message: { type: 'finish' },
        expectedType: 'finished',
      });
    },
    terminate,
  };
}
