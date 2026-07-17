import {
  MAX_GIF_BLOCK_RECORDS,
  MAX_GIF_CANVAS_PIXELS,
  MAX_GIF_EXTENSION_BLOCKS,
  MAX_GIF_FRAME_PATCH_PIXELS,
  MAX_GIF_SCRUB_FRAMES,
  MAX_GIF_SOURCE_MEMORY_BYTES,
} from './gif-decoder-limits';

export type GifBinaryPreflight = {
  width: number;
  height: number;
  frameCount: number;
  maxFramePatchPixels: number;
  blockRecordCount: number;
};

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

export function preflightGifBinary(buffer: ArrayBuffer): GifBinaryPreflight {
  if (buffer.byteLength === 0) throw new Error('GIF source is empty');
  if (buffer.byteLength > MAX_GIF_SOURCE_MEMORY_BYTES) {
    throw new Error('GIF source exceeds safe memory budget');
  }
  const bytes = new Uint8Array(buffer);
  const requireBytes = (offset: number, length: number) => {
    if (offset < 0 || length < 0 || offset > bytes.length - length) {
      throw new Error('GIF is malformed or truncated');
    }
  };
  requireBytes(0, 13);
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  if (signature !== 'GIF87a' && signature !== 'GIF89a') {
    throw new Error('GIF has an invalid header');
  }

  const width = readUint16(bytes, 6);
  const height = readUint16(bytes, 8);
  if (
    width <= 0 ||
    height <= 0 ||
    !Number.isSafeInteger(width * height) ||
    width * height > MAX_GIF_CANVAS_PIXELS
  ) {
    throw new Error('GIF is too large to scrub safely');
  }

  let offset = 13;
  const globalColorTableBytes =
    bytes[10] & 0x80 ? 3 * 2 ** ((bytes[10] & 0x07) + 1) : 0;
  requireBytes(offset, globalColorTableBytes);
  offset += globalColorTableBytes;

  let blockRecordCount = 0;
  let extensionCount = 0;
  let frameCount = 0;
  let maxFramePatchPixels = 0;
  let sawTrailer = false;
  const countRecord = () => {
    blockRecordCount += 1;
    if (blockRecordCount > MAX_GIF_BLOCK_RECORDS) {
      throw new Error('GIF has too many block records');
    }
  };
  const consumeSubblocks = () => {
    let dataBytes = 0;
    while (true) {
      requireBytes(offset, 1);
      const length = bytes[offset];
      offset += 1;
      countRecord();
      if (length === 0) return dataBytes;
      requireBytes(offset, length);
      offset += length;
      dataBytes += length;
    }
  };

  while (offset < bytes.length) {
    requireBytes(offset, 1);
    const introducer = bytes[offset];
    offset += 1;
    countRecord();
    if (introducer === 0x3b) {
      sawTrailer = true;
      if (offset !== bytes.length) {
        throw new Error('GIF contains data after its trailer');
      }
      break;
    }
    if (introducer === 0x21) {
      extensionCount += 1;
      if (extensionCount > MAX_GIF_EXTENSION_BLOCKS) {
        throw new Error('GIF has too many extension blocks');
      }
      requireBytes(offset, 1);
      offset += 1;
      consumeSubblocks();
      continue;
    }
    if (introducer !== 0x2c) {
      throw new Error('GIF contains an invalid block');
    }

    frameCount += 1;
    if (frameCount > MAX_GIF_SCRUB_FRAMES) {
      throw new Error(`GIF has too many frames (${frameCount})`);
    }
    requireBytes(offset, 9);
    const left = readUint16(bytes, offset);
    const top = readUint16(bytes, offset + 2);
    const frameWidth = readUint16(bytes, offset + 4);
    const frameHeight = readUint16(bytes, offset + 6);
    const packed = bytes[offset + 8];
    offset += 9;
    if (
      frameWidth <= 0 ||
      frameHeight <= 0 ||
      left > width - frameWidth ||
      top > height - frameHeight
    ) {
      throw new Error('GIF frame lies outside logical screen');
    }
    const framePixels = frameWidth * frameHeight;
    if (
      !Number.isSafeInteger(framePixels) ||
      framePixels > MAX_GIF_FRAME_PATCH_PIXELS
    ) {
      throw new Error('GIF frame is too large to scrub safely');
    }
    maxFramePatchPixels = Math.max(maxFramePatchPixels, framePixels);
    const localColorTableBytes =
      packed & 0x80 ? 3 * 2 ** ((packed & 0x07) + 1) : 0;
    requireBytes(offset, localColorTableBytes + 1);
    offset += localColorTableBytes;
    const minCodeSize = bytes[offset];
    offset += 1;
    if (minCodeSize < 2 || minCodeSize > 8) {
      throw new Error('GIF has an invalid LZW minimum code size');
    }
    if (consumeSubblocks() === 0) {
      throw new Error('GIF image has no compressed data');
    }
  }

  if (!sawTrailer) throw new Error('GIF is malformed or truncated');
  if (frameCount === 0) throw new Error('GIF has no image frames');
  return { width, height, frameCount, maxFramePatchPixels, blockRecordCount };
}
