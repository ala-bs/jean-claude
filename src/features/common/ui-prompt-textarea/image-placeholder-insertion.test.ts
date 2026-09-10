import { describe, expect, it } from 'vitest';

import { buildImagePlaceholderInsertion } from './image-placeholder-insertion';

const MARK = '![a.png](jc-image://aaa)';

function insert(value: string, start: number, end = start) {
  return buildImagePlaceholderInsertion({
    value,
    caret: { start, end },
    placeholder: MARK,
  });
}

describe('buildImagePlaceholderInsertion', () => {
  it('puts the marker on its own line between two list items', () => {
    const text = '1. fix header\n2. fix modal';
    const result = insert(text, '1. fix header'.length);

    expect(result.value).toBe(`1. fix header\n${MARK}\n2. fix modal`);
    // Caret sits after the marker, before the newline, so the user keeps
    // typing on the marker's line rather than pushing item 2 down.
    expect(result.value.slice(0, result.caret.start)).toBe(
      `1. fix header\n${MARK}`,
    );
  });

  it('does not add a newline when the caret is already on a blank line', () => {
    const result = insert('one\n\ntwo', 4);
    expect(result.value).toBe(`one\n${MARK}\ntwo`);
  });

  it('appends without a leading newline at the very start of an empty draft', () => {
    const result = insert('', 0);
    expect(result.value).toBe(MARK);
    expect(result.caret).toEqual({ start: MARK.length, end: MARK.length });
  });

  it('breaks the line when pasting into the middle of a sentence', () => {
    const result = insert('hello world', 5);
    expect(result.value).toBe(`hello\n${MARK}\n world`);
  });

  it('replaces the selected range, like any other paste', () => {
    const result = insert('keep DROPME tail', 5, 11);
    expect(result.value).toBe(`keep \n${MARK}\n tail`);
    expect(result.value).not.toContain('DROPME');
  });

  it('clamps a caret that outlived the text it pointed into', () => {
    // The user deleted most of the draft while the image was still decoding.
    const result = insert('hi', 500);
    expect(result.value).toBe(`hi\n${MARK}`);
    expect(result.caret.start).toBe(result.value.length);
  });

  it('clamps a reversed range rather than producing garbage', () => {
    const result = buildImagePlaceholderInsertion({
      value: 'abcdef',
      caret: { start: 4, end: 1 },
      placeholder: MARK,
    });
    expect(result.value).toBe(`abcd\n${MARK}\nef`);
  });

  it('chains: a second insert at the returned caret stacks below the first', () => {
    const first = insert('1. a\n2. b', 4);
    const second = buildImagePlaceholderInsertion({
      value: first.value,
      caret: first.caret,
      placeholder: '![b.png](jc-image://bbb)',
    });

    expect(second.value).toBe(
      `1. a\n${MARK}\n![b.png](jc-image://bbb)\n2. b`,
    );
  });
});
