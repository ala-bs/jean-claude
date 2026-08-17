import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Kysely, SqliteDialect } from 'kysely';

import { down, up } from './081_mobile_preview_device_usage';

let client: DatabaseSync;
let db: Kysely<unknown>;

beforeEach(() => {
  client = new DatabaseSync(':memory:');
  // node:sqlite turns foreign keys ON by default; the production connection
  // uses better-sqlite3, which leaves them OFF (electron/database/index.ts sets
  // only journal_mode). Force them off so this harness matches the real app.
  client.exec('PRAGMA foreign_keys = OFF');
  client.exec(`
    CREATE TABLE tasks (id TEXT NOT NULL PRIMARY KEY, name TEXT);
    INSERT INTO tasks (id, name) VALUES ('task-1', 'add extras');
    INSERT INTO tasks (id, name) VALUES ('task-2', 'persist devices');
  `);

  const database = {
    prepare(statement: string) {
      const prepared = client.prepare(statement);
      return {
        reader: prepared.columns().length > 0,
        all: (parameters: readonly unknown[]) =>
          prepared.all(...(parameters as SQLInputValue[])),
        run: (parameters: readonly unknown[]) =>
          prepared.run(...(parameters as SQLInputValue[])),
        iterate: (parameters: readonly unknown[]) =>
          prepared.iterate(...(parameters as SQLInputValue[])),
      };
    },
    close: () => client.close(),
  };
  db = new Kysely({
    dialect: new SqliteDialect({ database: database as never }),
  });
});

afterEach(async () => {
  await db.destroy();
});

function hasObject(type: 'table' | 'index', name: string) {
  return Boolean(
    client
      .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
      .get(type, name),
  );
}

function listUsage() {
  return client
    .prepare('SELECT deviceKey, taskId FROM mobile_preview_device_usage')
    .all();
}

function recordUsage(deviceId: string, taskId: string, lastUsedAt: string) {
  client
    .prepare(
      `INSERT INTO mobile_preview_device_usage
         (deviceKey, platform, deviceId, taskId, lastUsedAt)
       VALUES (?, 'ios', ?, ?, ?)
       ON CONFLICT (deviceKey) DO UPDATE SET
         taskId = excluded.taskId, lastUsedAt = excluded.lastUsedAt`,
    )
    .run(`ios:${deviceId}`, deviceId, taskId, lastUsedAt);
}

describe('081_mobile_preview_device_usage', () => {
  it('creates the table and its task index', async () => {
    await up(db);

    expect(hasObject('table', 'mobile_preview_device_usage')).toBe(true);
    expect(hasObject('index', 'mobile_preview_device_usage_task_id')).toBe(true);
  });

  it('keeps one row per device, reattributing it to the newest task', async () => {
    await up(db);

    recordUsage('device-1', 'task-1', '2026-01-01T00:00:00.000Z');
    recordUsage('device-1', 'task-2', '2026-01-02T00:00:00.000Z');

    // No exclusivity is enforced; a device simply belongs to its latest task.
    expect(listUsage()).toEqual([
      { deviceKey: 'ios:device-1', taskId: 'task-2' },
    ]);
  });

  it('orphans rows when a task is deleted, because foreign keys are off', async () => {
    await up(db);
    recordUsage('device-1', 'task-1', '2026-01-01T00:00:00.000Z');

    client.prepare("DELETE FROM tasks WHERE id = 'task-1'").run();

    // The declared ON DELETE CASCADE does not fire without PRAGMA
    // foreign_keys, which is why the repository filters orphans on read.
    expect(listUsage()).toHaveLength(1);
  });

  it('is reversible', async () => {
    await up(db);
    await down(db);

    expect(hasObject('table', 'mobile_preview_device_usage')).toBe(false);
  });
});
