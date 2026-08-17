import { describe, expect, it } from 'vitest';

import {
  clampBoardWidth,
  createBoardResize,
  getKeyboardBoardWidth,
} from '@/features/work-item/ui-azure-board-overlay/board-split-pane-utils';

describe('board split pane sizing', () => {
  it('clamps calculated pointer widths to the board range', () => {
    const resize = createBoardResize(55);

    expect(resize.move({ clientX: 10, containerLeft: 20, containerWidth: 100 })).toBe(30);
    expect(resize.move({ clientX: 70, containerLeft: 20, containerWidth: 100 })).toBe(50);
    expect(resize.move({ clientX: 120, containerLeft: 20, containerWidth: 100 })).toBe(80);
    expect(clampBoardWidth(55)).toBe(55);
  });

  it('finishes exactly once across duplicate terminal events', () => {
    const resize = createBoardResize(55);
    resize.move({ clientX: 75, containerLeft: 0, containerWidth: 100 });

    expect(resize.finish()).toBe(75);
    expect(resize.finish()).toBeNull();
  });

  it.each(['window blur', 'unmount'])('supports one %s-equivalent finish', () => {
    const resize = createBoardResize(60);

    expect(resize.finish()).toBe(60);
    expect(resize.finish()).toBeNull();
  });

  it('maps keyboard arrows to board-width direction and bounds', () => {
    expect(getKeyboardBoardWidth(50, 'ArrowLeft')).toBe(48);
    expect(getKeyboardBoardWidth(50, 'ArrowRight')).toBe(52);
    expect(getKeyboardBoardWidth(30, 'ArrowLeft')).toBe(30);
    expect(getKeyboardBoardWidth(80, 'ArrowRight')).toBe(80);
    expect(getKeyboardBoardWidth(50, 'Enter')).toBeNull();
  });
});
