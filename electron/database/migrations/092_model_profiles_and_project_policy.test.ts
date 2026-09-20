import { describe, expect, it } from 'vitest';
import { Kysely, SqliteDialect } from 'kysely';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { up as up092 } from './092_model_profiles_and_project_policy';
import { up as up093 } from './093_drop_project_default_backend';

/**
 * Regression guard: these migrations must not fail on pre-existing orphans.
 *
 * The runtime connection never enables `PRAGMA foreign_keys`
 * (`electron/database/index.ts`), so rows whose parent was deleted are normal
 * in a real database — e.g. `agent_messages` pointing at a removed
 * `raw_messages`. An earlier version of both migrations ran an unqualified
 * `PRAGMA foreign_key_check`, which scans the *whole* database, and threw
 * `Foreign key violation: […]` on that pre-existing data — blocking app
 * startup entirely on a database that was otherwise fine.
 *
 * Neither migration touches a foreign key, so neither may care about them.
 */
function seedWithOrphans() {
  const client = new DatabaseSync(':memory:');
  // Mirror production: `electron/database/index.ts` never enables
  // `PRAGMA foreign_keys`, which is exactly why orphans exist in real
  // databases. node:sqlite enables it by default, so turn it off.
  client.exec('PRAGMA foreign_keys = OFF');
  client.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT,
      defaultAgentBackend TEXT, defaultAgentModelPreference TEXT
    );
    CREATE TABLE raw_messages (id TEXT PRIMARY KEY);
    CREATE TABLE agent_messages (
      id TEXT PRIMARY KEY,
      rawMessageId TEXT REFERENCES raw_messages(id)
    );
    INSERT INTO projects VALUES ('p1','n','claude-code','sonnet');
    -- parent row deliberately absent: this is the orphan that broke startup
    INSERT INTO agent_messages VALUES ('m1','deleted-raw-message');
  `);
  const db = new Kysely<unknown>({
    dialect: new SqliteDialect({
      database: client as unknown as ConstructorParameters<
        typeof SqliteDialect
      >[0]['database'],
    }),
  });
  return { client, db };
}

describe('092/093 with pre-existing foreign key orphans', () => {
  it('confirms the fixture really does contain an orphan', () => {
    const { client } = seedWithOrphans();
    expect(client.prepare('PRAGMA foreign_key_check').all().length).toBeGreaterThan(
      0,
    );
  });

  // The behavioural tests below cannot catch a reintroduced whole-database
  // check: Kysely's dialect over `node:sqlite` returns no rows for PRAGMA
  // statements, so `foreign_key_check` reads as empty in tests even when it
  // would throw under better-sqlite3 in the real app. Assert on the source
  // instead — that guard does hold.
  it.each([
    '092_model_profiles_and_project_policy.ts',
    '093_drop_project_default_backend.ts',
  ])('%s does not run a whole-database foreign key check', (file) => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/PRAGMA foreign_key_check(?!\s*\()/);
  });

  it('092 adds modelPolicy without failing on unrelated orphans', async () => {
    const { client, db } = seedWithOrphans();
    await expect(up092(db)).resolves.not.toThrow();
    const names = (
      client.prepare('PRAGMA table_info(projects)').all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(names).toContain('modelPolicy');
  });

  it('093 drops the retired columns without failing on unrelated orphans', async () => {
    const { client, db } = seedWithOrphans();
    await up092(db);
    await expect(up093(db)).resolves.not.toThrow();
    const names = (
      client.prepare('PRAGMA table_info(projects)').all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(names).not.toContain('defaultAgentBackend');
    expect(names).not.toContain('defaultAgentModelPreference');
    // the unrelated orphan is left exactly as it was — not "repaired", not fatal
    expect(
      (client.prepare('SELECT COUNT(*) AS c FROM agent_messages').get() as {
        c: number;
      }).c,
    ).toBe(1);
  });
});
