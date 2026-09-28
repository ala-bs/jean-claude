import { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('mobile_build_artifacts')
    .addColumn('name', 'text')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('mobile_build_artifacts').dropColumn('name').execute();
}
