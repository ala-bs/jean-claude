import { Kysely, sql } from 'kysely';

const LEGACY_ENV_SOURCES = ['taskName', 'projectName', 'availablePort'];

async function getColumnNames(db: Kysely<unknown>): Promise<Set<string>> {
  const result = await sql<{
    name: string;
  }>`PRAGMA table_info(project_commands)`.execute(db);
  return new Set(result.rows.map((row) => row.name));
}

function migrateLegacyEnvVarNames(value: string | null): string {
  if (!value) return '[]';

  try {
    const legacy = JSON.parse(value) as Record<string, unknown>;
    return JSON.stringify(
      LEGACY_ENV_SOURCES.map((source) => ({
        source,
        name: typeof legacy[source] === 'string' ? legacy[source].trim() : '',
      })).filter((envVar) => envVar.name.length > 0),
    );
  } catch {
    return '[]';
  }
}

function hasExistingEnvVars(value: string | null): boolean {
  if (!value) return false;
  try {
    const parsed = JSON.parse(value) as unknown[];
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const columns = await getColumnNames(db);

  if (!columns.has('envVars')) {
    await db.schema
      .alterTable('project_commands')
      .addColumn('envVars', 'text', (col) => col.defaultTo('[]').notNull())
      .execute();
  }

  if (!columns.has('envVarNames')) {
    return;
  }

  const rows = await sql<{
    id: string;
    envVarNames: string | null;
    envVars: string | null;
  }>`SELECT id, envVarNames, envVars FROM project_commands`.execute(db);

  for (const row of rows.rows) {
    if (hasExistingEnvVars(row.envVars)) continue;

    await sql`UPDATE project_commands SET envVars = ${migrateLegacyEnvVarNames(
      row.envVarNames,
    )} WHERE id = ${row.id}`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const columns = await getColumnNames(db);

  if (columns.has('envVars')) {
    await db.schema
      .alterTable('project_commands')
      .dropColumn('envVars')
      .execute();
  }
}
