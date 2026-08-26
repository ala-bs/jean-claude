import { describe, expect, it } from 'vitest';

import { hexToRgba, PROJECT_COLORS } from './colors';

describe('hexToRgba', () => {
  it('converts a hex swatch to a translucent rgba', () => {
    expect(hexToRgba('#5865F2', 0.18)).toBe('rgba(88, 101, 242, 0.18)');
  });

  it('handles black without dropping channels', () => {
    expect(hexToRgba('#000000', 1)).toBe('rgba(0, 0, 0, 1)');
  });

  it('is case-insensitive and tolerates surrounding space', () => {
    expect(hexToRgba('  #ffffff ', 0.5)).toBe('rgba(255, 255, 255, 0.5)');
  });

  it('passes a non-hex value through rather than emitting invalid css', () => {
    // A hand-edited settings value must not blank out the row background.
    expect(hexToRgba('rebeccapurple', 0.2)).toBe('rebeccapurple');
    expect(hexToRgba('#fff', 0.2)).toBe('#fff');
  });

  it('converts every palette color', () => {
    for (const color of PROJECT_COLORS) {
      expect(hexToRgba(color, 0.18)).toMatch(
        /^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, 0\.18\)$/,
      );
    }
  });
});
