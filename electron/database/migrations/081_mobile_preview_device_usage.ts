import { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('mobile_preview_device_usage')
    .addColumn('deviceKey', 'text', (col) => col.primaryKey())
    .addColumn('platform', 'text', (col) => col.notNull())
    .addColumn('deviceId', 'text', (col) => col.notNull())
    .addColumn('taskId', 'text', (col) =>
      col.notNull().references('tasks.id').onDelete('cascade'),
    )
    .addColumn('lastUsedAt', 'text', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('mobile_preview_device_usage_task_id')
    .on('mobile_preview_device_usage')
    .column('taskId')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('mobile_preview_device_usage').execute();
}
