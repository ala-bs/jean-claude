import { join } from 'path';

import { Kysely, Migrator, sql, SqliteDialect } from 'kysely';
import { app } from 'electron';
import Database from 'better-sqlite3';

import { dbg } from '../lib/debug';

import type { AppSettings } from '@shared/types';

import { Database as DatabaseSchema } from './schema';
import { migrationProvider } from './migrator';


const defaultDbPath = join(app.getPath('userData'), 'jean-claude.db');
const dbPath = process.env.JEAN_CLAUDE_DB_PATH || defaultDbPath;

dbg.main('Using database at: %s', dbPath);

const client = new Database(dbPath);
client.pragma('journal_mode = WAL');

export const db = new Kysely<DatabaseSchema>({
  dialect: new SqliteDialect({
    database: client,
  }),
});

export async function migrateDatabase() {
  const migrator = new Migrator({
    db,
    provider: migrationProvider,
  });

  const { error, results } = await migrator.migrateToLatest();

  results?.forEach((result) => {
    if (result.status === 'Success') {
      dbg.dbMigration(
        'Migration "%s" executed successfully',
        result.migrationName,
      );
    } else if (result.status === 'Error') {
      dbg.dbMigration('Migration "%s" failed', result.migrationName);
    }
  });

  if (error) {
    dbg.dbMigration('Migration failed: %O', error);
    throw error;
  }

  await ensureRunCommandEnvVarsSchema();

  // Post-migration: re-normalize all tasks after v2 schema change
  const v2Applied = results?.some(
    (r) => r.migrationName === '028_v2_normalization' && r.status === 'Success',
  );

  if (v2Applied) {
    dbg.dbMigration(
      'Post-migration: re-normalizing all tasks with v2 normalizer...',
    );
    await reprocessAllTasksAfterV2Migration();
    dbg.dbMigration('Post-migration: v2 re-normalization complete');
  }

  const rawCompressionApplied = results?.some(
    (r) =>
      r.migrationName === '065_compress_raw_messages' && r.status === 'Success',
  );

  if (rawCompressionApplied) {
    dbg.dbMigration('Post-migration: vacuuming compressed raw messages...');
    await sql`PRAGMA wal_checkpoint(TRUNCATE)`.execute(db);
    await sql`VACUUM`.execute(db);
    await sql`PRAGMA wal_checkpoint(TRUNCATE)`.execute(db);
    dbg.dbMigration('Post-migration: raw message vacuum complete');
  }

  const promptPrefaceMigrationApplied = results?.some(
    (r) =>
      r.migrationName === '070_migrate_prompt_preface_array' &&
      r.status === 'Success',
  );

  if (promptPrefaceMigrationApplied) {
    await migrateProjectPromptPrefaces();
  }

  const modelSettingsStore = createDbModelSettingsStore();
  await migrateLegacyModelSettings(modelSettingsStore);
  await migrateModelProfilesToRevision1(modelSettingsStore);
}

const LEGACY_MODEL_SETTINGS_KEYS = [
  'backends',
  'backendDefaultModels',
  'thinkingSettings',
  'summaryModels',
  'prReviewAgent',
  'agentMemory',
  'rateLimitSwap',
  'aiSkillSlots',
] as const;

const DERIVED_MODEL_SETTINGS_KEYS = [
  // `backendModelPresets` is read only so the legacy migration can reuse the
  // user's own preset names; Revision 1 no longer writes it.
  'backendModelPresets',
  'modelProfiles',
  'activeModelProfileId',
  'modelFallbackOrder',
] as const;

/**
 * Minimal settings access used by the model-settings startup migration so it can
 * be tested without booting Electron or touching a real database.
 *
 * `readRaw` returns `undefined` when the setting has never been written, which is
 * how the migration distinguishes a fresh install (nothing to migrate) from an
 * upgrade (legacy keys present).
 */
export type ModelSettingsMigrationStore = {
  readRaw(key: string): Promise<unknown>;
  write<K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ): Promise<void>;
};

function createDbModelSettingsStore(): ModelSettingsMigrationStore {
  return {
    async readRaw(key) {
      const row = await db
        .selectFrom('settings')
        .where('key', '=', key)
        .select('value')
        .executeTakeFirst();
      if (!row) return undefined;
      try {
        return JSON.parse(row.value);
      } catch {
        return undefined;
      }
    },
    async write(key, value) {
      const { SettingsRepository } = await import('./repositories/settings');
      await SettingsRepository.set(key, value);
    },
  };
}

/**
 * Derives `modelProfiles` / `activeModelProfileId` / `modelFallbackOrder` (and any
 * new `backendModelPresets`) from the legacy model settings keys, once per install.
 *
 * Skipped when `modelProfiles` already holds at least one profile, so a user who
 * edited their profiles is never overwritten, and when no legacy key was ever
 * written (fresh install — the defaults already apply). The legacy keys are left
 * in place; they are removed separately.
 *
 * Returns `true` when values were written.
 */
export async function migrateLegacyModelSettings(
  store: ModelSettingsMigrationStore,
): Promise<boolean> {
  const existingProfiles = await store.readRaw('modelProfiles');
  if (Array.isArray(existingProfiles) && existingProfiles.length > 0) {
    return false;
  }

  const legacy: Record<string, unknown> = {};
  let hasLegacyValue = false;

  for (const key of LEGACY_MODEL_SETTINGS_KEYS) {
    const value = await store.readRaw(key);
    if (value === undefined) continue;
    legacy[key] = value;
    hasLegacyValue = true;
  }

  if (!hasLegacyValue) {
    dbg.dbMigration('Model settings migration: no legacy settings, skipping');
    return false;
  }

  for (const key of DERIVED_MODEL_SETTINGS_KEYS) {
    const value = await store.readRaw(key);
    if (value !== undefined) legacy[key] = value;
  }

  const { migrateLegacyModelSettingsToProfiles } = await import(
    './repositories/settings'
  );
  const migrated = migrateLegacyModelSettingsToProfiles(legacy);

  await store.write('modelProfiles', migrated.profiles);
  await store.write('activeModelProfileId', migrated.activeModelProfileId);
  await store.write('modelFallbackOrder', migrated.modelFallbackOrder);

  dbg.dbMigration(
    'Model settings migration: created %d profiles',
    migrated.profiles.length,
  );

  return true;
}

