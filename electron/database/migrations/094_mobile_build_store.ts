import { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('mobile_build_artifacts')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('platform', 'text', (col) => col.notNull())
    .addColumn('packageId', 'text', (col) => col.notNull())
    .addColumn('appPath', 'text', (col) => col.notNull())
    .addColumn('fingerprint', 'text', (col) => col.notNull())
    .addColumn('buildCommand', 'text', (col) => col.notNull())
    .addColumn('artifactKind', 'text', (col) => col.notNull())
    .addColumn('artifactPath', 'text', (col) => col.notNull())
    .addColumn('sizeBytes', 'integer', (col) => col.notNull())
    .addColumn('createdAt', 'text', (col) => col.notNull())
    .addColumn('lastUsedAt', 'text')
    .execute();
  await db.schema
    .createIndex('mobile_build_artifacts_package_platform_created')
    .on('mobile_build_artifacts').columns(['packageId', 'platform', 'createdAt']).execute();
  await db.schema
    .createIndex('mobile_build_artifacts_package_platform_fingerprint')
    .on('mobile_build_artifacts').columns(['packageId', 'platform', 'fingerprint']).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('mobile_build_artifacts').execute();
}
