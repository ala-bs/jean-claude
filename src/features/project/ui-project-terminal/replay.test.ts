import { describe, expect, it } from 'vitest';

import { sliceAfterReplay } from './replay';

describe('sliceAfterReplay', () => {
  it('writes a chunk that starts after the replay boundary in full', () => {
    expect(
      sliceAfterReplay({ data: 'hello', offset: 10, replayedThrough: 10 }),
    ).toBe('hello');
    expect(
      sliceAfterReplay({ data: 'hello', offset: 20, replayedThrough: 10 }),
    ).toBe('hello');
  });

  it('drops a chunk the replay already covered', () => {
    // The backlog ran to offset 10, so a chunk occupying [0,5) is inside it.
    expect(
      sliceAfterReplay({ data: 'hello', offset: 0, replayedThrough: 10 }),
    ).toBe('');
  });

  it('drops a chunk that ends exactly on the boundary', () => {
    // [5,10) against a replay through 10 — fully covered, nothing new.
    expect(
      sliceAfterReplay({ data: 'hello', offset: 5, replayedThrough: 10 }),
    ).toBe('');
  });

  it('keeps only the uncovered tail of a straddling chunk', () => {
    // [5,15) against a replay through 10: the first 5 chars are duplicates.
    expect(
      sliceAfterReplay({ data: 'abcdefghij', offset: 5, replayedThrough: 10 }),
    ).toBe('fghij');
  });

  it('keeps a chunk that straddles by a single character', () => {
    expect(
      sliceAfterReplay({ data: 'abcdefghij', offset: 0, replayedThrough: 9 }),
    ).toBe('j');
  });

  it('writes everything when there was no backlog to replay', () => {
    expect(
      sliceAfterReplay({ data: 'hello', offset: 0, replayedThrough: 0 }),
    ).toBe('hello');
  });

  it('handles an empty chunk without producing output', () => {
    expect(
      sliceAfterReplay({ data: '', offset: 0, replayedThrough: 10 }),
    ).toBe('');
  });
});
