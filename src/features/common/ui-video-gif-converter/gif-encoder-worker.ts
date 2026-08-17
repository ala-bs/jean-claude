import { applyPalette, GIFEncoder, quantize } from 'gifenc';

export type GifEncoderWorkerRequest =
  | {
      type: 'initialize';
      width: number;
      height: number;
      colors: number;
      delay: number;
    }
  | { type: 'encode-frame'; frameIndex: number; rgba: ArrayBuffer }
  | { type: 'finish' };

export type GifEncoderWorkerResponse =
  | { type: 'initialized' }
  | { type: 'frame-encoded'; frameIndex: number; sizeBytes: number }
  | { type: 'finished'; bytes: ArrayBuffer }
  | { type: 'error'; message: string };

export function createGifEncoderStateMachine({
  createEncoder = GIFEncoder,
  quantizePixels = quantize,
  applyPixelPalette = applyPalette,
}: {
  createEncoder?: typeof GIFEncoder;
  quantizePixels?: typeof quantize;
  applyPixelPalette?: typeof applyPalette;
} = {}) {
  let config:
    | {
        width: number;
        height: number;
        colors: number;
        delay: number;
      }
    | undefined;
  let encoder: ReturnType<typeof GIFEncoder> | undefined;
  let nextFrameIndex = 0;

  const handleMessage = (
    message: GifEncoderWorkerRequest,
  ): GifEncoderWorkerResponse => {
    try {
      if (message.type === 'initialize') {
        config = message;
        encoder = createEncoder();
        nextFrameIndex = 0;
        return { type: 'initialized' };
      }

      if (!config || !encoder) {
        throw new Error('GIF encoder worker was not initialized.');
      }

      if (message.type === 'encode-frame') {
        if (message.frameIndex !== nextFrameIndex) {
          throw new Error(
            `GIF frame arrived out of order: expected ${nextFrameIndex}, received ${message.frameIndex}.`,
          );
        }
        if (message.rgba.byteLength !== config.width * config.height * 4) {
          throw new Error('GIF frame pixel buffer has an unexpected size.');
        }
        const pixels = new Uint8ClampedArray(message.rgba);
        const palette = quantizePixels(pixels, config.colors);
        const indexed = applyPixelPalette(pixels, palette);
        encoder.writeFrame(indexed, config.width, config.height, {
          palette,
          delay: config.delay,
        });
        const sizeBytes = encoder.bytesView().byteLength;
        nextFrameIndex += 1;
        return {
          type: 'frame-encoded',
          frameIndex: message.frameIndex,
          sizeBytes,
        };
      }

      encoder.finish();
      const bytesView = encoder.bytesView();
      const bytes = bytesView.slice().buffer;
      return { type: 'finished', bytes };
    } catch (error) {
      return {
        type: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'GIF encoder worker failed unexpectedly.',
      };
    }
  };

  return { handleMessage };
}

const workerScope = globalThis as typeof globalThis & {
  document?: Document;
  postMessage?: (message: unknown, transfer?: Transferable[]) => void;
};

if (typeof workerScope.postMessage === 'function' && !workerScope.document) {
  const stateMachine = createGifEncoderStateMachine();
  globalThis.addEventListener('message', (event: MessageEvent) => {
    const response = stateMachine.handleMessage(
      event.data as GifEncoderWorkerRequest,
    );
    const transfer = response.type === 'finished' ? [response.bytes] : undefined;
    workerScope.postMessage?.(response, transfer);
  });
}
