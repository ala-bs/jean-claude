import { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('project_command_groups')
    .addColumn('isFavorite', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('project_command_groups')
    .dropColumn('isFavorite')
    .execute();
}
