import { beforeEach, describe, expect, it } from 'vitest';

import {
  diffFileSignature,
  isStaleSignature,
  PR_REVIEW_MAX_AGE_MS,
  prReviewScopeId,
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

  it('keeps pull request review state when pruning tasks', () => {
    const store = useDiffReviewStore.getState();
    const scope = prReviewScopeId({ projectId: 'proj-1', prId: 42 });
    store.setReviewed(scope, [{ path: 'a.ts', signature: 'v1' }], true, 10);

    store.pruneTasks(new Set([TASK]));

    expect(reviewedOf(scope)['a.ts']).toBeDefined();
  });

  it('expires pull request review state that has gone untouched', () => {
    const store = useDiffReviewStore.getState();
    const old = prReviewScopeId({ projectId: 'proj-1', prId: 1 });
    const recent = prReviewScopeId({ projectId: 'proj-1', prId: 2 });
    const now = 1_000_000_000_000;
    store.setReviewed(
      old,
      [{ path: 'a.ts', signature: 'v1' }],
      true,
      now - PR_REVIEW_MAX_AGE_MS - 1,
    );
    store.setReviewed(recent, [{ path: 'b.ts', signature: 'v1' }], true, now);

    store.prunePrScopes(now - PR_REVIEW_MAX_AGE_MS);

    expect(reviewedOf(old)['a.ts']).toBeUndefined();
    expect(reviewedOf(recent)['b.ts']).toBeDefined();
  });

  it('keeps a pull request scope that has no reviewed files left', () => {
    const store = useDiffReviewStore.getState();
    const scope = prReviewScopeId({ projectId: 'proj-1', prId: 1 });
    store.setReviewed(scope, [{ path: 'a.ts', signature: 'v1' }], true, 10);
    store.setReviewed(scope, [{ path: 'a.ts', signature: 'v1' }], false, 20);
    store.setTabs(scope, ['a.ts']);

    store.prunePrScopes(Number.MAX_SAFE_INTEGER);

    expect(useDiffReviewStore.getState().tabsByTask[scope]).toEqual(['a.ts']);
  });

  it('keeps pull request tabs and groups when pruning tasks', () => {
    const store = useDiffReviewStore.getState();
    const scope = prReviewScopeId({ projectId: 'proj-1', prId: 7 });
    store.setTabs(scope, ['a.ts']);
    store.setGroups(scope, [{ id: 'g1', label: 'G', paths: ['a.ts'] }]);

    store.pruneTasks(new Set([TASK]));

    const state = useDiffReviewStore.getState();
    expect(state.tabsByTask[scope]).toEqual(['a.ts']);
    expect(state.groupsByTask[scope]).toHaveLength(1);
  });

  it('detects a new pull request revision as a change', () => {
    const before = diffFileSignature({ status: 'edit', revision: 'sha1' });
    const after = diffFileSignature({
      status: 'edit',
      revision: 'sha1,sha2',
    });

    expect(before).not.toEqual(after);
    expect(isStaleSignature(before, after)).toBe(true);
  });

  it('leaves signatures without a revision unchanged', () => {
    expect(diffFileSignature({ status: 'modified', additions: 1 })).toBe(
      's:modified:1:0',
    );
  });

  it('leaves task review state alone when expiring pull requests', () => {
    const store = useDiffReviewStore.getState();
    store.setReviewed(TASK, [{ path: 'a.ts', signature: 'v1' }], true, 1);

    store.prunePrScopes(Number.MAX_SAFE_INTEGER);

    expect(reviewedOf(TASK)['a.ts']).toBeDefined();
  });
});
