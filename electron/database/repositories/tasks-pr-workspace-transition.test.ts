import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Kysely, SqliteDialect } from 'kysely';

import type { Database } from '../schema';
import { transitionActivePrWorkspacesToKept } from './pr-workspace-transitions';

let client: DatabaseSync;
let db: Kysely<Database>;

beforeEach(() => {
  client = new DatabaseSync(':memory:');
  client.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      type TEXT NOT NULL,
      pullRequestId TEXT,
      prWorkspaceState TEXT,
      prWorkspacePendingAt TEXT,
      updatedAt TEXT NOT NULL
    );
    INSERT INTO tasks VALUES
      ('first', 'project-1', 'pr-review', '12', 'active', NULL, 'old'),
      ('second', 'project-1', 'pr-review', '12', 'active', NULL, 'old'),
      ('kept', 'project-1', 'pr-review', '12', 'kept', NULL, 'old');
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
  db = new Kysely({ dialect: new SqliteDialect({ database: database as never }) });
});

afterEach(async () => {
  await db.destroy();
});

describe('transitionActivePrWorkspacesToKept', () => {
  it('rolls back a second-row failure, then retries with one durable timestamp', async () => {
    client.exec(`
      CREATE TRIGGER fail_second_kept_transition
      BEFORE UPDATE ON tasks
      WHEN OLD.id = 'second'
      BEGIN
        SELECT RAISE(ABORT, 'injected second update failure');
      END;
    `);
    const params = {
      projectId: 'project-1',
      pullRequestId: '12',
      taskIds: ['first', 'second'],
      keptAt: '2026-07-15T00:00:00.000Z',
    };

    await expect(
      transitionActivePrWorkspacesToKept(db, params),
    ).rejects.toThrow('injected second update failure');
    expect(
      client
        .prepare(
          'SELECT id, prWorkspaceState, prWorkspacePendingAt, updatedAt FROM tasks ORDER BY id',
        )
        .all(),
    ).toEqual([
      { id: 'first', prWorkspaceState: 'active', prWorkspacePendingAt: null, updatedAt: 'old' },
      { id: 'kept', prWorkspaceState: 'kept', prWorkspacePendingAt: null, updatedAt: 'old' },
      { id: 'second', prWorkspaceState: 'active', prWorkspacePendingAt: null, updatedAt: 'old' },
    ]);

    client.exec('DROP TRIGGER fail_second_kept_transition');
    await expect(
      transitionActivePrWorkspacesToKept(db, params),
    ).resolves.toHaveLength(2);
    expect(
      client
        .prepare(
          'SELECT id, prWorkspaceState, prWorkspacePendingAt FROM tasks ORDER BY id',
        )
        .all(),
    ).toEqual([
      { id: 'first', prWorkspaceState: 'kept', prWorkspacePendingAt: null },
      { id: 'kept', prWorkspaceState: 'kept', prWorkspacePendingAt: null },
      { id: 'second', prWorkspaceState: 'kept', prWorkspacePendingAt: null },
    ]);
  });

  it('rolls back when expected IDs are no longer all active', async () => {
    client.prepare("UPDATE tasks SET prWorkspaceState = 'cleanup-pending' WHERE id = 'second'").run();

    await expect(
      transitionActivePrWorkspacesToKept(db, {
        projectId: 'project-1',
        pullRequestId: '12',
        taskIds: ['first', 'second'],
      }),
    ).rejects.toThrow('state changed');
    expect(
      client.prepare("SELECT prWorkspaceState FROM tasks WHERE id = 'first'").get(),
    ).toEqual({ prWorkspaceState: 'active' });
  });
});
