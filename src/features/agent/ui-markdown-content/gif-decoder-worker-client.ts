import {
  MAX_GIF_CANVAS_PIXELS,
  MAX_GIF_RETAINED_FRAME_MEMORY_BYTES,
  MAX_GIF_SCRUB_FRAMES,
} from './gif-decoder-limits';
import type { GifDecoderWorkerResponse } from './gif-decoder-worker';

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('GIF decoding cancelled', 'AbortError');
}

export function decodeGifFramesInWorker(
  buffer: ArrayBuffer,
  signal: AbortSignal,
): Promise<{ width: number; height: number; frames: ArrayBuffer[] }> {
  signal.throwIfAborted();
  const worker = new Worker(new URL('./gif-decoder-worker.ts', import.meta.url), {
    type: 'module',
  });
  const requestId = 1;

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (
      outcome:
        | { result: { width: number; height: number; frames: ArrayBuffer[] } }
        | { error: Error },
    ) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      if ('result' in outcome) resolve(outcome.result);
      else reject(outcome.error);
    };
    const fail = (message: string) => settle({ error: new Error(message) });
    const onAbort = () => settle({ error: abortReason(signal) });
    signal.addEventListener('abort', onAbort, { once: true });

    worker.onmessage = (event: MessageEvent<GifDecoderWorkerResponse>) => {
      const response = event.data;
      if (!response || response.requestId !== requestId) {
        fail('GIF decoder worker returned a stale or invalid response');
        return;
      }
      if (response.type === 'error') {
        if (typeof response.message !== 'string' || !response.message) {
          fail('GIF decoder worker returned an invalid response');
          return;
        }
        fail(response.message);
        return;
      }
      if (
        response.type !== 'decoded' ||
        !Number.isInteger(response.width) ||
        !Number.isInteger(response.height) ||
        response.width <= 0 ||
        response.height <= 0 ||
        response.width * response.height > MAX_GIF_CANVAS_PIXELS ||
        !Array.isArray(response.frames) ||
        response.frames.length === 0 ||
        response.frames.length > MAX_GIF_SCRUB_FRAMES ||
        response.frames.some(
          (frame) =>
            !(frame instanceof ArrayBuffer) ||
            frame.byteLength !== response.width * response.height * 4,
        ) ||
        response.frames.reduce((total, frame) => total + frame.byteLength, 0) >
          MAX_GIF_RETAINED_FRAME_MEMORY_BYTES
      ) {
        fail('GIF decoder worker returned an invalid response');
        return;
      }
      settle({
        result: {
          width: response.width,
          height: response.height,
          frames: response.frames,
        },
      });
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fail(event.message || 'GIF decoder worker crashed');
    };
    worker.onmessageerror = () => fail('GIF decoder worker returned an unreadable response');

    try {
      worker.postMessage({ type: 'decode', requestId, buffer }, [buffer]);
    } catch (error) {
      settle({
        error:
          error instanceof Error
            ? error
            : new Error('Failed to send GIF to decoder worker'),
      });
    }
  });
}
