import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const executeTakeFirst = vi.fn();
  const executeTakeFirstOrThrow = vi.fn();
  const execute = vi.fn();
  const orderBy = vi.fn(() => ({ execute, executeTakeFirst, orderBy }));
  const where = vi.fn(() => ({ where, orderBy }));
  const selectAll = vi.fn(() => ({ where }));
  const selectFrom = vi.fn(() => ({ selectAll }));
  const updateExecuteTakeFirst = vi.fn();
  const returningAll = vi.fn(() => ({
    execute,
    executeTakeFirst: updateExecuteTakeFirst,
    executeTakeFirstOrThrow,
  }));
  const values = vi.fn(() => ({ returningAll }));
  const insertInto = vi.fn(() => ({ values }));
  const updateBuilder = {
    execute,
    returningAll,
    where: vi.fn(() => updateBuilder),
  };
  const set = vi.fn(() => updateBuilder);
  const updateTable = vi.fn(() => ({ set }));

  const dbMock = { insertInto, selectFrom, updateTable } as {
    insertInto: typeof insertInto;
    selectFrom: typeof selectFrom;
    updateTable: typeof updateTable;
    transaction: ReturnType<typeof vi.fn>;
  };
  const transactionExecute = vi.fn(
    async (operation: (trx: typeof dbMock) => Promise<unknown>) =>
      operation(dbMock),
  );
  dbMock.transaction = vi.fn(() => ({ execute: transactionExecute }));

  return {
    dbMock,
    executeTakeFirst,
    executeTakeFirstOrThrow,
    execute,
    insertInto,
    orderBy,
    selectFrom,
    set,
    updateExecuteTakeFirst,
    updateTable,
    updateWhere: updateBuilder.where,
    values,
    where,
    transactionExecute,
  };
});

const {
  executeTakeFirst,
  executeTakeFirstOrThrow,
  execute,
  selectFrom,
  set,
  updateExecuteTakeFirst,
  updateTable,
  updateWhere,
  values,
  where,
} = mocks;

function getSetValues(index: number): Record<string, unknown> {
  const call = (vi.mocked(set).mock.calls as unknown as Array<
    [Record<string, unknown>]
  >)[index];
  if (!call) throw new Error(`Missing set call ${index}`);
  return call[0];
}

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
    cleanupWorktreePath: null,
    cleanupBranchName: null,
    prWorkspaceState: 'active',
    prWorkspacePendingAt: null,
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
      prWorkspaceState: 'active',
    });

    expect(selectFrom).toHaveBeenCalledWith('tasks');
    expect(where).toHaveBeenCalledWith('projectId', '=', 'project-1');
    expect(where).toHaveBeenCalledWith('type', '=', 'pr-review');
    expect(where).toHaveBeenCalledWith('pullRequestId', '=', '12');
    expect(where).not.toHaveBeenCalledWith('userCompleted', '=', 0);
  });

  it('rejects an unknown persisted PR workspace state', async () => {
    executeTakeFirst.mockResolvedValue({
      id: 'task-1',
      type: 'pr-review',
      prWorkspaceState: 'unknown-state',
    });

    await expect(
      TaskRepository.findActivePrReviewTask({
        projectId: 'project-1',
        pullRequestId: '12',
      }),
    ).rejects.toThrow('Invalid PR workspace state');
  });
});

