import { type Kysely, sql } from 'kysely';

type SettingsDatabase = {
  settings: {
    key: string;
    value: string;
    updatedAt: string;
  };
};

const WORK_ITEM_SUMMARY_SLOT = {
  backend: 'claude-code',
  model: 'haiku',
  thinkingEffort: 'default',
  skillName: 'work-item-summary',
};

function parseObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function isMigrationWorkItemSummarySlot(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  const slot = value as Record<string, unknown>;
  return (
    Object.keys(slot).length === Object.keys(WORK_ITEM_SUMMARY_SLOT).length &&
    slot.backend === WORK_ITEM_SUMMARY_SLOT.backend &&
    slot.model === WORK_ITEM_SUMMARY_SLOT.model &&
    slot.thinkingEffort === WORK_ITEM_SUMMARY_SLOT.thinkingEffort &&
    slot.skillName === WORK_ITEM_SUMMARY_SLOT.skillName
  );
}

async function getAiSkillSlotsSetting(db: Kysely<SettingsDatabase>) {
  return db
    .selectFrom('settings')
    .select('value')
    .where('key', '=', 'aiSkillSlots')
    .executeTakeFirst();
}

async function updateAiSkillSlotsSetting({
  db,
  value,
}: {
  db: Kysely<SettingsDatabase>;
  value: Record<string, unknown>;
}) {
  await db
    .updateTable('settings')
    .set({
      value: JSON.stringify(value),
      updatedAt: new Date().toISOString(),
    })
    .where('key', '=', 'aiSkillSlots')
    .execute();
}

async function enableWorkItemSummarySlot(db: Kysely<unknown>): Promise<void> {
  const settingsDb = db as Kysely<SettingsDatabase>;
  const row = await getAiSkillSlotsSetting(settingsDb);
  if (!row) return;

  const slots = parseObject(row.value);
  if (
    !slots ||
    Object.prototype.hasOwnProperty.call(slots, 'work-item-summary')
  ) {
    return;
  }

  await updateAiSkillSlotsSetting({
    db: settingsDb,
    value: {
      ...slots,
      'work-item-summary': WORK_ITEM_SUMMARY_SLOT,
    },
  });
}

async function disableWorkItemSummarySlot(db: Kysely<unknown>): Promise<void> {
  const settingsDb = db as Kysely<SettingsDatabase>;
  const row = await getAiSkillSlotsSetting(settingsDb);
  if (!row) return;

  const slots = parseObject(row.value);
  if (!slots || !isMigrationWorkItemSummarySlot(slots['work-item-summary'])) {
    return;
  }

  const revertedSlots = { ...slots };
  delete revertedSlots['work-item-summary'];
  await updateAiSkillSlotsSetting({ db: settingsDb, value: revertedSlots });
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('work_item_summaries')
    .addColumn('id', 'text', (col) =>
      col.primaryKey().defaultTo(sql`(lower(hex(randomblob(16))))`),
    )
    .addColumn('providerId', 'text', (col) =>
      col.notNull().references('providers.id').onDelete('cascade'),
    )
    .addColumn('workItemId', 'integer', (col) => col.notNull())
    .addColumn('content', 'text', (col) => col.notNull())
    .addColumn('sourceHash', 'text', (col) => col.notNull())
    .addColumn('sourceChangedDate', 'text')
    .addColumn('sourceLatestCommentId', 'integer')
    .addColumn('sourceCommentCount', 'integer', (col) => col.notNull())
    .addColumn('generatedAt', 'text', (col) => col.notNull())
    .addColumn('updatedAt', 'text', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('idx_work_item_summaries_provider_work_item')
    .on('work_item_summaries')
    .columns(['providerId', 'workItemId'])
    .unique()
    .execute();

  await enableWorkItemSummarySlot(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await disableWorkItemSummarySlot(db);
  await db.schema.dropTable('work_item_summaries').execute();
}
