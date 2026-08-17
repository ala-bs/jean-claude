import { describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';

import type { Database as DatabaseSchema, TaskRow } from '../schema';

vi.mock('../index', () => ({ db: {} }));
vi.mock('../../lib/debug', () => ({ dbg: { db: vi.fn() } }));

import { createTaskCompletionOperations } from './tasks';

describe('task completion operations', () => {
  it('marks execution and user completion while moving task to completed-section top', async () => {
    const database = createTransactionalTaskDatabase([
      taskRow({ id: 'target', userCompleted: 0, sortOrder: 4 }),
      taskRow({ id: 'completed-1', userCompleted: 1, sortOrder: 0 }),
      taskRow({ id: 'completed-2', userCompleted: 1, sortOrder: 1 }),
    ]);

    const task = await createTaskCompletionOperations(database.db).markCompleted(
      'target',
    );

    expect(task).toMatchObject({
      id: 'target',
      status: 'completed',
      userCompleted: true,
      sortOrder: 0,
    });
    expect(database.state()).toEqual([
      { id: 'target', status: 'completed', userCompleted: 1, sortOrder: 0 },
      { id: 'completed-1', status: 'waiting', userCompleted: 1, sortOrder: 1 },
      { id: 'completed-2', status: 'waiting', userCompleted: 1, sortOrder: 2 },
    ]);
  });

  it('ensures execution completion without shifting when already user-completed', async () => {
    const database = createTransactionalTaskDatabase([
      taskRow({ id: 'target', userCompleted: 1, sortOrder: 3 }),
      taskRow({ id: 'completed-1', userCompleted: 1, sortOrder: 0 }),
    ]);

    const task = await createTaskCompletionOperations(database.db).markCompleted(
      'target',
    );

    expect(task).toMatchObject({
      id: 'target',
      status: 'completed',
      userCompleted: true,
      sortOrder: 3,
    });
    expect(database.state()).toEqual([
      { id: 'completed-1', status: 'waiting', userCompleted: 1, sortOrder: 0 },
      { id: 'target', status: 'completed', userCompleted: 1, sortOrder: 3 },
    ]);
  });

  it('rolls back status, user completion, and completed ordering when final update fails', async () => {
    const database = createTransactionalTaskDatabase(
      [
        taskRow({ id: 'target', userCompleted: 0, sortOrder: 4 }),
        taskRow({ id: 'completed-1', userCompleted: 1, sortOrder: 0 }),
      ],
      true,
    );
    const priorState = database.state();

    await expect(
      createTaskCompletionOperations(database.db).markCompleted('target'),
    ).rejects.toThrow('completion rejected');

    expect(database.state()).toEqual(priorState);
  });
});

function taskRow(overrides: Partial<TaskRow>): TaskRow {
  return {
    id: 'task-1',
    projectId: 'project-1',
    type: 'pr-review',
    name: 'Review PR',
    prompt: 'Review PR',
    status: 'waiting',
    worktreePath: null,
    startCommitHash: null,
    sourceBranch: null,
    branchName: null,
    cleanupWorktreePath: null,
    cleanupBranchName: null,
    prWorkspaceState: null,
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
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    ...overrides,
  };
}

function createTransactionalTaskDatabase(
  initialRows: TaskRow[],
  rejectCompletion = false,
) {
  let persistedRows = structuredClone(initialRows);
  const transaction = () => ({
    execute: async <Result>(
      callback: (trx: ReturnType<typeof createTransaction>) => Promise<Result>,
    ): Promise<Result> => {
      const transactionRows = structuredClone(persistedRows);
      const result = await callback(
        createTransaction(transactionRows, rejectCompletion),
      );
      persistedRows = transactionRows;
      return result;
    },
  });

  return {
    db: { transaction } as unknown as Pick<
      Kysely<DatabaseSchema>,
      'transaction'
    >,
    state: () =>
      persistedRows
        .map(({ id, status, userCompleted, sortOrder }) => ({
          id,
          status,
          userCompleted,
          sortOrder,
        }))
        .sort(
          (left, right) =>
            left.userCompleted - right.userCompleted ||
            left.sortOrder - right.sortOrder,
        ),
  };
}

function createTransaction(rows: TaskRow[], rejectCompletion: boolean) {
  type Condition = [keyof TaskRow, unknown];
  const matches = (row: TaskRow, conditions: Condition[]) =>
    conditions.every(([column, value]) => row[column] === value);

  return {
    selectFrom: () => ({
      select: () => selectQuery(),
      selectAll: () => selectQuery(),
    }),
    updateTable: () => ({
      set: (
        values:
          | Partial<TaskRow>
          | ((expression: (
              column: keyof TaskRow,
              operator: '+',
              value: number,
            ) => { column: keyof TaskRow; operator: '+'; value: number }) =>
              Partial<
                Record<
                  keyof TaskRow,
                  { column: keyof TaskRow; operator: '+'; value: number }
                >
              >),
      ) => updateQuery(values),
    }),
  };

  function selectQuery() {
    const conditions: Condition[] = [];
    const query = {
      where: (column: keyof TaskRow, _operator: '=', value: unknown) => {
        conditions.push([column, value]);
        return query;
      },
      executeTakeFirstOrThrow: async () => {
        const row = rows.find((candidate) => matches(candidate, conditions));
        if (!row) throw new Error('task not found');
        return structuredClone(row);
      },
    };
    return query;
  }

  function updateQuery(
    values:
      | Partial<TaskRow>
      | ((expression: (
          column: keyof TaskRow,
          operator: '+',
          value: number,
        ) => { column: keyof TaskRow; operator: '+'; value: number }) =>
          Partial<
            Record<
              keyof TaskRow,
              { column: keyof TaskRow; operator: '+'; value: number }
            >
          >),
  ) {
    const conditions: Condition[] = [];
    const query = {
      where: (column: keyof TaskRow, _operator: '=', value: unknown) => {
        conditions.push([column, value]);
        return query;
      },
      execute: async () => {
        applyUpdate();
      },
      returningAll: () => ({
        executeTakeFirstOrThrow: async () => {
          applyUpdate();
          const row = rows.find((candidate) => matches(candidate, conditions));
          if (!row) throw new Error('task not found');
          return structuredClone(row);
        },
      }),
    };
    return query;

    function applyUpdate() {
      const resolvedValues =
        typeof values === 'function'
          ? values((column, operator, value) => ({ column, operator, value }))
          : values;
      if (rejectCompletion && resolvedValues.status === 'completed') {
        throw new Error('completion rejected');
      }
      for (const row of rows.filter((candidate) =>
        matches(candidate, conditions),
      )) {
        for (const [column, value] of Object.entries(resolvedValues)) {
          if (
            typeof value === 'object' &&
            value &&
            'operator' in value &&
            value.operator === '+'
          ) {
            const numericColumn = column as 'sortOrder';
            row[numericColumn] += value.value as number;
          } else {
            Object.assign(row, { [column]: value });
          }
        }
      }
    }
  }
}
