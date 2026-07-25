import {
  PrWorkspaceState,
  Task,
  TaskStatus,
  TaskTodoItem,
  TaskType,
} from '@shared/types';
import { sql } from 'kysely';


import { NewTaskRow, TaskRow, UpdateTaskRow } from '../schema';
import { db } from '../index';
import { dbg } from '../../lib/debug';
import { transitionActivePrWorkspacesToPending } from './pr-workspace-transitions';



// Input types for repository methods (matching shared types but with db-compatible values)
interface CreateTaskInput {
  id?: string;
  projectId: string;
  type?: TaskType;
  name?: string | null;
  prompt: string;
  status?: TaskStatus;
  worktreePath?: string | null;
  startCommitHash?: string | null;
  sourceBranch?: string | null;
  branchName?: string | null;
  prWorkspaceState?: PrWorkspaceState | null;
  hasUnread?: boolean;
  userCompleted?: boolean;
  workItemIds?: string[] | null;
  workItemUrls?: string[] | null;
  pullRequestId?: string | null;
  pullRequestUrl?: string | null;
  pendingMessage?: string | null;
  todoItems?: TaskTodoItem[];
  parentTaskId?: string | null;
  createdAt?: string;
  updatedAt: string;
}

interface UpdateTaskInput {
  projectId?: string;
  name?: string | null;
  prompt?: string;
  status?: TaskStatus;
  worktreePath?: string | null;
  startCommitHash?: string | null;
  sourceBranch?: string | null;
  branchName?: string | null;
  prWorkspaceState?: PrWorkspaceState | null;
  prWorkspacePendingAt?: string | null;
  hasUnread?: boolean;
  userCompleted?: boolean;
  workItemIds?: string[] | null;
  workItemUrls?: string[] | null;
  pullRequestId?: string | null;
  pullRequestUrl?: string | null;
  pendingMessage?: string | null;
  todoItems?: TaskTodoItem[];
  parentTaskId?: string | null;
  updatedAt?: string;
}

// Convert SQLite's 0/1 to boolean for userCompleted, and JSON strings to typed values
function toTask<T extends TaskRow>(
  row: T,
): Omit<
  T,
  | 'type'
  | 'userCompleted'
  | 'hasUnread'
  | 'prWorkspaceState'
  | 'prWorkspacePendingAt'
  | 'workItemIds'
  | 'workItemUrls'
  | 'todoItems'
  | 'cleanupWorktreePath'
  | 'cleanupBranchName'
> & {
  type: TaskType;
  userCompleted: boolean;
  hasUnread: boolean;
  prWorkspaceState: PrWorkspaceState | null;
  workItemIds: string[] | null;
  workItemUrls: string[] | null;
  todoItems: TaskTodoItem[];
} {
  const {
    type,
    userCompleted,
    hasUnread,
    prWorkspaceState,
    prWorkspacePendingAt: _prWorkspacePendingAt,
    workItemIds,
    workItemUrls,
    todoItems,
    cleanupWorktreePath: _cleanupWorktreePath,
    cleanupBranchName: _cleanupBranchName,
    ...rest
  } = row;
  if (
    prWorkspaceState !== null &&
    prWorkspaceState !== 'active' &&
    prWorkspaceState !== 'cleanup-pending' &&
    prWorkspaceState !== 'kept'
  ) {
    throw new Error(`Invalid PR workspace state: ${prWorkspaceState}`);
  }
  return {
    ...rest,
    type: (type ?? 'agent') as TaskType,
    userCompleted: Boolean(userCompleted),
    hasUnread: Boolean(hasUnread),
    prWorkspaceState,
    workItemIds: workItemIds ? JSON.parse(workItemIds) : null,
    workItemUrls: workItemUrls ? JSON.parse(workItemUrls) : null,
    todoItems: todoItems ? (JSON.parse(todoItems) as TaskTodoItem[]) : [],
  };
}

function toTaskOrUndefined<T extends TaskRow>(
  row: T | undefined,
):
  | (Omit<
      T,
      | 'type'
      | 'userCompleted'
      | 'hasUnread'
      | 'prWorkspaceState'
      | 'prWorkspacePendingAt'
      | 'workItemIds'
      | 'workItemUrls'
      | 'todoItems'
      | 'cleanupWorktreePath'
      | 'cleanupBranchName'
    > & {
      type: TaskType;
      userCompleted: boolean;
      hasUnread: boolean;
      prWorkspaceState: PrWorkspaceState | null;
      workItemIds: string[] | null;
      workItemUrls: string[] | null;
      todoItems: TaskTodoItem[];
    })
  | undefined {
  return row ? toTask(row) : undefined;
}

