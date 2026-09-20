import { Kysely } from 'kysely';

/**
 * Drops the retired per-project model override columns
 * `projects.defaultAgentBackend` and `projects.defaultAgentModelPreference`.
 *
 * Migration 092 deliberately left them in place: the project settings UI still
 * *wrote* both through `ProjectRepository.update`, so dropping them there would
 * have failed every project save with "no such column". By now every writer is
 * gone (the fields are no longer part of `ProjectCreate` / `ProjectUpdate`) and
 * the remaining readers all fall back to the global/profile default when the
 * value is absent.
 *
 * Nothing is carried forward: migration 092 already decided that projects start
 * clean on `modelPolicy = { mode: 'inherit' }`, because the old override was
 * half-broken (the model only applied when the backend happened to match).
 *
 * `ALTER TABLE ... DROP COLUMN` is used rather than the table-recreation
 * pattern on purpose. Recreating `projects` means dropping it, and a large
 * number of tables reference it with `ON DELETE CASCADE`; the recreation dance
 * only exists for changes SQLite's ALTER cannot express (column types,
 * constraints). Dropping a plain, unindexed, unconstrained column is natively
 * supported, so the safe path is also the simple one.
 */
/**
 * NOTE — no `PRAGMA foreign_key_check` here, for the same reason as 092.
 *
 * Neither dropped column participates in a foreign key, and because the table
 * is altered in place rather than recreated, no child row can be orphaned. An
 * unqualified check would scan the whole database and fail on pre-existing
 * orphans (the runtime connection never enables `PRAGMA foreign_keys`), which
 * would block startup rather than protect anything. The accompanying test
 * asserts directly that cascading children survive this migration.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('projects')
    .dropColumn('defaultAgentBackend')
    .execute();
  await db.schema
    .alterTable('projects')
    .dropColumn('defaultAgentModelPreference')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Values are not restorable — the columns come back empty (NULL), which is
  // exactly "use the global default", the behaviour every reader falls back to.
  await db.schema
    .alterTable('projects')
    .addColumn('defaultAgentBackend', 'text')
    .execute();
  await db.schema
    .alterTable('projects')
    .addColumn('defaultAgentModelPreference', 'text')
    .execute();
}
