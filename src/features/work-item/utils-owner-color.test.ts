import { describe, expect, it } from 'vitest';

import { getOwnerColor, OWNER_COLOR_COUNT } from './utils-owner-color';

describe('getOwnerColor', () => {
  it('provides a 25-color palette', () => {
    expect(OWNER_COLOR_COUNT).toBe(25);
  });

  it('returns the same color for normalized owner names', () => {
    expect(getOwnerColor('Lin Patrick')).toBe(getOwnerColor(' lin patrick '));
    expect(getOwnerColor('Jos\u00e9')).toBe(getOwnerColor('Jose\u0301'));
  });

  it('distributes names across the full palette', () => {
    const colors = new Set(
      Array.from({ length: 250 }, (_, index) => getOwnerColor(`Owner ${index}`)),
    );
    expect(colors.size).toBe(OWNER_COLOR_COUNT);
  });
});
