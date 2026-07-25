import { describe, expect, it } from 'vitest';

import type { Task } from '@shared/types';

import { selectNewestPrReviewTask } from './select-pr-review-task';

describe('selectNewestPrReviewTask', () => {
  it('selects newest matching workspace independent of query order', () => {
    const tasks = [
      task({ id: 'newer-b', createdAt: '2026-02-01T00:00:00.000Z' }),
      task({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
      task({ id: 'newer-a', createdAt: '2026-02-01T00:00:00.000Z' }),
      task({ id: 'other-pr', pullRequestId: '99' }),
      task({ id: 'other-project', projectId: 'project-2' }),
    ];

    expect(
      selectNewestPrReviewTask({
        tasks,
        projectId: 'project-1',
        pullRequestId: '42',
      })?.id,
    ).toBe('newer-b');
  });
});

function task(overrides: Partial<Task>): Task {
  return {
    id: 'review',
    projectId: 'project-1',
    type: 'pr-review',
    name: 'Review',
    prompt: 'Review',
    status: 'waiting',
    worktreePath: '/tmp/review',
    startCommitHash: 'abc',
    sourceBranch: 'feature',
    branchName: 'review',
    prWorkspaceState: 'active',
    hasUnread: false,
    userCompleted: false,
    workItemIds: null,
    workItemUrls: null,
    pullRequestId: '42',
    pullRequestUrl: null,
    pendingMessage: null,
    todoItems: [],
    parentTaskId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
