import { describe, expect, it, vi } from 'vitest';

import { parseGIF } from 'gifuct-js';

import {
  MAX_GIF_BLOCK_RECORDS,
  MAX_GIF_EXTENSION_BLOCKS,
} from './gif-decoder-limits';
import { decodeGifFrames } from './gif-decoder-core';
import { preflightGifBinary } from './gif-binary-preflight';

vi.mock('gifuct-js', () => ({
  decompressFrame: vi.fn(),
  parseGIF: vi.fn(),
}));

function gifWithImageData({
  minCodeSize = 2,
  subblocks = [[0]],
}: {
  minCodeSize?: number;
  subblocks?: number[][];
} = {}): ArrayBuffer {
  const bytes = [
    ...Array.from('GIF89a', (character) => character.charCodeAt(0)),
    1,
    0,
    1,
    0,
    0,
    0,
    0,
    0x2c,
    0,
    0,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    minCodeSize,
  ];
  for (const subblock of subblocks) bytes.push(subblock.length, ...subblock);
  bytes.push(0, 0x3b);
  return new Uint8Array(bytes).buffer;
}

describe('GIF binary preflight', () => {
  it('rejects unsafe LZW minimum code size before gifuct parsing', () => {
    expect(() => decodeGifFrames(gifWithImageData({ minCodeSize: 30 }))).toThrow(
      'invalid LZW minimum code size',
    );
    expect(parseGIF).not.toHaveBeenCalled();
  });

  it('rejects excessive extension blocks', () => {
    const prefix = new Uint8Array(gifWithImageData()).slice(0, 13);
    const extensions = Array.from(
      { length: MAX_GIF_EXTENSION_BLOCKS + 1 },
      () => [0x21, 0xfe, 0],
    ).flat();
    const image = new Uint8Array(gifWithImageData()).slice(13);
    const source = new Uint8Array(prefix.length + extensions.length + image.length);
    source.set(prefix);
    source.set(extensions, prefix.length);
    source.set(image, prefix.length + extensions.length);

    expect(() => preflightGifBinary(source.buffer)).toThrow(
      'too many extension blocks',
    );
  });

  it('rejects truncated subblocks and missing trailer', () => {
    const truncated = new Uint8Array(gifWithImageData()).slice(0, -2);
    expect(() => preflightGifBinary(truncated.buffer)).toThrow(
      'malformed or truncated',
    );
  });

  it('rejects excessive tiny image-data records', () => {
    const subblocks = Array.from(
      { length: MAX_GIF_BLOCK_RECORDS + 1 },
      () => [0],
    );
    expect(() => preflightGifBinary(gifWithImageData({ subblocks }))).toThrow(
      'too many block records',
    );
  });
});
