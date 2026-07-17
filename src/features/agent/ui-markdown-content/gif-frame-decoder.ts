import { decodeGifFramesInWorker } from './gif-decoder-worker-client';
import { MAX_GIF_SOURCE_MEMORY_BYTES } from './gif-decoder-limits';

export type GifFrameImages = {
  images: ImageData[];
  width: number;
  height: number;
};

export async function loadGifArrayBuffer(
  src: string,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abortFetch = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abortFetch, { once: true });
  try {
    const response = await fetch(src, { signal: controller.signal });
    signal.throwIfAborted();
    if (!response.ok) throw new Error(`Failed to load GIF: ${response.status}`);
    const buffer = await readGifResponse(response, controller);
    signal.throwIfAborted();
    return buffer;
  } finally {
    signal.removeEventListener('abort', abortFetch);
  }
}

export async function readGifResponse(
  response: Response,
  controller: AbortController,
): Promise<ArrayBuffer> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_GIF_SOURCE_MEMORY_BYTES
  ) {
    const error = new Error('GIF source exceeds safe memory budget');
    controller.abort(error);
    await response.body?.cancel(error).catch(() => undefined);
    throw error;
  }
  if (!response.body) throw new Error('GIF response body is unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_GIF_SOURCE_MEMORY_BYTES) {
        const error = new Error('GIF source exceeds safe memory budget');
        controller.abort(error);
        await reader.cancel(error).catch(() => undefined);
        throw error;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}

export async function decodeGifFrameImages(
  src: string,
  signal: AbortSignal,
): Promise<GifFrameImages> {
  const buffer = await loadGifArrayBuffer(src, signal);
  signal.throwIfAborted();
  const decoded = await decodeGifFramesInWorker(buffer, signal);
  signal.throwIfAborted();
  return {
    width: decoded.width,
    height: decoded.height,
    images: decoded.frames.map(
      (frame) =>
        new ImageData(
          new Uint8ClampedArray(frame),
          decoded.width,
          decoded.height,
        ),
    ),
  };
}

export function createGifFrameCache({
  decode,
}: {
  decode: (src: string, signal: AbortSignal) => Promise<GifFrameImages>;
}) {
  type CacheEntry = {
    controller: AbortController;
    promise: Promise<GifFrameImages>;
    consumers: number;
    completed: boolean;
  };
  const entries = new Map<string, CacheEntry>();

  return {
    acquire(src: string): { promise: Promise<GifFrameImages>; release: () => void } {
      let entry = entries.get(src);
      if (!entry) {
        const controller = new AbortController();
        entry = {
          controller,
          consumers: 0,
          completed: false,
          promise: Promise.resolve({ images: [], width: 0, height: 0 }),
        };
        const createdEntry = entry;
        entry.promise = decode(src, controller.signal)
          .then((result) => {
            createdEntry.completed = true;
            return result;
          })
          .catch((error: unknown) => {
            if (entries.get(src) === createdEntry) entries.delete(src);
            throw error;
          });
        entries.set(src, entry);
      }

      entry.consumers += 1;
      const acquiredEntry = entry;
      let released = false;
      return {
        promise: entry.promise,
        release: () => {
          if (released) return;
          released = true;
          acquiredEntry.consumers -= 1;
          if (acquiredEntry.consumers === 0) {
            if (entries.get(src) === acquiredEntry) entries.delete(src);
            if (!acquiredEntry.completed) acquiredEntry.controller.abort();
          }
        },
      };
    },
  };
}