describe('TaskRepository PR workspace state persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const returnedRow = {
    id: 'task-1',
    projectId: 'project-1',
    type: 'pr-review',
    name: 'Review PR',
    prompt: 'Review PR',
    status: 'waiting',
    worktreePath: '/worktree',
    startCommitHash: 'abc',
    sourceBranch: 'main',
    branchName: 'review-pr',
    cleanupWorktreePath: null,
    cleanupBranchName: null,
    prWorkspaceState: 'active',
    prWorkspacePendingAt: null,
    hasUnread: 0,
    userCompleted: 0,
    sortOrder: 0,
    workItemIds: null,
    workItemUrls: null,
    pullRequestId: '12',
    pullRequestUrl: null,
    pendingMessage: null,
    todoItems: null,
    parentTaskId: null,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
  };

  it('writes and reads state when creating a task', async () => {
    executeTakeFirstOrThrow.mockResolvedValue(returnedRow);

    await expect(
      TaskRepository.create({
        projectId: 'project-1',
        type: 'pr-review',
        prompt: 'Review PR',
        prWorkspaceState: 'active',
        updatedAt: '2026-07-14T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({ prWorkspaceState: 'active' });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ prWorkspaceState: 'active' }),
    );
  });

  it('leaves normal task state null when creation omits backend state', async () => {
    executeTakeFirstOrThrow.mockResolvedValue({
      ...returnedRow,
      type: 'agent',
      prWorkspaceState: null,
    });

    await expect(
      TaskRepository.create({
        projectId: 'project-1',
        type: 'agent',
        prompt: 'Normal task',
        updatedAt: '2026-07-14T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({ prWorkspaceState: null });

    expect(values).toHaveBeenCalledWith(
      expect.not.objectContaining({ prWorkspaceState: expect.anything() }),
    );
  });

  it('writes and reads state when updating a task', async () => {
    executeTakeFirstOrThrow.mockResolvedValue({
      ...returnedRow,
      prWorkspaceState: 'kept',
    });

    await expect(
      TaskRepository.update('task-1', { prWorkspaceState: 'kept' }),
    ).resolves.toMatchObject({ prWorkspaceState: 'kept' });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ prWorkspaceState: 'kept' }),
    );
  });

  it('sets and clears pending detection time atomically with lifecycle state', async () => {
    vi.useFakeTimers();
    executeTakeFirstOrThrow
      .mockResolvedValueOnce({
        ...returnedRow,
        prWorkspaceState: 'cleanup-pending',
        prWorkspacePendingAt: '2026-07-14T00:00:00.000Z',
      })
      .mockResolvedValueOnce(returnedRow)
      .mockResolvedValueOnce({
        ...returnedRow,
        prWorkspaceState: 'cleanup-pending',
        prWorkspacePendingAt: '2026-07-15T00:00:00.000Z',
      });

    vi.setSystemTime(new Date('2026-07-14T00:00:00.000Z'));
    await TaskRepository.setPrWorkspaceState('task-1', 'cleanup-pending');
    expect(set).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        prWorkspaceState: 'cleanup-pending',
        prWorkspacePendingAt: expect.any(String),
      }),
    );

    await TaskRepository.setPrWorkspaceState('task-1', 'active');
    expect(set).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        prWorkspaceState: 'active',
        prWorkspacePendingAt: null,
      }),
    );
    expect(
      JSON.stringify(
        (getSetValues(1).status as {
          toOperationNode: () => unknown;
        }).toOperationNode(),
      ),
    ).toContain("CASE WHEN status = 'completed' THEN 'waiting' ELSE status END");

    executeTakeFirstOrThrow.mockResolvedValueOnce({
      ...returnedRow,
      prWorkspaceState: 'kept',
    });
    await TaskRepository.setPrWorkspaceState('task-1', 'kept');
    expect(set).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        prWorkspaceState: 'kept',
        prWorkspacePendingAt: null,
      }),
    );

    vi.setSystemTime(new Date('2026-07-15T00:00:00.000Z'));
    await TaskRepository.setPrWorkspaceState('task-1', 'cleanup-pending');
    expect(set).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        prWorkspaceState: 'cleanup-pending',
        prWorkspacePendingAt: '2026-07-15T00:00:00.000Z',
      }),
    );
    vi.useRealTimers();
  });

  it('reactivates requested workspaces atomically with a current-status CASE', async () => {
    execute.mockResolvedValue([
      { ...returnedRow, id: 'running', status: 'running' },
      { ...returnedRow, id: 'waiting', status: 'waiting' },
      { ...returnedRow, id: 'completed', status: 'waiting' },
    ]);

    await expect(
      TaskRepository.reactivatePrWorkspaces(['running', 'waiting', 'completed']),
    ).resolves.toEqual([
      expect.objectContaining({ id: 'running', status: 'running' }),
      expect.objectContaining({ id: 'waiting', status: 'waiting' }),
      expect.objectContaining({ id: 'completed', status: 'waiting' }),
    ]);

    expect(mocks.dbMock.transaction).toHaveBeenCalledOnce();
    expect(mocks.updateWhere).toHaveBeenCalledWith('prWorkspaceState', 'in', [
      'cleanup-pending',
      'kept',
    ]);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        prWorkspaceState: 'active',
        userCompleted: 0,
      }),
    );
    const status = getSetValues(0).status as {
      toOperationNode: () => unknown;
    };
    expect(JSON.stringify(status.toOperationNode())).toContain(
      "CASE WHEN status = 'completed' THEN 'waiting' ELSE status END",
    );
  });

  it('rolls back when any requested workspace misses atomic transition', async () => {
    execute.mockResolvedValue([
      { ...returnedRow, id: 'task-1', prWorkspaceState: 'kept' },
    ]);

    await expect(
      TaskRepository.reactivatePrWorkspaces(['task-1', 'task-2']),
    ).rejects.toThrow('state changed');
    expect(mocks.transactionExecute).toHaveBeenCalledOnce();
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
