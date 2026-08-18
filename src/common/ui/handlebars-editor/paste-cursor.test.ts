import { describe, expect, it } from 'vitest';

import { computePasteCursorPlacement } from './paste-cursor';

describe('computePasteCursorPlacement', () => {
  it('appends a line when the paste ends at the end of the last line', () => {
    expect(
      computePasteCursorPlacement({
        endLineNumber: 1,
        lineCount: 1,
        endLineContent: 'pasted text',
        nextLineContent: null,
      }),
    ).toEqual({ action: 'insert-newline', lineNumber: 1 });
  });

  it('reuses an existing blank line below the paste', () => {
    expect(
      computePasteCursorPlacement({
        endLineNumber: 1,
        lineCount: 3,
        endLineContent: 'pasted text',
        nextLineContent: '',
      }),
    ).toEqual({ action: 'move', lineNumber: 2 });
  });

  it('does not add a second blank line when the pasted text ended in a newline', () => {
    expect(
      computePasteCursorPlacement({
        endLineNumber: 2,
        lineCount: 2,
        endLineContent: '',
        nextLineContent: null,
      }),
    ).toEqual({ action: 'move', lineNumber: 2 });
  });

  it('appends below the pasted line rather than splitting trailing text', () => {
    // "fix the bug in |file" + paste -> caret must not land before " file"
    expect(
      computePasteCursorPlacement({
        endLineNumber: 1,
        lineCount: 2,
        endLineContent: 'fix the bug in src/a.ts file',
        nextLineContent: 'more text',
      }),
    ).toEqual({ action: 'insert-newline', lineNumber: 1 });
  });
});
