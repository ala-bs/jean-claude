import { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('project_env_vars')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('projectId', 'text', (col) =>
      col.notNull().references('projects.id').onDelete('cascade'),
    )
    .addColumn('key', 'text', (col) => col.notNull())
    .addColumn('value', 'text')
    .addColumn('valueEncrypted', 'text')
    .addColumn('isSecret', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('sortOrder', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('createdAt', 'text', (col) => col.notNull())
    .addColumn('updatedAt', 'text', (col) => col.notNull())
    .execute();

  // One value per key per project; lets upserts target a stable conflict key.
  await db.schema
    .createIndex('project_env_vars_project_key_unique')
    .on('project_env_vars')
    .columns(['projectId', 'key'])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('project_env_vars').execute();
}
