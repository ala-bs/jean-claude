import { Kysely } from 'kysely';

import type { Database, TaskRow } from '../schema';

/**
 * Closing or merging a PR retains its workspaces instead of queueing them for
 * cleanup: there is no cleanup prompt, so 'kept' is the terminal state and the
 * workspace stays fully usable until the user deletes it explicitly.
 */
export async function transitionActivePrWorkspacesToKept(
  database: Kysely<Database>,
  params: {
    projectId: string;
    pullRequestId: string;
    taskIds: string[];
    keptAt?: string;
  },
): Promise<TaskRow[]> {
  if (params.taskIds.length === 0) return [];
  const keptAt = params.keptAt ?? new Date().toISOString();
  return database.transaction().execute(async (trx) => {
    const rows = await trx
      .updateTable('tasks')
      .set({
        prWorkspaceState: 'kept',
        prWorkspacePendingAt: null,
        updatedAt: keptAt,
      })
      .where('id', 'in', params.taskIds)
      .where('projectId', '=', params.projectId)
      .where('pullRequestId', '=', params.pullRequestId)
      .where('type', '=', 'pr-review')
      .where('prWorkspaceState', '=', 'active')
      .returningAll()
      .execute();
    if (rows.length !== params.taskIds.length) {
      throw new Error('PR workspace state changed during keep transition');
    }
    return rows;
  });
}
