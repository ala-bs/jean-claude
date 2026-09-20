import { describe, expect, it } from 'vitest';
import { Kysely, SqliteDialect } from 'kysely';
import { DatabaseSync } from 'node:sqlite';
import { up } from './093_drop_project_default_backend';

/**
 * Guards the one risk in this migration: `projects` is referenced with
 * `ON DELETE CASCADE`, so recreating the table (the usual pattern for column
 * changes) would wipe tasks. `DROP COLUMN` avoids that — this test proves the
 * children survive.
 */
describe('093 drop project default backend', () => {
  it('drops the columns and keeps cascading children alive', async () => {
    const client = new DatabaseSync(':memory:');
    client.exec('PRAGMA foreign_keys = ON');
    client.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT,
        defaultAgentBackend TEXT, defaultAgentModelPreference TEXT, modelPolicy TEXT
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
      );
      INSERT INTO projects VALUES ('p1','n','claude-code','sonnet','{"mode":"inherit"}');
      INSERT INTO tasks VALUES ('t1','p1');
    `);
    const db = new Kysely<unknown>({
      dialect: new SqliteDialect({
        database: client as unknown as ConstructorParameters<
          typeof SqliteDialect
        >[0]['database'],
      }),
    });

    await up(db);

    const names = (
      client.prepare('PRAGMA table_info(projects)').all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(names).not.toContain('defaultAgentBackend');
    expect(names).not.toContain('defaultAgentModelPreference');
    expect(names).toContain('modelPolicy');

    const tasks = client.prepare('SELECT COUNT(*) AS c FROM tasks').get() as {
      c: number;
    };
    expect(Number(tasks.c)).toBe(1);

    expect(client.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });
});
