export const MAX_GIF_RETAINED_FRAME_MEMORY_BYTES = 96 * 1024 * 1024;
export const MAX_GIF_ESTIMATED_PEAK_MEMORY_BYTES = 128 * 1024 * 1024;
// Account for transferred source bytes plus two conservative parser copies.
export const GIF_SOURCE_MEMORY_MULTIPLIER = 3;
export const MAX_GIF_SOURCE_MEMORY_BYTES = Math.floor(
  MAX_GIF_ESTIMATED_PEAK_MEMORY_BYTES / GIF_SOURCE_MEMORY_MULTIPLIER,
);
export const MAX_GIF_SCRUB_FRAMES = 240;
export const MAX_GIF_CANVAS_PIXELS = 10_000_000;
export const MAX_GIF_FRAME_PATCH_PIXELS = 4_000_000;
// Reject metadata bombs made from tiny records independently of source size.
export const MAX_GIF_BLOCK_RECORDS = 100_000;
export const MAX_GIF_EXTENSION_BLOCKS = 4_096;
export const GIF_BLOCK_METADATA_OVERHEAD_BYTES = 256;