// Convert boolean userCompleted to number and structured values to JSON for database
function toDbValues(data: CreateTaskInput): NewTaskRow {
  const {
    userCompleted,
    hasUnread,
    workItemIds,
    workItemUrls,
    todoItems,
    ...rest
  } = data;
  return {
    ...rest,
    ...(userCompleted !== undefined && {
      userCompleted: userCompleted ? 1 : 0,
    }),
    ...(hasUnread !== undefined && { hasUnread: hasUnread ? 1 : 0 }),
    ...(workItemIds !== undefined && {
      workItemIds: workItemIds ? JSON.stringify(workItemIds) : null,
    }),
    ...(workItemUrls !== undefined && {
      workItemUrls: workItemUrls ? JSON.stringify(workItemUrls) : null,
    }),
    ...(todoItems !== undefined && {
      todoItems: JSON.stringify(todoItems),
    }),
  } as NewTaskRow;
}

function toDbUpdateValues(data: UpdateTaskInput): Partial<UpdateTaskRow> {
  const {
    userCompleted,
    hasUnread,
    workItemIds,
    workItemUrls,
    todoItems,
    ...rest
  } = data;
  return {
    ...rest,
    ...(userCompleted !== undefined && {
      userCompleted: userCompleted ? 1 : 0,
    }),
    ...(hasUnread !== undefined && { hasUnread: hasUnread ? 1 : 0 }),
    ...(workItemIds !== undefined && {
      workItemIds: workItemIds ? JSON.stringify(workItemIds) : null,
    }),
    ...(workItemUrls !== undefined && {
      workItemUrls: workItemUrls ? JSON.stringify(workItemUrls) : null,
    }),
    ...(todoItems !== undefined && {
      todoItems: JSON.stringify(todoItems),
    }),
  };
}

