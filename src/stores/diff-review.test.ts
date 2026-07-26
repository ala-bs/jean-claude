import { beforeEach, describe, expect, it } from 'vitest';

import {
  diffFileSignature,
  isStaleSignature,
  useDiffReviewStore,
} from './diff-review';

const TASK = 'task-1';

function reviewedOf(taskId: string) {
  return useDiffReviewStore.getState().reviewedByTask[taskId] ?? {};
}

describe('diffFileSignature', () => {
  it('changes when the diff stats change', () => {
    const before = diffFileSignature({
      status: 'modified',
      additions: 3,
      deletions: 1,
    });
    const after = diffFileSignature({
      status: 'modified',
      additions: 5,
      deletions: 1,
    });
    expect(before).not.toBe(after);
  });

  it('appends a content hash when the content is available', () => {
    const withContent = diffFileSignature({
      status: 'modified',
      additions: 3,
      content: 'hello',
    });
    expect(withContent.startsWith('s:modified:3:0#c:')).toBe(true);
  });

  it('distinguishes same-size edits through the content hash', () => {
    const stats = { status: 'modified', additions: 1, deletions: 1 };
    const before = diffFileSignature({ ...stats, content: 'const a = 1;' });
    const after = diffFileSignature({ ...stats, content: 'const a = 2;' });
    expect(before).not.toBe(after);
    expect(isStaleSignature(before, after)).toBe(true);
  });
});

describe('isStaleSignature', () => {
  const stats = { status: 'modified', additions: 1, deletions: 1 };

  it('is not stale when nothing moved', () => {
    const signature = diffFileSignature(stats);
    expect(isStaleSignature(signature, signature)).toBe(false);
  });

  it('is stale when the diff stats change', () => {
    expect(
      isStaleSignature(
        diffFileSignature(stats),
        diffFileSignature({ ...stats, additions: 4 }),
      ),
    ).toBe(true);
  });

  it('does not flag a stats-only record once content becomes available', () => {
    expect(
      isStaleSignature(
        diffFileSignature(stats),
        diffFileSignature({ ...stats, content: 'anything' }),
      ),
    ).toBe(false);
  });

  it('does not flag a hashed record when content is no longer loaded', () => {
    expect(
      isStaleSignature(
        diffFileSignature({ ...stats, content: 'anything' }),
        diffFileSignature(stats),
      ),
    ).toBe(false);
  });
});

describe('diff review store', () => {
  beforeEach(() => {
    useDiffReviewStore.setState({
      reviewedByTask: {},
      tabsByTask: {},
      groupsByTask: {},
    });
  });

  it('stores the signature captured when a file was marked reviewed', () => {
    useDiffReviewStore
      .getState()
      .setReviewed(TASK, [{ path: 'a.ts', signature: 's:modified:1:0' }], true, 10);

    expect(reviewedOf(TASK)['a.ts']).toEqual({
      signature: 's:modified:1:0',
      reviewedAt: 10,
    });
  });

  it('re-stamps the signature when a file is reviewed again', () => {
    const store = useDiffReviewStore.getState();
    store.setReviewed(TASK, [{ path: 'a.ts', signature: 'v1' }], true, 10);
    store.setReviewed(TASK, [{ path: 'a.ts', signature: 'v2' }], true, 20);

    expect(reviewedOf(TASK)['a.ts']).toEqual({
      signature: 'v2',
      reviewedAt: 20,
    });
  });

  it('drops the record when a file is unmarked', () => {
    const store = useDiffReviewStore.getState();
    store.setReviewed(TASK, [{ path: 'a.ts', signature: 'v1' }], true, 10);
    store.setReviewed(TASK, [{ path: 'a.ts', signature: 'v1' }], false, 20);

    expect(reviewedOf(TASK)['a.ts']).toBeUndefined();
  });

  it('keeps review state separate per task', () => {
    const store = useDiffReviewStore.getState();
    store.setReviewed(TASK, [{ path: 'a.ts', signature: 'v1' }], true, 10);
    store.setReviewed('task-2', [{ path: 'b.ts', signature: 'v1' }], true, 10);

    expect(Object.keys(reviewedOf(TASK))).toEqual(['a.ts']);
    expect(Object.keys(reviewedOf('task-2'))).toEqual(['b.ts']);
  });

  it('prunes state for tasks that no longer exist', () => {
    const store = useDiffReviewStore.getState();
    store.setReviewed(TASK, [{ path: 'a.ts', signature: 'v1' }], true, 10);
    store.setReviewed('gone', [{ path: 'b.ts', signature: 'v1' }], true, 10);

    store.pruneTasks(new Set([TASK]));

    expect(reviewedOf(TASK)['a.ts']).toBeDefined();
    expect(reviewedOf('gone')['b.ts']).toBeUndefined();
  });
});
