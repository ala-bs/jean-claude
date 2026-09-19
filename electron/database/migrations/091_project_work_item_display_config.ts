import { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('projects')
    .addColumn('workItemDisplayConfig', 'text')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('projects')
    .dropColumn('workItemDisplayConfig')
    .execute();
}
