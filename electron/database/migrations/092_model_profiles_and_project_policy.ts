import { Kysely } from 'kysely';

/**
 * Model profiles & project policy.
 *
 * Adds `projects.modelPolicy`, the JSON text of a `ProjectModelPolicy`
 * (`null` = `{ mode: 'inherit' }`). Projects start clean: today's
 * `defaultAgentBackend` / `defaultAgentModelPreference` override is half-broken
 * (the model only applied when the backend happened to match), so nothing is
 * carried forward — policy is opt-in, set deliberately per project.
 *
 * NOTE — the drop of `defaultAgentBackend` / `defaultAgentModelPreference` is
 * intentionally NOT done here. `ipc/handlers.ts`, `step-service.ts`,
 * `pr-review-agent-service.ts` and the project settings UI still read *and
 * write* those columns; dropping them now would make every project-settings
 * save fail with "no such column" until those consumers move to profiles. They
 * are dropped in the cleanup migration that lands with T16, once the last
 * consumer is gone.
 */
/**
 * NOTE — no `PRAGMA foreign_key_check` here, on purpose.
 *
 * That check belongs to the table-recreation pattern (AGENTS.md), where
 * dropping and rebuilding a table really can orphan rows. Adding a nullable
 * column cannot violate any foreign key, so the check has nothing to catch.
 *
 * It is also actively harmful: unqualified `PRAGMA foreign_key_check` scans the
 * *entire* database, and the app connection never enables `PRAGMA
 * foreign_keys` (see `electron/database/index.ts`), so long-standing orphans —
 * e.g. `agent_messages` rows whose `raw_messages` parent was deleted — are
 * normal and expected. Failing this migration on them hard-blocks app startup
 * on a database that is otherwise perfectly usable.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('projects')
    .addColumn('modelPolicy', 'text')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('projects').dropColumn('modelPolicy').execute();
}
