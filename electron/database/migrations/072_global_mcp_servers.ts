import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('global_mcp_servers')
    .addColumn('id', 'text', (col) =>
      col.primaryKey().defaultTo(sql`(lower(hex(randomblob(16))))`),
    )
    .addColumn('name', 'text', (col) => col.notNull().unique())
    .addColumn('normalizedName', 'text', (col) => col.notNull().unique())
    .addColumn('transportType', 'text', (col) => col.notNull().defaultTo('stdio'))
    .addColumn('command', 'text')
    .addColumn('args', 'text', (col) => col.notNull().defaultTo('[]'))
    .addColumn('env', 'text', (col) => col.notNull().defaultTo('{}'))
    .addColumn('envManaged', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('url', 'text')
    .addColumn('enabledBackends', 'text', (col) => col.notNull().defaultTo('[]'))
    .addColumn('backendStates', 'text', (col) => col.notNull().defaultTo('{}'))
    .addColumn('createdAt', 'text', (col) =>
      col.notNull().defaultTo(sql`(datetime('now'))`),
    )
    .addColumn('updatedAt', 'text', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('global_mcp_servers').execute();
}
