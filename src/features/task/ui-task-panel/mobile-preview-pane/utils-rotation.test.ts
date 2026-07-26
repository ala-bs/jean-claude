import { describe, expect, it } from 'vitest';

import {
  mapRotatedSurfacePoint,
  normalizeRotationDegrees,
} from './utils-rotation';

describe('mobile preview rotation utils', () => {
  it('normalizes rotation degrees', () => {
    expect(normalizeRotationDegrees(0)).toBe(0);
    expect(normalizeRotationDegrees(450)).toBe(90);
    expect(normalizeRotationDegrees(-90)).toBe(270);
  });

  it('maps displayed points back to source coordinates for each rotation', () => {
    const size = { width: 100, height: 200 };

    expect(
      mapRotatedSurfacePoint({ x: 10, y: 20, ...size, rotationDegrees: 0 }),
    ).toEqual({ x: 10, y: 20 });

    expect(
      mapRotatedSurfacePoint({ x: 180, y: 10, ...size, rotationDegrees: 90 }),
    ).toEqual({ x: 10, y: 20 });

    expect(
      mapRotatedSurfacePoint({
        x: 90,
        y: 180,
        ...size,
        rotationDegrees: 180,
      }),
    ).toEqual({ x: 10, y: 20 });

    expect(
      mapRotatedSurfacePoint({ x: 20, y: 90, ...size, rotationDegrees: 270 }),
    ).toEqual({ x: 10, y: 20 });
  });
});
