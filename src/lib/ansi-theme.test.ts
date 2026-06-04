import { describe, expect, it } from 'vitest';

import { ansiClassToThemeColor } from './ansi-theme';

describe('ansiClassToThemeColor', () => {
  it('maps Anser classes to theme CSS variables', () => {
    expect(ansiClassToThemeColor('ansi-red')).toBe('var(--theme-ansi-red)');
    expect(ansiClassToThemeColor('ansi-bright-green')).toBe(
      'var(--theme-ansi-bright-green)',
    );
  });

  it('returns undefined for unknown classes', () => {
    expect(ansiClassToThemeColor('unknown')).toBeUndefined();
  });
});
