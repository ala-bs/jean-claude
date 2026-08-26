import { Kysely, sql } from 'kysely';

/**
 * The closed-PR cleanup prompt was removed, so nothing can resolve a workspace
 * out of 'cleanup-pending' anymore — and that state blocks agent runs. Heal any
 * workspace stuck in it by retaining it ('kept'), which is now the terminal
 * state when a PR is merged or closed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE tasks
    SET prWorkspaceState = 'kept',
        prWorkspacePendingAt = NULL
    WHERE prWorkspaceState = 'cleanup-pending'
  `.execute(db);
}

export async function down(): Promise<void> {
  // Irreversible: the original pending timestamps are not retained.
}
