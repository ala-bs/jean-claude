import { decompressFrames, parseGIF } from 'gifuct-js';
import { describe, expect, it, vi } from 'vitest';

import { createGifEncoderStateMachine } from './gif-encoder-worker';

describe('GIF encoder worker state machine', () => {
  it('continues encoding regardless of encoded byte size', () => {
    let sizeBytes = 0;
    const finish = vi.fn();
    const writeFrame = vi.fn(() => {
      sizeBytes = 101;
    });
    const stateMachine = createGifEncoderStateMachine({
      createEncoder: (() => ({
        bytesView: () => new Uint8Array(sizeBytes),
        finish,
        writeFrame,
      })) as never,
      quantizePixels: (() => [[0, 0, 0]]) as never,
      applyPixelPalette: (() => new Uint8Array([0])) as never,
    });

    expect(
      stateMachine.handleMessage({
        type: 'initialize',
        width: 1,
        height: 1,
        colors: 32,
        delay: 42,
      }),
    ).toEqual({ type: 'initialized' });
    expect(
      stateMachine.handleMessage({
        type: 'encode-frame',
        frameIndex: 0,
        rgba: new Uint8ClampedArray([0, 0, 0, 255]).buffer,
      }),
    ).toEqual({ type: 'frame-encoded', frameIndex: 0, sizeBytes: 101 });
    expect(writeFrame).toHaveBeenCalledOnce();
    expect(finish).not.toHaveBeenCalled();
  });

  it('returns a complete decodable GIF', () => {
    const encode = () => {
      const stateMachine = createGifEncoderStateMachine();
      expect(
        stateMachine.handleMessage({
          type: 'initialize',
          width: 2,
          height: 2,
          colors: 4,
          delay: 40,
        }),
      ).toEqual({ type: 'initialized' });
      const frames = [
        new Uint8ClampedArray([
          255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
        ]),
        new Uint8ClampedArray([
          0, 0, 0, 255, 255, 255, 0, 255, 0, 255, 255, 255, 255, 0, 255, 255,
        ]),
      ];
      const frameResponses = frames.map((rgba, frameIndex) =>
        stateMachine.handleMessage({
          type: 'encode-frame',
          frameIndex,
          rgba: rgba.buffer,
        }),
      );
      return {
        finish: () => stateMachine.handleMessage({ type: 'finish' }),
        frameResponses,
      };
    };

    const initial = encode();
    expect(initial.frameResponses.every(({ type }) => type === 'frame-encoded')).toBe(
      true,
    );
    const initialFinish = initial.finish();
    if (initialFinish.type !== 'finished') {
      throw new Error('Expected finished GIF');
    }
    const bytes = new Uint8Array(initialFinish.bytes);
    expect(new TextDecoder().decode(bytes.slice(0, 6))).toBe('GIF89a');
    expect(bytes.at(-1)).toBe(0x3b);
    const decodedFrames = decompressFrames(parseGIF(initialFinish.bytes), true);
    expect(decodedFrames).toHaveLength(2);
    expect(decodedFrames.map(({ dims }) => [dims.width, dims.height])).toEqual([
      [2, 2],
      [2, 2],
    ]);
    expect(decodedFrames.every(({ patch }) => patch.length === 16)).toBe(true);

  });
});
