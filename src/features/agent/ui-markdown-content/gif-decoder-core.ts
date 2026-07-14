import { decompressFrame, type ParsedFrame, parseGIF } from 'gifuct-js';

import {
  GIF_BLOCK_METADATA_OVERHEAD_BYTES,
  GIF_SOURCE_MEMORY_MULTIPLIER,
  MAX_GIF_CANVAS_PIXELS,
  MAX_GIF_ESTIMATED_PEAK_MEMORY_BYTES,
  MAX_GIF_FRAME_PATCH_PIXELS,
  MAX_GIF_RETAINED_FRAME_MEMORY_BYTES,
  MAX_GIF_SCRUB_FRAMES,
} from './gif-decoder-limits';
import { preflightGifBinary } from './gif-binary-preflight';
const GIF_FULL_SCREEN_WORKING_BYTES_PER_PIXEL = 8;
// gifuct uses number[] for LZW output and may duplicate it for deinterlacing.
const GIF_PATCH_WORKING_BYTES_PER_PIXEL = 28;
const GIF_LZW_TABLE_OVERHEAD_BYTES = 128 * 1024;

type GifFrame = Parameters<typeof decompressFrame>[0];

type DecodedGifFrames = {
  width: number;
  height: number;
  frames: ArrayBuffer[];
};

export function calculateGifFrameMemoryBytes({
  width,
  height,
  frameCount,
  maxFramePatchPixels,
  sourceBytes = 0,
  blockRecordCount = 0,
}: {
  width: number;
  height: number;
  frameCount: number;
  maxFramePatchPixels: number;
  sourceBytes?: number;
  blockRecordCount?: number;
}): { retainedBytes: number; estimatedPeakBytes: number } {
  const canvasPixels = width * height;
  const retainedRgbaBytes = canvasPixels * frameCount * 4;
  const transientBytes =
    canvasPixels * GIF_FULL_SCREEN_WORKING_BYTES_PER_PIXEL +
    maxFramePatchPixels * GIF_PATCH_WORKING_BYTES_PER_PIXEL +
    GIF_LZW_TABLE_OVERHEAD_BYTES +
    sourceBytes * GIF_SOURCE_MEMORY_MULTIPLIER +
    blockRecordCount * GIF_BLOCK_METADATA_OVERHEAD_BYTES;
  if (
    !Number.isSafeInteger(retainedRgbaBytes) ||
    !Number.isSafeInteger(transientBytes)
  ) {
    return {
      retainedBytes: Number.POSITIVE_INFINITY,
      estimatedPeakBytes: Number.POSITIVE_INFINITY,
    };
  }

  return {
    retainedBytes: retainedRgbaBytes,
    estimatedPeakBytes: retainedRgbaBytes + transientBytes,
  };
}

export function validateGifFrameMemory(params: {
  width: number;
  height: number;
  frameCount: number;
  maxFramePatchPixels: number;
  sourceBytes?: number;
  blockRecordCount?: number;
}): { retainedBytes: number; estimatedPeakBytes: number } {
  const {
    width,
    height,
    frameCount,
    maxFramePatchPixels,
    sourceBytes = 0,
    blockRecordCount = 0,
  } = params;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    !Number.isInteger(frameCount) ||
    !Number.isInteger(maxFramePatchPixels) ||
    !Number.isInteger(sourceBytes) ||
    !Number.isInteger(blockRecordCount) ||
    width <= 0 ||
    height <= 0 ||
    frameCount <= 0 ||
    maxFramePatchPixels <= 0 ||
    sourceBytes < 0 ||
    blockRecordCount < 0
  ) {
    throw new Error('GIF has invalid frame dimensions or count');
  }

  const memory = calculateGifFrameMemoryBytes(params);
  if (memory.retainedBytes > MAX_GIF_RETAINED_FRAME_MEMORY_BYTES) {
    throw new Error('GIF retained frames exceed safe memory budget');
  }
  if (memory.estimatedPeakBytes > MAX_GIF_ESTIMATED_PEAK_MEMORY_BYTES) {
    throw new Error('GIF estimated peak memory exceeds safe budget');
  }
  return memory;
}

export function validateGifFrameDescriptor({
  left,
  top,
  width,
  height,
  logicalWidth,
  logicalHeight,
}: {
  left: number;
  top: number;
  width: number;
  height: number;
  logicalWidth: number;
  logicalHeight: number;
}): void {
  if (
    !Number.isInteger(left) ||
    !Number.isInteger(top) ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    left < 0 ||
    top < 0 ||
    width <= 0 ||
    height <= 0 ||
    left > logicalWidth - width ||
    top > logicalHeight - height
  ) {
    throw new Error('GIF frame lies outside logical screen');
  }
}

function fillRgbaRect({
  pixels,
  canvasWidth,
  left,
  top,
  width,
  height,
  color,
}: {
  pixels: Uint8ClampedArray;
  canvasWidth: number;
  left: number;
  top: number;
  width: number;
  height: number;
  color: readonly [number, number, number, number];
}) {
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
      pixels.set(color, (y * canvasWidth + x) * 4);
    }
  }
}

