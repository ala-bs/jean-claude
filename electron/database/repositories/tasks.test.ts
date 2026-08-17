import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const executeTakeFirst = vi.fn();
  const orderBy = vi.fn(() => ({ executeTakeFirst }));
  const where = vi.fn(() => ({ where, orderBy }));
  const selectAll = vi.fn(() => ({ where }));
  const selectFrom = vi.fn(() => ({ selectAll }));
  const updateExecuteTakeFirst = vi.fn();
  const returningAll = vi.fn(() => ({ executeTakeFirst: updateExecuteTakeFirst }));
  const updateWhere = vi.fn(() => ({ returningAll, where: updateWhere }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const updateTable = vi.fn(() => ({ set }));

  return {
    dbMock: { selectFrom, updateTable },
    executeTakeFirst,
    selectFrom,
    set,
    updateExecuteTakeFirst,
    updateTable,
    updateWhere,
    where,
  };
});

const {
  executeTakeFirst,
  selectFrom,
  set,
  updateExecuteTakeFirst,
  updateTable,
  updateWhere,
  where,
} = mocks;

vi.mock('../index', () => ({
  db: mocks.dbMock,
}));

vi.mock('../../lib/debug', () => ({
  dbg: {
    db: vi.fn(),
  },
}));

import { TaskRepository } from './tasks';

function createTaskRow(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

describe('TaskRepository.findActivePrReviewTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('finds pr-review task by project and pull request regardless completion', async () => {
    executeTakeFirst.mockResolvedValue(createTaskRow());

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

describe('TaskRepository.setHasUnread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns changed task data', async () => {
    updateExecuteTakeFirst.mockResolvedValue(
      createTaskRow({ hasUnread: 1, userCompleted: 0 }),
    );

    await expect(TaskRepository.setHasUnread('task-1', true)).resolves.toMatchObject(
      {
        id: 'task-1',
        hasUnread: true,
      },
    );

    expect(updateTable).toHaveBeenCalledWith('tasks');
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ hasUnread: 1 }),
    );
    expect(updateWhere).toHaveBeenCalledWith('id', '=', 'task-1');
    expect(updateWhere).toHaveBeenCalledWith('hasUnread', '!=', 1);
  });

  it('returns undefined when unread state is unchanged', async () => {
    updateExecuteTakeFirst.mockResolvedValue(undefined);

    await expect(
      TaskRepository.setHasUnread('task-1', false),
    ).resolves.toBeUndefined();
  });

  it('returns task data when clearing unread state changes it', async () => {
    updateExecuteTakeFirst.mockResolvedValue(
      createTaskRow({ hasUnread: 0, userCompleted: 0 }),
    );

    await expect(
      TaskRepository.setHasUnread('task-1', false),
    ).resolves.toMatchObject({ id: 'task-1', hasUnread: false });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ hasUnread: 0 }),
    );
    expect(updateWhere).toHaveBeenCalledWith('hasUnread', '!=', 0);
  });
});
