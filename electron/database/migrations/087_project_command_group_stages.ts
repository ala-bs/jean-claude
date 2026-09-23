import { type Kysely, sql } from 'kysely';

/**
 * Command groups gain explicit stages. Existing groups are backfilled to a
 * single stage holding their current members with `waitForExit: false`, which
 * reproduces the previous all-at-once behavior exactly.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // SQLite commits DDL immediately and the backfill below is a separate
  // transaction, so a crash in between leaves the column added but the
  // migration unrecorded. Without this guard the retry would die on
  // "duplicate column name: stages" and the app could never start again.
  const columns = await sql<{
    name: string;
  }>`PRAGMA table_info(project_command_groups)`.execute(db);
  const hasStagesColumn = columns.rows.some((column) => column.name === 'stages');

  if (!hasStagesColumn) {
    await db.schema
      .alterTable('project_command_groups')
      .addColumn('stages', 'text', (col) => col.notNull().defaultTo('[]'))
      .execute();
  }

  // Only rows that have not been backfilled yet, so a retry after a partial
  // run cannot clobber stages that were already written.
  const rows = await sql<{
    id: string;
    commandIds: string;
  }>`SELECT id, commandIds FROM project_command_groups WHERE stages IS NULL OR stages = '[]'`.execute(
    db,
  );

  // One transaction: a partial backfill would leave groups with empty stages
  // but populated commandIds, silently making them unrunnable.
  await db.transaction().execute(async (trx) => {
    for (const row of rows.rows) {
      let commandIds: string[] = [];
      try {
        const parsed: unknown = JSON.parse(row.commandIds);
        if (Array.isArray(parsed)) {
          commandIds = parsed.filter(
            (value): value is string => typeof value === 'string',
          );
        }
      } catch {
        commandIds = [];
      }

      const stages =
        commandIds.length > 0
          ? [
              {
                id: crypto.randomUUID(),
                entries: commandIds.map((commandId) => ({
                  commandId,
                  waitForExit: false,
                })),
                delayMs: 0,
              },
            ]
          : [];

      await sql`UPDATE project_command_groups SET stages = ${JSON.stringify(stages)} WHERE id = ${row.id}`.execute(
        trx,
      );
    }
  });
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('project_command_groups')
    .dropColumn('stages')
    .execute();
}
