import { createPromptImageToken } from '@shared/prompt-image-placeholders';

import type { CaretRange } from './image-placeholder-insertion';

/**
 * Tracks the caret and tokens for in-flight image inserts.
 *
 * Decoding an image is async (canvas resize + AVIF encode), so between the
 * paste event and the attachment landing, neither the DOM selection nor the
 * committed `value` can be trusted. This owns that window.
 *
 * A *batch* is one user gesture — a paste, a drop, a file-pick — identified by
 * a monotonic id. The caret belongs to the newest batch: if the user pastes at
 * line 1, clicks to the end, and pastes again before the first decode finishes,
 * the second paste's caret takes over rather than being swallowed by the first
 * batch's. Inserts only stop being tracked once *every* image across all
 * overlapping batches has settled, which is when the DOM selection is restored.
 *
 * Extracted from the component so this can be tested without a DOM.
 */
export function createImageInsertBatch() {
  let pending = 0;
  let activeBatchId: number | null = null;
  let caret: CaretRange | null = null;
  /** Tokens minted this batch, which the parent has not committed yet. */
  const uncommittedTokens = new Set<string>();

  return {
    /** Call once per image, before kicking off its async decode. */
    begin(batchId: number, initialCaret: CaretRange | null): void {
      if (activeBatchId !== batchId) {
        activeBatchId = batchId;
        // A null caret (drop, file-pick) means "use the live DOM selection".
        caret = initialCaret;
      }
      pending += 1;
    },

    /**
     * Call once per image when its decode settles, successfully or not.
     * Returns the caret to restore when the last insert drains, else null.
     */
    end(): CaretRange | null {
      pending = Math.max(0, pending - 1);
      if (pending > 0) return null;
      const settled = caret;
      activeBatchId = null;
      caret = null;
      uncommittedTokens.clear();
      return settled;
    },

    /** The tracked caret, or null to fall back to the DOM selection. */
    getCaret(): CaretRange | null {
      return caret;
    },

    /** Advance the caret past an insert that just happened. */
    setCaret(next: CaretRange): void {
      caret = next;
    },

    /**
     * A token unique against both committed images and the ones still in this
     * batch — within a single tick the parent's `images` prop has not updated,
     * so `committed` alone would let two images in one paste collide.
     */
    mintToken(committed: Iterable<string>): string {
      const token = createPromptImageToken([
        ...committed,
        ...uncommittedTokens,
      ]);
      uncommittedTokens.add(token);
      return token;
    },

    /** Test/diagnostic only. */
    pendingCount(): number {
      return pending;
    },
  };
}