export function composeGifFrameRgba({
  screen,
  frame,
  backgroundColor,
  canvasWidth,
}: {
  screen: Uint8ClampedArray;
  frame: ParsedFrame;
  backgroundColor: readonly [number, number, number, number] | null;
  canvasWidth: number;
}): Uint8ClampedArray<ArrayBuffer> {
  const previous = frame.disposalType === 3 ? screen.slice() : null;
  for (let y = 0; y < frame.dims.height; y += 1) {
    for (let x = 0; x < frame.dims.width; x += 1) {
      const patchOffset = (y * frame.dims.width + x) * 4;
      if (frame.patch[patchOffset + 3] === 0) continue;
      const screenOffset =
        ((frame.dims.top + y) * canvasWidth + frame.dims.left + x) * 4;
      screen.set(frame.patch.subarray(patchOffset, patchOffset + 4), screenOffset);
    }
  }

  const rendered = screen.slice();
  if (frame.disposalType === 2) {
    fillRgbaRect({
      pixels: screen,
      canvasWidth,
      left: frame.dims.left,
      top: frame.dims.top,
      width: frame.dims.width,
      height: frame.dims.height,
      color: backgroundColor ?? [0, 0, 0, 0],
    });
  } else if (previous) {
    screen.set(previous);
  }
  return rendered;
}

export function getGifBackgroundColor({
  colorTable,
  backgroundColorIndex,
  hasGlobalColorTable,
  frame,
}: {
  colorTable: Parameters<typeof decompressFrame>[1];
  backgroundColorIndex: number;
  hasGlobalColorTable: boolean;
  frame: GifFrame;
}): readonly [number, number, number, number] | null {
  const color = hasGlobalColorTable
    ? colorTable[backgroundColorIndex]
    : undefined;
  if (!color) return null;
  const transparentBackground =
    !frame.image.descriptor.lct.exists &&
    frame.gce?.extras.transparentColorGiven &&
    frame.gce.transparentColorIndex === backgroundColorIndex;
  return transparentBackground ? null : [color[0], color[1], color[2], 255];
}

export function decodeGifFrames(buffer: ArrayBuffer): DecodedGifFrames {
  const preflight = preflightGifBinary(buffer);
  validateGifFrameMemory({
    width: preflight.width,
    height: preflight.height,
    frameCount: preflight.frameCount,
    maxFramePatchPixels: preflight.maxFramePatchPixels,
    sourceBytes: buffer.byteLength,
    blockRecordCount: preflight.blockRecordCount,
  });
  const gif = parseGIF(buffer);
  const width = gif.lsd.width;
  const height = gif.lsd.height;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isSafeInteger(width * height) ||
    width * height > MAX_GIF_CANVAS_PIXELS
  ) {
    throw new Error('GIF is too large to scrub safely');
  }

  const imageFrames = gif.frames.filter(
    (frame): frame is GifFrame => 'image' in frame,
  );
  if (imageFrames.length !== preflight.frameCount) {
    throw new Error('GIF parser returned an inconsistent frame count');
  }
  if (imageFrames.length > MAX_GIF_SCRUB_FRAMES) {
    throw new Error(`GIF has too many frames (${imageFrames.length})`);
  }

  for (const frame of imageFrames) {
    const descriptor = frame.image.descriptor;
    validateGifFrameDescriptor({
      left: descriptor.left,
      top: descriptor.top,
      width: descriptor.width,
      height: descriptor.height,
      logicalWidth: width,
      logicalHeight: height,
    });
    const framePixels = descriptor.width * descriptor.height;
    if (!Number.isSafeInteger(framePixels) || framePixels > MAX_GIF_FRAME_PATCH_PIXELS) {
      throw new Error('GIF frame is too large to scrub safely');
    }
  }
  const screen = new Uint8ClampedArray(width * height * 4);
  const frames: ArrayBuffer[] = [];
  for (let index = 0; index < imageFrames.length; index += 1) {
    const sourceFrame = imageFrames[index];
    const frame = decompressFrame(sourceFrame, gif.gct, true);
    if (
      frame.patch.byteLength !== frame.dims.width * frame.dims.height * 4 ||
      frame.dims.left !== sourceFrame.image.descriptor.left ||
      frame.dims.top !== sourceFrame.image.descriptor.top ||
      frame.dims.width !== sourceFrame.image.descriptor.width ||
      frame.dims.height !== sourceFrame.image.descriptor.height
    ) {
      throw new Error('GIF decoder returned an invalid frame patch');
    }
    const backgroundColor = getGifBackgroundColor({
      colorTable: gif.gct,
      backgroundColorIndex: gif.lsd.backgroundColorIndex,
      hasGlobalColorTable: gif.lsd.gct.exists,
      frame: sourceFrame,
    });
    if (index === 0 && backgroundColor) {
      fillRgbaRect({
        pixels: screen,
        canvasWidth: width,
        left: 0,
        top: 0,
        width,
        height,
        color: backgroundColor,
      });
    }
    frames.push(
      composeGifFrameRgba({ screen, frame, backgroundColor, canvasWidth: width })
        .buffer,
    );
  }
  return { width, height, frames };
}
