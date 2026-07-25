import { Kysely } from 'kysely';

import type { Database, TaskRow } from '../schema';

export async function transitionActivePrWorkspacesToPending(
  database: Kysely<Database>,
  params: {
    projectId: string;
    pullRequestId: string;
    taskIds: string[];
    pendingAt?: string;
  },
): Promise<TaskRow[]> {
  if (params.taskIds.length === 0) return [];
  const pendingAt = params.pendingAt ?? new Date().toISOString();
  return database.transaction().execute(async (trx) => {
    const rows = await trx
      .updateTable('tasks')
      .set({
        prWorkspaceState: 'cleanup-pending',
        prWorkspacePendingAt: pendingAt,
        updatedAt: pendingAt,
      })
      .where('id', 'in', params.taskIds)
      .where('projectId', '=', params.projectId)
      .where('pullRequestId', '=', params.pullRequestId)
      .where('type', '=', 'pr-review')
      .where('prWorkspaceState', '=', 'active')
      .returningAll()
      .execute();
    if (rows.length !== params.taskIds.length) {
      throw new Error('PR workspace state changed during pending transition');
    }
    return rows;
  });
}
