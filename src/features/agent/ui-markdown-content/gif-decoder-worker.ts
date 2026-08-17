import { decodeGifFrames } from './gif-decoder-core';

export type GifDecoderWorkerRequest = {
  type: 'decode';
  requestId: number;
  buffer: ArrayBuffer;
};

export type GifDecoderWorkerResponse =
  | {
      type: 'decoded';
      requestId: number;
      width: number;
      height: number;
      frames: ArrayBuffer[];
    }
  | { type: 'error'; requestId: number; message: string };

export function handleGifDecoderWorkerRequest(
  request: GifDecoderWorkerRequest,
): GifDecoderWorkerResponse {
  try {
    if (
      request?.type !== 'decode' ||
      !Number.isInteger(request.requestId) ||
      !(request.buffer instanceof ArrayBuffer)
    ) {
      throw new Error('GIF decoder worker received an invalid request');
    }
    return { type: 'decoded', requestId: request.requestId, ...decodeGifFrames(request.buffer) };
  } catch (error) {
    return {
      type: 'error',
      requestId: Number.isInteger(request?.requestId) ? request.requestId : -1,
      message: error instanceof Error ? error.message : 'GIF decoder worker failed unexpectedly',
    };
  }
}

const workerScope = globalThis as typeof globalThis & {
  document?: Document;
  postMessage?: (message: unknown, transfer?: Transferable[]) => void;
};

if (typeof workerScope.postMessage === 'function' && !workerScope.document) {
  globalThis.addEventListener('message', (event: MessageEvent<GifDecoderWorkerRequest>) => {
    const response = handleGifDecoderWorkerRequest(event.data);
    const transfer = response.type === 'decoded' ? response.frames : undefined;
    workerScope.postMessage?.(response, transfer);
  });
}
