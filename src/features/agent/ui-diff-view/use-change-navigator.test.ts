import { describe, expect, it } from 'vitest';

import { computeHunks, getHunkDataLineIndex } from './use-change-navigator';
import type { DiffLine } from './diff-utils';

function ctx(oldLine: number, newLine: number): DiffLine {
  return {
    type: 'context',
    content: 'ctx',
    oldLineNumber: oldLine,
    newLineNumber: newLine,
  };
}

function del(oldLine: number): DiffLine {
  return { type: 'deletion', content: 'old', oldLineNumber: oldLine };
}

function add(newLine: number): DiffLine {
  return { type: 'addition', content: 'new', newLineNumber: newLine };
}

describe('computeHunks', () => {
  it('returns no hunks when every line is context', () => {
    expect(computeHunks([ctx(1, 1), ctx(2, 2)])).toEqual([]);
  });

  it('merges adjacent deletions and additions into one hunk', () => {
    const lines = [ctx(1, 1), del(2), add(2), add(3), ctx(3, 4)];

    expect(computeHunks(lines)).toEqual([
      { startLineIndex: 1, endLineIndex: 3 },
    ]);
  });

  it('separates hunks split by context lines', () => {
    const lines = [ctx(1, 1), add(2), ctx(2, 3), ctx(3, 4), del(4), ctx(5, 5)];

    expect(computeHunks(lines)).toEqual([
      { startLineIndex: 1, endLineIndex: 1 },
      { startLineIndex: 4, endLineIndex: 4 },
    ]);
  });

  it('handles a change at the very end of the file', () => {
    expect(computeHunks([ctx(1, 1), add(2)])).toEqual([
      { startLineIndex: 1, endLineIndex: 1 },
    ]);
  });
});

describe('getHunkDataLineIndex', () => {
  const lines = [ctx(1, 1), del(2), add(2), ctx(3, 3)];

  it('uses the DiffLine index directly in inline mode', () => {
    expect(
      getHunkDataLineIndex({
        hunkStartLineIndex: 1,
        lines,
        viewMode: 'inline',
        lineToRowMap: null,
      }),
    ).toBe(1);
  });

  it('uses the mapped row index in side-by-side mode', () => {
    expect(
      getHunkDataLineIndex({
        hunkStartLineIndex: 1,
        lines,
        viewMode: 'side-by-side',
        lineToRowMap: new Map([[1, 7]]),
      }),
    ).toBe(7);
  });

  it('returns null in side-by-side mode when the line is unmapped', () => {
    expect(
      getHunkDataLineIndex({
        hunkStartLineIndex: 1,
        lines,
        viewMode: 'side-by-side',
        lineToRowMap: new Map(),
      }),
    ).toBeNull();
  });

  it('resolves the first new-file line of the hunk in current-state mode', () => {
    // Hunk starts on a deletion (no newLineNumber); the following addition wins.
    expect(
      getHunkDataLineIndex({
        hunkStartLineIndex: 1,
        lines,
        viewMode: 'current-state',
        lineToRowMap: null,
      }),
    ).toBe(1);
  });

  it('falls back to the following context line for a pure-deletion hunk', () => {
    // Deleted lines have no new-file row, so current-state mode targets the
    // first following line that still exists in the new file.
    const deletionOnly = [ctx(1, 1), del(2), ctx(3, 2)];

    expect(
      getHunkDataLineIndex({
        hunkStartLineIndex: 1,
        lines: deletionOnly,
        viewMode: 'current-state',
        lineToRowMap: null,
      }),
    ).toBe(1);
  });

  it('returns null when a deletion hunk has no new-file line after it', () => {
    expect(
      getHunkDataLineIndex({
        hunkStartLineIndex: 1,
        lines: [ctx(1, 1), del(2)],
        viewMode: 'current-state',
        lineToRowMap: null,
      }),
    ).toBeNull();
  });
});
