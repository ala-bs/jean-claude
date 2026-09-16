// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

import { resolveCssColor } from './theme';

/**
 * happy-dom has no real canvas, so the browser's color parsing is modelled
 * here: assigning an unparseable value leaves `fillStyle` untouched (matching
 * the spec), and the painted pixel is whatever the last valid assignment was.
 */
function stubCanvas(known: Record<string, [number, number, number]>) {
  let current: [number, number, number] = [0, 0, 0];
  let fillStyle = '';
  const context = {
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value: string) {
      const rgb = known[value];
      if (!rgb) return; // Invalid color: assignment is a silent no-op.
      fillStyle = value;
      current = rgb;
    },
    fillRect: () => {},
    getImageData: () => ({ data: [...current, 255] }),
  };
  vi.spyOn(document, 'createElement').mockReturnValue({
    width: 0,
    height: 0,
    getContext: () => context,
  } as unknown as HTMLCanvasElement);
}

describe('resolveCssColor', () => {
  it('converts a color xterm cannot parse into hex', () => {
    stubCanvas({
      '#ff00ff': [255, 0, 255],
      '#00ff00': [0, 255, 0],
      'oklch(0.14 0.012 275)': [17, 18, 26],
    });
    expect(resolveCssColor('oklch(0.14 0.012 275)', '#000000')).toBe('#11121a');
  });

  it('falls back when the value is not a color at all', () => {
    stubCanvas({ '#ff00ff': [255, 0, 255], '#00ff00': [0, 255, 0] });
    expect(resolveCssColor('not-a-color', '#abcdef')).toBe('#abcdef');
  });

  it('falls back on an empty or whitespace value', () => {
    stubCanvas({});
    expect(resolveCssColor('', '#abcdef')).toBe('#abcdef');
    expect(resolveCssColor('   ', '#abcdef')).toBe('#abcdef');
  });

  it('resolves a color that happens to equal a sentinel', () => {
    // A single-sentinel probe would read "unchanged" as "invalid" and fall
    // back, silently losing a legitimate magenta token.
    stubCanvas({ '#ff00ff': [255, 0, 255], '#00ff00': [0, 255, 0] });
    expect(resolveCssColor('#ff00ff', '#000000')).toBe('#ff00ff');
    expect(resolveCssColor('#00ff00', '#000000')).toBe('#00ff00');
  });

  it('pads single-digit channels so the hex is always six characters', () => {
    stubCanvas({
      '#ff00ff': [255, 0, 255],
      '#00ff00': [0, 255, 0],
      dim: [1, 2, 3],
    });
    expect(resolveCssColor('dim', '#000000')).toBe('#010203');
  });
});
