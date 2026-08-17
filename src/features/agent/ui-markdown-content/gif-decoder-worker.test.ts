import { describe, expect, it } from 'vitest';
import { GIFEncoder } from 'gifenc';

import { handleGifDecoderWorkerRequest } from './gif-decoder-worker';

function createDeterministicGif(): ArrayBuffer {
  const encoder = GIFEncoder();
  const palette = [
    [255, 0, 0],
    [0, 0, 255],
    [0, 255, 0],
  ] as never;
  encoder.writeFrame(new Uint8Array([1, 1]), 2, 1, {
    palette,
    delay: 100,
    dispose: 2,
  } as never);
  encoder.writeFrame(new Uint8Array([0, 2]), 2, 1, {
    palette,
    delay: 100,
    dispose: 3,
  } as never);
  encoder.writeFrame(new Uint8Array([2, 1]), 2, 1, {
    palette,
    delay: 100,
    transparent: true,
    transparentIndex: 2,
  } as never);
  encoder.finish();
  return encoder.bytesView().slice().buffer;
}

describe('GIF decoder worker', () => {
  it('parses and decompresses a real GIF into ordered full RGBA frames', () => {
    const response = handleGifDecoderWorkerRequest({
      type: 'decode',
      requestId: 7,
      buffer: createDeterministicGif(),
    });

    expect(response.type).toBe('decoded');
    if (response.type !== 'decoded') return;
    expect(response).toMatchObject({ requestId: 7, width: 2, height: 1 });
    expect(response.frames).toHaveLength(3);
    expect(Array.from(new Uint8ClampedArray(response.frames[0]))).toEqual([
      0, 0, 255, 255, 0, 0, 255, 255,
    ]);
    expect(Array.from(new Uint8ClampedArray(response.frames[1]))).toEqual([
      255, 0, 0, 255, 0, 255, 0, 255,
    ]);
    expect(Array.from(new Uint8ClampedArray(response.frames[2]))).toEqual([
      255, 0, 0, 255, 0, 0, 255, 255,
    ]);
  });

  it('returns protocol errors instead of throwing', () => {
    const response = handleGifDecoderWorkerRequest({
      type: 'decode',
      requestId: 1,
      buffer: new ArrayBuffer(1),
    });
    expect(response).toMatchObject({ type: 'error', requestId: 1 });
  });
});
