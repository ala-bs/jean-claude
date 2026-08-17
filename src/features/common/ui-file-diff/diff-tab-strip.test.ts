import { describe, expect, it } from 'vitest';

import { reorderPaths } from './diff-tab-strip';
import { selectionAfterClick } from './utils-selection';

const ROW = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];

describe('selectionAfterClick', () => {
  const click = (overrides: Partial<Parameters<typeof selectionAfterClick>[0]>) =>
    selectionAfterClick({
      rowPaths: ROW,
      path: 'c.ts',
      anchor: null,
      selection: [],
      shiftKey: false,
      toggleKey: false,
      ...overrides,
    });

  it('replaces the selection on a plain click', () => {
    expect(click({ selection: ['a.ts', 'b.ts'] })).toEqual({
      selection: ['c.ts'],
      anchor: 'c.ts',
      activate: true,
    });
  });

  it('extends from the anchor on shift-click', () => {
    expect(click({ anchor: 'a.ts', shiftKey: true }).selection).toEqual([
      'a.ts',
      'b.ts',
      'c.ts',
    ]);
  });

  it('extends backwards when the anchor is after the click', () => {
    expect(
      click({ path: 'b.ts', anchor: 'd.ts', shiftKey: true }).selection,
    ).toEqual(['b.ts', 'c.ts', 'd.ts']);
  });

  it('keeps the anchor across successive shift-clicks', () => {
    const first = click({ anchor: 'a.ts', shiftKey: true });
    const second = click({
      path: 'd.ts',
      anchor: first.anchor,
      selection: first.selection,
      shiftKey: true,
    });
    expect(second.selection).toEqual(ROW);
    expect(second.anchor).toBe('a.ts');
  });

  it('falls back to a plain click when the anchor is gone', () => {
    expect(click({ anchor: 'missing.ts', shiftKey: true })).toEqual({
      selection: ['c.ts'],
      anchor: 'c.ts',
      activate: true,
    });
  });

  it('toggles without activating on meta-click', () => {
    expect(click({ selection: ['a.ts'], toggleKey: true })).toEqual({
      selection: ['a.ts', 'c.ts'],
      anchor: 'c.ts',
      activate: false,
    });
    expect(
      click({ selection: ['a.ts', 'c.ts'], toggleKey: true }).selection,
    ).toEqual(['a.ts']);
  });
});

describe('reorderPaths', () => {
  it('moves a tab before the target', () => {
    expect(reorderPaths(ROW, ['d.ts'], 'b.ts', 'before')).toEqual([
      'a.ts',
      'd.ts',
      'b.ts',
      'c.ts',
    ]);
  });

  it('moves a multi-selection after the target, keeping order', () => {
    expect(reorderPaths(ROW, ['a.ts', 'b.ts'], 'd.ts', 'after')).toEqual([
      'c.ts',
      'd.ts',
      'a.ts',
      'b.ts',
    ]);
  });

  it('is a no-op when dropping onto a dragged tab', () => {
    expect(reorderPaths(ROW, ['a.ts', 'b.ts'], 'b.ts', 'after')).toEqual(ROW);
  });
});
