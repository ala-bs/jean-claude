import { Kysely, sql } from 'kysely';

async function getColumnNames(db: Kysely<unknown>): Promise<Set<string>> {
  const result = await sql<{
    name: string;
  }>`PRAGMA table_info(project_commands)`.execute(db);
  return new Set(result.rows.map((row) => row.name));
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const columns = await getColumnNames(db);

  if (!columns.has('portConflictStrategy')) {
    await db.schema
      .alterTable('project_commands')
      .addColumn('portConflictStrategy', 'text', (col) =>
        col.defaultTo('prompt').notNull(),
      )
      .execute();
  }

  if (!columns.has('portOverrideEnvVar')) {
    await db.schema
      .alterTable('project_commands')
      .addColumn('portOverrideEnvVar', 'text')
      .execute();
  }

  if (!columns.has('portOverrideProvider')) {
    await db.schema
      .alterTable('project_commands')
      .addColumn('portOverrideProvider', 'text', (col) =>
        col.defaultTo('env').notNull(),
      )
      .execute();
  }

  if (!columns.has('portOverrideArgs')) {
    await db.schema
      .alterTable('project_commands')
      .addColumn('portOverrideArgs', 'text')
      .execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const columns = await getColumnNames(db);

  if (columns.has('portOverrideArgs')) {
    await db.schema
      .alterTable('project_commands')
      .dropColumn('portOverrideArgs')
      .execute();
  }

  if (columns.has('portOverrideProvider')) {
    await db.schema
      .alterTable('project_commands')
      .dropColumn('portOverrideProvider')
      .execute();
  }

  if (columns.has('portOverrideEnvVar')) {
    await db.schema
      .alterTable('project_commands')
      .dropColumn('portOverrideEnvVar')
      .execute();
  }

  if (columns.has('portConflictStrategy')) {
    await db.schema
      .alterTable('project_commands')
      .dropColumn('portConflictStrategy')
      .execute();
  }
}