/**
 * Revision 0 → Revision 1 of the model-profiles storage, at startup.
 *
 * Stored profiles bound each role to the *id* of a preset in the global
 * `backendModelPresets` list. Revision 1 inlines that preset's triple into the
 * role and moves the preset list inside each profile (seeding
 * `quickPresetIds` from `showInQuickSwitcher`). The global keys are only READ
 * here; they are removed separately.
 *
 * Idempotent: profiles that already hold triples and own their presets are left
 * exactly as they are and nothing is written.
 *
 * Returns `true` when `modelProfiles` was rewritten.
 */
export async function migrateModelProfilesToRevision1(
  store: ModelSettingsMigrationStore,
): Promise<boolean> {
  const profiles = await store.readRaw('modelProfiles');
  if (!Array.isArray(profiles) || profiles.length === 0) return false;

  const { migrateProfilePresetIdBindings } = await import(
    './repositories/settings'
  );
  const migrated = migrateProfilePresetIdBindings({
    profiles,
    presets: await store.readRaw('backendModelPresets'),
  });

  if (!migrated) return false;

  await store.write('modelProfiles', migrated);
  dbg.dbMigration(
    'Model profiles revision 1: inlined role triples in %d profiles',
    migrated.length,
  );
  return true;
}

async function getTableColumnNames(tableName: string): Promise<Set<string>> {
  const result = await sql<{
    name: string;
  }>`PRAGMA table_info(${sql.raw(tableName)})`.execute(db);
  return new Set(result.rows.map((row) => row.name));
}

function migrateRunCommandEnvVarNames(value: string | null): string {
  if (!value) return '[]';

  try {
    const legacy = JSON.parse(value) as Record<string, unknown>;
    return JSON.stringify(
      ['taskName', 'projectName', 'availablePort']
        .map((source) => ({
          source,
          name: typeof legacy[source] === 'string' ? legacy[source].trim() : '',
        }))
        .filter((envVar) => envVar.name.length > 0),
    );
  } catch {
    return '[]';
  }
}

function hasExistingRunCommandEnvVars(value: string | null): boolean {
  if (!value) return false;
  try {
    const parsed = JSON.parse(value) as unknown[];
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

async function ensureRunCommandEnvVarsSchema(): Promise<void> {
  const columns = await getTableColumnNames('project_commands');

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
    if (hasExistingRunCommandEnvVars(row.envVars)) continue;

    await sql`UPDATE project_commands SET envVars = ${migrateRunCommandEnvVarNames(
      row.envVarNames,
    )} WHERE id = ${row.id}`.execute(db);
  }
}

async function migrateProjectPromptPrefaces(): Promise<void> {
  const { migrateProjectPromptPreface } = await import(
    '../services/permission-settings-service'
  );
  const projects = await db.selectFrom('projects').select('path').execute();
  let migratedCount = 0;

  for (const project of projects) {
    try {
      if (await migrateProjectPromptPreface(project.path)) {
        migratedCount += 1;
      }
    } catch (error) {
      dbg.dbMigration(
        'Failed to migrate project prompt preface for %s: %O',
        project.path,
        error,
      );
    }
  }

  dbg.dbMigration(
    'Post-migration: migrated %d project prompt preface settings',
    migratedCount,
  );
}

/**
 * After migration 028 creates the new empty agent_messages table,
 * re-normalize all raw_messages and create synthetic user-prompt entries
 * from each task's original prompt.
 */
async function reprocessAllTasksAfterV2Migration() {
  // Dynamic import to avoid circular dependency (repositories import db from this file)
  const { AgentMessageRepository } =
    await import('./repositories/agent-messages');
  const { nanoid } = await import('nanoid');

  // Get all task IDs that have raw_messages
  const taskRows = await db
    .selectFrom('raw_messages')
    .select('taskId')
    .groupBy('taskId')
    .execute();

  dbg.dbMigration('Re-normalizing %d tasks...', taskRows.length);

  for (const { taskId } of taskRows) {
    // Re-normalize from raw_messages → new flat entries
    const count = await AgentMessageRepository.reprocessNormalization(taskId);
    dbg.dbMigration('  Task %s: %d entries from raw messages', taskId, count);

    // Create a synthetic user-prompt entry from the task's original prompt.
    // The old system didn't store user prompts as separate entries; the v2
    // system does via persistAndEmitSyntheticEntry. Without this, the
    // conversation starts with the agent's response (missing the user input).
    const task = await db
      .selectFrom('tasks')
      .select(['prompt', 'createdAt'])
      .where('id', '=', taskId)
      .executeTakeFirst();

    if (task?.prompt && count > 0) {
      // Shift all existing entries to make room for user-prompt at index 0
      await sql`UPDATE agent_messages SET messageIndex = messageIndex + 1 WHERE taskId = ${taskId}`.execute(
        db,
      );

      await AgentMessageRepository.create({
        taskId,
        messageIndex: 0,
        entry: {
          id: nanoid(),
          date: task.createdAt,
          isSynthetic: true,
          type: 'user-prompt',
          value: task.prompt,
        },
        rawMessageId: null,
      });
    }
  }
}
