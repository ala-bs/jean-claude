import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const executeTakeFirst = vi.fn();
  const orderBy = vi.fn(() => ({ executeTakeFirst }));
  const where = vi.fn(() => ({ where, orderBy }));
  const selectAll = vi.fn(() => ({ where }));
  const selectFrom = vi.fn(() => ({ selectAll }));

  return {
    dbMock: { selectFrom },
    executeTakeFirst,
    selectFrom,
    where,
  };
});

const { executeTakeFirst, selectFrom, where } = mocks;

vi.mock('../index', () => ({
  db: mocks.dbMock,
}));

vi.mock('../../lib/debug', () => ({
  dbg: {
    db: vi.fn(),
  },
}));

import { TaskRepository } from './tasks';

describe('TaskRepository.findActivePrReviewTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('finds pr-review task by project and pull request regardless completion', async () => {
    executeTakeFirst.mockResolvedValue({
      id: 'task-1',
      projectId: 'project-1',
      type: 'pr-review',
      name: 'Review: PR',
      prompt: 'Review PR #12: PR',
      status: 'pending',
      worktreePath: '/tmp/worktree',
      startCommitHash: 'abc123',
      sourceBranch: 'feature/pr',
      branchName: 'review-pr-12',
      hasUnread: 0,
      userCompleted: 1,
      sessionRules: null,
      workItemIds: null,
      workItemUrls: null,
      pullRequestId: '12',
      pullRequestUrl: 'https://example.test/pr/12',
      pendingMessage: null,
      todoItems: null,
      parentTaskId: null,
      sortOrder: 0,
      createdAt: '2026-07-05T00:00:00.000Z',
      updatedAt: '2026-07-05T00:00:00.000Z',
    });

    await expect(
      TaskRepository.findActivePrReviewTask({
        projectId: 'project-1',
        pullRequestId: '12',
      }),
    ).resolves.toMatchObject({
      id: 'task-1',
      type: 'pr-review',
      pullRequestId: '12',
      userCompleted: true,
    });

    expect(selectFrom).toHaveBeenCalledWith('tasks');
    expect(where).toHaveBeenCalledWith('projectId', '=', 'project-1');
    expect(where).toHaveBeenCalledWith('type', '=', 'pr-review');
    expect(where).toHaveBeenCalledWith('pullRequestId', '=', '12');
    expect(where).not.toHaveBeenCalledWith('userCompleted', '=', 0);
  });
});