export const TaskRepository = {
  findAll: async () => {
    const rows = await db.selectFrom('tasks').selectAll().execute();
    return rows.map(toTask);
  },

  findByProjectId: async (projectId: string) => {
    const rows = await db
      .selectFrom('tasks')
      .selectAll('tasks')
      .where('projectId', '=', projectId)
      .orderBy('userCompleted', 'asc') // Active tasks first (0), then completed (1)
      .orderBy('sortOrder', 'asc')
      .execute();
    return rows.map(toTask);
  },

  findAllActive: async () => {
    const rows = await db
      .selectFrom('tasks')
      .innerJoin('projects', 'projects.id', 'tasks.projectId')
      .selectAll('tasks')
      .select([
        'projects.name as projectName',
        'projects.color as projectColor',
        'projects.logoPath as projectLogoPath',
        'projects.repoProviderId as repoProviderId',
        'projects.repoId as repoId',
      ])
      .where('tasks.userCompleted', '=', 0)
      .where('tasks.parentTaskId', 'is', null)
      .where('projects.archivedAt', 'is', null)
      .orderBy('tasks.createdAt', 'desc')
      .execute();
    return rows.map(toTask);
  },

  findPrWorkspaceTasksForFeed: async () => {
    const rows = await db
      .selectFrom('tasks')
      .innerJoin('projects', 'projects.id', 'tasks.projectId')
      .selectAll('tasks')
      .select([
        'projects.name as projectName',
        'projects.color as projectColor',
        'projects.logoPath as projectLogoPath',
        'projects.repoProviderId as repoProviderId',
        'projects.repoId as repoId',
      ])
      .where('tasks.type', '=', 'pr-review')
      .where('tasks.prWorkspaceState', 'is not', null)
      .where('tasks.parentTaskId', 'is', null)
      .where('projects.archivedAt', 'is', null)
      .orderBy('tasks.createdAt', 'desc')
      .execute();
    return rows.map(toTask);
  },

  findChildrenForTasks: async (parentTaskIds: string[]) => {
    if (parentTaskIds.length === 0) return {};
    const rows = await db
      .selectFrom('tasks')
      .innerJoin('projects', 'projects.id', 'tasks.projectId')
      .selectAll('tasks')
      .select([
        'projects.name as projectName',
        'projects.color as projectColor',
        'projects.logoPath as projectLogoPath',
        'projects.repoProviderId as repoProviderId',
        'projects.repoId as repoId',
      ])
      .where('tasks.parentTaskId', 'in', parentTaskIds)
      .where('projects.archivedAt', 'is', null)
      .orderBy('tasks.sortOrder', 'asc')
      .execute();

    const grouped: Record<string, (typeof rows)[number][]> = {};
    for (const row of rows) {
      const pid = row.parentTaskId!;
      if (!grouped[pid]) grouped[pid] = [];
      grouped[pid].push(row);
    }
    return grouped;
  },

  findByParentTaskId: async (parentTaskId: string) => {
    const rows = await db
      .selectFrom('tasks')
      .selectAll()
      .where('parentTaskId', '=', parentTaskId)
      .orderBy('sortOrder', 'asc')
      .execute();
    return rows.map(toTask);
  },

  findAllCompleted: async ({
    limit,
    offset,
  }: {
    limit: number;
    offset: number;
  }) => {
    const rows = await db
      .selectFrom('tasks')
      .innerJoin('projects', 'projects.id', 'tasks.projectId')
      .selectAll('tasks')
      .select([
        'projects.name as projectName',
        'projects.color as projectColor',
        'projects.logoPath as projectLogoPath',
      ])
      .where('tasks.userCompleted', '=', 1)
      .where('projects.archivedAt', 'is', null)
      .orderBy('tasks.updatedAt', 'desc')
      .limit(limit)
      .offset(offset)
      .execute();

    // Get total count for pagination
    const countResult = await db
      .selectFrom('tasks')
      .innerJoin('projects', 'projects.id', 'tasks.projectId')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where('tasks.userCompleted', '=', 1)
      .where('projects.archivedAt', 'is', null)
      .executeTakeFirstOrThrow();

    return {
      tasks: rows.map(toTask),
      total: countResult.total,
    };
  },

  findById: async (id: string) => {
    const row = await db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return toTaskOrUndefined(row);
  },

  getVerifiedCleanupIdentity: async (id: string) => {
    const row = await db
      .selectFrom('tasks')
      .select(['cleanupWorktreePath', 'cleanupBranchName'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row?.cleanupWorktreePath || !row.cleanupBranchName) return undefined;
    return {
      worktreePath: row.cleanupWorktreePath,
      branchName: row.cleanupBranchName,
    };
  },

  markCleanupIdentityVerified: async (
    id: string,
    identity: { worktreePath: string; branchName: string },
  ) => {
    const result = await db
      .updateTable('tasks')
      .set({
        cleanupWorktreePath: identity.worktreePath,
        cleanupBranchName: identity.branchName,
      })
      .where('id', '=', id)
      .where('worktreePath', '=', identity.worktreePath)
      .where('branchName', '=', identity.branchName)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) {
      throw new Error(`Task ${id} worktree identity changed during cleanup`);
    }
  },

  clearCleanupIdentity: (id: string) =>
    db
      .updateTable('tasks')
      .set({ cleanupWorktreePath: null, cleanupBranchName: null })
      .where('id', '=', id)
      .execute(),

  findActivePrReviewTask: async ({
    projectId,
    pullRequestId,
  }: {
    projectId: string;
    pullRequestId: string;
  }) => {
    const row = await db
      .selectFrom('tasks')
      .selectAll()
      .where('projectId', '=', projectId)
      .where('type', '=', 'pr-review')
      .where('pullRequestId', '=', pullRequestId)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    return toTaskOrUndefined(row);
  },

  findPrReviewTasksByPullRequest: async ({
    projectId,
    pullRequestId,
  }: {
    projectId: string;
    pullRequestId: string;
  }) => {
    const rows = await db
      .selectFrom('tasks')
      .selectAll()
      .where('projectId', '=', projectId)
      .where('type', '=', 'pr-review')
      .where('pullRequestId', '=', pullRequestId)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return rows.map(toTask);
  },

  findPendingPrWorkspaceTasks: async () => {
    const rows = await db
      .selectFrom('tasks')
      .selectAll()
      .where('prWorkspaceState', '=', 'cleanup-pending')
      .where('type', '=', 'pr-review')
      .orderBy('prWorkspacePendingAt', 'asc')
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map(toTask);
  },

  setPrWorkspaceState: async (
    id: string,
    prWorkspaceState: 'active' | 'cleanup-pending' | 'kept',
  ) => {
    const row = await db
      .updateTable('tasks')
      .set({
        prWorkspaceState,
        prWorkspacePendingAt:
          prWorkspaceState === 'cleanup-pending'
            ? new Date().toISOString()
            : null,
        ...(prWorkspaceState === 'active' && {
          status: sql<TaskStatus>`CASE WHEN status = 'completed' THEN 'waiting' ELSE status END`,
          userCompleted: 0,
        }),
        updatedAt: new Date().toISOString(),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toTask(row);
  },

  markPrWorkspacesCleanupPending: async (params: {
    projectId: string;
    pullRequestId: string;
    taskIds: string[];
  }): Promise<Task[]> =>
    (await transitionActivePrWorkspacesToPending(db, params)).map(toTask),

  keepPrWorkspaces: async (ids: string[]): Promise<Task[]> => {
    if (ids.length === 0) return [];
    return db.transaction().execute(async (trx) => {
      const rows = await trx
        .updateTable('tasks')
        .set({
          prWorkspaceState: 'kept',
          prWorkspacePendingAt: null,
          status: sql<TaskStatus>`CASE WHEN status = 'completed' THEN 'waiting' ELSE status END`,
          userCompleted: 0,
          updatedAt: new Date().toISOString(),
        })
        .where('id', 'in', ids)
        .where('type', '=', 'pr-review')
        .where('prWorkspaceState', '=', 'cleanup-pending')
        .returningAll()
        .execute();
      if (rows.length !== ids.length) {
        throw new Error('PR workspace state changed during keep resolution');
      }
      return rows.map(toTask);
    });
  },

  reactivatePrWorkspaces: async (ids: string[]): Promise<Task[]> => {
    if (ids.length === 0) return [];
    return db.transaction().execute(async (trx) => {
      const rows = await trx
        .updateTable('tasks')
        .set({
          prWorkspaceState: 'active',
          prWorkspacePendingAt: null,
          status: sql<TaskStatus>`CASE WHEN status = 'completed' THEN 'waiting' ELSE status END`,
          userCompleted: 0,
          updatedAt: new Date().toISOString(),
        })
        .where('id', 'in', ids)
        .where('type', '=', 'pr-review')
        .where('prWorkspaceState', 'in', ['cleanup-pending', 'kept'])
        .returningAll()
        .execute();
      if (rows.length !== ids.length) {
        throw new Error('PR workspace state changed during reactivation');
      }
      return rows.map(toTask);
    });
  },

  /** Returns the set of IDs that exist in the database from the given list. */
  findExistingIds: async (ids: string[]): Promise<Set<string>> => {
    if (ids.length === 0) return new Set();
    const rows = await db
      .selectFrom('tasks')
      .select('id')
      .where('id', 'in', ids)
      .execute();
    return new Set(rows.map((r) => r.id));
  },

  create: async (data: CreateTaskInput) => {
    dbg.db('tasks.create projectId=%s, name=%s', data.projectId, data.name);
    // Shift all existing active tasks in this project down (increment sortOrder)
    await db
      .updateTable('tasks')
      .set((eb) => ({
        sortOrder: eb('sortOrder', '+', 1),
      }))
      .where('projectId', '=', data.projectId)
      .where('userCompleted', '=', 0)
      .execute();

    // Insert new task with sortOrder 0 (top of active list)
    const row = await db
      .insertInto('tasks')
      .values({ ...toDbValues(data), sortOrder: 0 })
      .returningAll()
      .executeTakeFirstOrThrow();
    dbg.db('tasks.create created id=%s', row.id);
    return toTask(row);
  },

  update: async (id: string, data: UpdateTaskInput) => {
    dbg.db('tasks.update id=%s %o', id, Object.keys(data));
    const changedKeys = Object.keys(data).filter((key) => key !== 'updatedAt');
    const shouldUpdateTimestamp =
      changedKeys.length !== 1 || changedKeys[0] !== 'name';
    const row = await db
      .updateTable('tasks')
      .set({
        ...toDbUpdateValues(data),
        ...(shouldUpdateTimestamp && { updatedAt: new Date().toISOString() }),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toTask(row);
  },

  updatePendingMessage: async (
    id: string,
    pendingMessage: string | null,
  ): Promise<Task> => {
    dbg.db('tasks.updatePendingMessage id=%s', id);
    const row = await db
      .updateTable('tasks')
      .set({ pendingMessage })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toTask(row) as Task;
  },

  delete: (id: string) => {
    dbg.db('tasks.delete id=%s', id);
    return db.deleteFrom('tasks').where('id', '=', id).execute();
  },

  deleteMany: (ids: string[]) => {
    if (ids.length === 0) return Promise.resolve([]);
    dbg.db('tasks.deleteMany count=%d', ids.length);
    return db.deleteFrom('tasks').where('id', 'in', ids).execute();
  },

  setHasUnread: async (id: string, hasUnread: boolean): Promise<Task | undefined> => {
    const hasUnreadValue = hasUnread ? 1 : 0;
    const row = await db
      .updateTable('tasks')
      .set({
        hasUnread: hasUnreadValue,
        updatedAt: new Date().toISOString(),
      })
      .where('id', '=', id)
      .where('hasUnread', '!=', hasUnreadValue)
      .returningAll()
      .executeTakeFirst();
    return row ? toTask(row) : undefined;
  },

  toggleUserCompleted: async (id: string): Promise<Task> => {
    // First get current value and projectId
    const current = await db
      .selectFrom('tasks')
      .select(['userCompleted', 'projectId'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    const newValue = current.userCompleted ? 0 : 1;
    const targetSection = newValue; // 0 = active, 1 = completed

    // Shift all existing tasks in the target section down (increment sortOrder)
    await db
      .updateTable('tasks')
      .set((eb) => ({
        sortOrder: eb('sortOrder', '+', 1),
      }))
      .where('projectId', '=', current.projectId)
      .where('userCompleted', '=', targetSection)
      .execute();

    // Update the task: toggle completion and move to top of target section (sortOrder 0)
    const row = await db
      .updateTable('tasks')
      .set({
        userCompleted: newValue,
        sortOrder: 0,
        updatedAt: new Date().toISOString(),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toTask(row) as Task;
  },

  markUserCompleted: async (id: string): Promise<Task> => {
    return db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('tasks')
        .select(['userCompleted', 'projectId'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

      if (current.userCompleted) {
        const row = await trx
          .selectFrom('tasks')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        return toTask(row) as Task;
      }

      await trx
        .updateTable('tasks')
        .set((eb) => ({
          sortOrder: eb('sortOrder', '+', 1),
        }))
        .where('projectId', '=', current.projectId)
        .where('userCompleted', '=', 1)
        .execute();

      const row = await trx
        .updateTable('tasks')
        .set({
          userCompleted: 1,
          sortOrder: 0,
          updatedAt: new Date().toISOString(),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();

      return toTask(row) as Task;
    });
  },

  clearUserCompleted: async (id: string): Promise<Task> => {
    const row = await db
      .updateTable('tasks')
      .set({ userCompleted: 0, updatedAt: new Date().toISOString() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toTask(row) as Task;
  },

  findByStatuses: async (statuses: TaskStatus[]): Promise<Task[]> => {
    const rows = await db
      .selectFrom('tasks')
      .selectAll()
      .where('status', 'in', statuses)
      .execute();
    return rows.map(toTask);
  },

  reorder: async (
    projectId: string,
    activeIds: string[],
    completedIds: string[],
  ): Promise<Task[]> => {
    const now = new Date().toISOString();

    // Update sortOrder for active tasks
    for (let i = 0; i < activeIds.length; i++) {
      await db
        .updateTable('tasks')
        .set({ sortOrder: i, updatedAt: now })
        .where('id', '=', activeIds[i])
        .execute();
    }

    // Update sortOrder for completed tasks
    for (let i = 0; i < completedIds.length; i++) {
      await db
        .updateTable('tasks')
        .set({ sortOrder: i, updatedAt: now })
        .where('id', '=', completedIds[i])
        .execute();
    }

    // Return all tasks in new order
    const rows = await db
      .selectFrom('tasks')
      .selectAll('tasks')
      .where('projectId', '=', projectId)
      .orderBy('userCompleted', 'asc')
      .orderBy('sortOrder', 'asc')
      .execute();
    return rows.map(toTask);
  },
};
