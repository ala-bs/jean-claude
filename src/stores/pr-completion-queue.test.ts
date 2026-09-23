import { beforeEach, describe, expect, it } from 'vitest';

import { usePrCompletionQueueStore } from './pr-completion-queue';

const baseEntry = {
  projectId: 'p1',
  prTitle: 'Some PR',
  targetBranch: 'main',
  completionOptions: {
    mergeStrategy: 'squash',
    deleteSourceBranch: true,
    transitionWorkItems: false,
  },
};

function enqueue(prId: number, projectId = 'p1') {
  return usePrCompletionQueueStore
    .getState()
    .enqueue({ ...baseEntry, projectId, prId });
}

function idsFor(projectId: string) {
  return usePrCompletionQueueStore
    .getState()
    .entries.filter((e) => e.projectId === projectId)
    .map((e) => e.prId);
}

describe('pr completion queue store', () => {
  beforeEach(() => {
    usePrCompletionQueueStore.setState({ entries: [] });
  });

  it('keeps enqueue order per project', () => {
    enqueue(1);
    enqueue(2);
    enqueue(3);
    expect(idsFor('p1')).toEqual([1, 2, 3]);
  });

  it('ignores a duplicate enqueue of the same PR', () => {
    enqueue(1);
    enqueue(1);
    expect(idsFor('p1')).toEqual([1]);
  });

  it('treats the same PR id in another project as a separate entry', () => {
    enqueue(1, 'p1');
    enqueue(1, 'p2');
    expect(idsFor('p1')).toEqual([1]);
    expect(idsFor('p2')).toEqual([1]);
  });

  it('reorders waiting entries without disturbing other projects', () => {
    enqueue(1, 'p1');
    enqueue(2, 'p2');
    enqueue(3, 'p1');
    const third = usePrCompletionQueueStore
      .getState()
      .entries.find((e) => e.prId === 3)!;

    usePrCompletionQueueStore.getState().move(third.id, 'up');

    expect(idsFor('p1')).toEqual([3, 1]);
    expect(idsFor('p2')).toEqual([2]);
  });

  it('refuses to move an armed entry or to swap past one', () => {
    const first = enqueue(1);
    enqueue(2);
    usePrCompletionQueueStore.getState().setStatus(first, 'armed');

    const second = usePrCompletionQueueStore
      .getState()
      .entries.find((e) => e.prId === 2)!;

    usePrCompletionQueueStore.getState().move(first, 'down');
    expect(idsFor('p1')).toEqual([1, 2]);

    // The armed head must stay the head, so promoting #2 over it is rejected.
    usePrCompletionQueueStore.getState().move(second.id, 'up');
    expect(idsFor('p1')).toEqual([1, 2]);
  });

  it('drains only the named project when the setting is turned off', () => {
    enqueue(1, 'p1');
    enqueue(2, 'p1');
    enqueue(3, 'p2');

    usePrCompletionQueueStore.getState().clearProject('p1');

    expect(idsFor('p1')).toEqual([]);
    expect(idsFor('p2')).toEqual([3]);
  });

  it('promotes the next entry when the head is removed', () => {
    const first = enqueue(1);
    enqueue(2);
    usePrCompletionQueueStore.getState().remove(first);
    expect(idsFor('p1')).toEqual([2]);
  });
});
