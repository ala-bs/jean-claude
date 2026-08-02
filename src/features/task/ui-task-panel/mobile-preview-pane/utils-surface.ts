export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

// A <canvas> reports 300x150 until a frame sets its intrinsic size. That default
// is landscape and would wrongly flip a portrait session, so treat it as unknown.
export const DEFAULT_CANVAS_WIDTH = 300;
export const DEFAULT_CANVAS_HEIGHT = 150;

export function getSurfaceIntrinsicSize(
  surface: HTMLImageElement | HTMLCanvasElement | null,
): { width: number; height: number } | null {
  if (!surface) return null;
  if (surface instanceof HTMLImageElement) {
    if (!surface.naturalWidth || !surface.naturalHeight) return null;
    return { width: surface.naturalWidth, height: surface.naturalHeight };
  }
  if (!surface.width || !surface.height) return null;
  if (
    surface.width === DEFAULT_CANVAS_WIDTH &&
    surface.height === DEFAULT_CANVAS_HEIGHT
  ) {
    return null;
  }
  return { width: surface.width, height: surface.height };
}
