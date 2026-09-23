import { describe, expect, it } from 'vitest';

import { createImageInsertBatch } from './image-insert-batch';

const caretAt = (n: number) => ({ start: n, end: n });

describe('createImageInsertBatch', () => {
  it('holds the caret until every image in the batch settles', () => {
    const batch = createImageInsertBatch();

    batch.begin(1, caretAt(10));
    batch.begin(1, caretAt(10));
    expect(batch.getCaret()).toEqual(caretAt(10));

    // First image lands; the caret must survive for the second.
    expect(batch.end()).toBeNull();
    expect(batch.getCaret()).toEqual(caretAt(10));

    expect(batch.end()).toEqual(caretAt(10));
    expect(batch.getCaret()).toBeNull();
  });

  it('lets a newer paste take the caret from an in-flight batch', () => {
    // The bug this guards: paste at line 1, click to the end, paste again
    // before the first decode finishes. The second image must land where the
    // user just clicked, not chained onto the first batch's position.
    const batch = createImageInsertBatch();

    batch.begin(1, caretAt(5));
    batch.begin(2, caretAt(80));

    expect(batch.getCaret()).toEqual(caretAt(80));
  });

  it('only restores the selection once all overlapping batches drain', () => {
    const batch = createImageInsertBatch();

    batch.begin(1, caretAt(5));
    batch.begin(2, caretAt(80));
    batch.setCaret(caretAt(104));

    expect(batch.end()).toBeNull();
    expect(batch.end()).toEqual(caretAt(104));
  });

  it('advances the caret across successive inserts in one batch', () => {
    const batch = createImageInsertBatch();

    batch.begin(1, caretAt(4));
    batch.begin(1, caretAt(4));
    batch.setCaret(caretAt(28)); // first marker inserted
    expect(batch.getCaret()).toEqual(caretAt(28));
    batch.setCaret(caretAt(52)); // second stacks below it
    batch.end();

    expect(batch.end()).toEqual(caretAt(52));
  });

  it('keeps a null caret null so drops fall back to the DOM selection', () => {
    const batch = createImageInsertBatch();

    batch.begin(1, null);
    expect(batch.getCaret()).toBeNull();
    expect(batch.end()).toBeNull();
  });

  it('recovers the caret when the first image of a batch fails to decode', () => {
    const batch = createImageInsertBatch();

    batch.begin(1, caretAt(12));
    batch.begin(1, caretAt(12));
    batch.end(); // image 1 rejected — no setCaret happened
    expect(batch.getCaret()).toEqual(caretAt(12));

    batch.setCaret(caretAt(36)); // image 2 succeeded
    expect(batch.end()).toEqual(caretAt(36));
  });

  it('never lets the pending count go negative on an unpaired end', () => {
    const batch = createImageInsertBatch();

    batch.end();
    batch.end();
    expect(batch.pendingCount()).toBe(0);

    // A later batch must still work rather than settling one end() early.
    batch.begin(1, caretAt(3));
    batch.begin(1, caretAt(3));
    expect(batch.end()).toBeNull();
    expect(batch.end()).toEqual(caretAt(3));
  });

  it('mints tokens unique against both committed and in-flight images', () => {
    const batch = createImageInsertBatch();
    batch.begin(1, null);

    const first = batch.mintToken(['committed']);
    const second = batch.mintToken(['committed']);

    // The parent's `images` prop has not updated between these two calls, so
    // only the batch's own memory prevents a collision.
    expect(second).not.toBe(first);
    expect([first, second]).not.toContain('committed');
  });

  it('forgets in-flight tokens once the batch drains', () => {
    const batch = createImageInsertBatch();
    batch.begin(1, null);
    const token = batch.mintToken([]);
    batch.end();

    batch.begin(2, null);
    // Now committed, so the caller passes it in and it is still avoided.
    expect(batch.mintToken([token])).not.toBe(token);
  });
});
