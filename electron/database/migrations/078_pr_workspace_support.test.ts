import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  constants,
  DatabaseSync,
  type SQLInputValue,
} from 'node:sqlite';
import { Kysely, sql, SqliteDialect } from 'kysely';

import { down, up } from './078_pr_workspace_support';

let client: DatabaseSync;
let db: Kysely<unknown>;
let failStatement: ((statement: string) => boolean) | undefined;

const RULES = JSON.stringify({ bash: { 'git status': 'allow' }, read: 'allow' });

beforeEach(() => {
  client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  client.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE tasks (
      id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT DEFAULT 'agent', name TEXT, prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting', worktreePath TEXT,
      startCommitHash TEXT, sourceBranch TEXT, branchName TEXT,
      hasUnread INTEGER NOT NULL DEFAULT 0,
      userCompleted INTEGER NOT NULL DEFAULT 0, sessionRules TEXT,
      sortOrder INTEGER NOT NULL DEFAULT 0, workItemIds TEXT, workItemUrls TEXT,
      pullRequestId TEXT, pullRequestUrl TEXT, pendingMessage TEXT,
      todoItems TEXT, parentTaskId TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL
    );
    CREATE INDEX idx_tasks_parent_task_id ON tasks(parentTaskId);
    CREATE TABLE task_steps (
      id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'agent',
      dependsOn TEXT NOT NULL DEFAULT '[]', promptTemplate TEXT NOT NULL,
      resolvedPrompt TEXT, status TEXT NOT NULL DEFAULT 'ready', sessionId TEXT,
      interactionMode TEXT, modelPreference TEXT, thinkingEffort TEXT,
       agentBackend TEXT, output TEXT, images TEXT, meta TEXT,
       autoStart INTEGER NOT NULL DEFAULT 0, sortOrder INTEGER NOT NULL DEFAULT 0,
       createdAt TEXT NOT NULL DEFAULT (datetime('now')),
       updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
       archivedAt TEXT
    );
    CREATE INDEX task_steps_task_idx ON task_steps(taskId);
    CREATE TABLE raw_messages (
      id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      stepId TEXT REFERENCES task_steps(id)
    );
    CREATE TABLE agent_messages (
      id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      stepId TEXT REFERENCES task_steps(id), rawMessageId TEXT REFERENCES raw_messages(id)
    );
    INSERT INTO projects (id) VALUES ('project-1');
    INSERT INTO tasks (
      id, projectId, type, name, prompt, status, worktreePath, startCommitHash,
      sourceBranch, branchName, hasUnread, userCompleted, sessionRules, sortOrder,
      workItemIds, workItemUrls, pullRequestId, pullRequestUrl, pendingMessage,
      todoItems, parentTaskId, createdAt, updatedAt
    ) VALUES
      ('live-workspace', 'project-1', 'pr-review', 'Live', 'prompt', 'running',
       '/worktree', 'abc', 'main', 'branch', 1, 0, '${RULES}', 4, '["1"]',
       '["url"]', '12', 'pr-url', 'pending', '[{"id":"todo"}]', NULL,
       '2026-01-01', '2026-02-01'),
      ('completed-workspace', 'project-1', 'pr-review', 'Completed', 'prompt',
       'completed', '/worktree-2', NULL, NULL, NULL, 0, 0, NULL, 0, NULL, NULL,
       NULL, NULL, NULL, NULL, NULL, '2026-01-02', '2026-02-02'),
      ('user-completed-workspace', 'project-1', 'pr-review', 'User completed',
       'prompt', 'waiting', NULL, NULL, NULL, 'branch-2', 0, 1, '{}', 0, NULL,
       NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-03', '2026-02-03'),
      ('completed-no-workspace', 'project-1', 'pr-review', 'No workspace',
       'prompt', 'completed', NULL, NULL, NULL, NULL, 0, 1, NULL, 0, NULL, NULL,
       NULL, NULL, NULL, NULL, NULL, '2026-01-05', '2026-02-05'),
      ('normal-task', 'project-1', 'agent', 'Normal', 'prompt', 'running',
       '/normal', 'def', 'main', 'normal', 0, 0, NULL, 0, NULL, NULL, NULL,
       NULL, NULL, NULL, 'live-workspace', '2026-01-06', '2026-02-06');
    INSERT INTO task_steps (
      id, taskId, name, promptTemplate, sortOrder, archivedAt, createdAt, updatedAt
    ) VALUES
      ('step-a', 'live-workspace', 'A', 'a', 0, '2026-02-10', '2026-01-01', '2026-01-01'),
      ('step-z', 'live-workspace', 'Z', 'z', 1, NULL, '2026-01-02', '2026-01-02'),
      ('step-normal', 'normal-task', 'Normal', 'n', 0, NULL, '2026-01-03', '2026-01-03');
    INSERT INTO raw_messages (id, taskId, stepId)
      VALUES ('raw-1', 'live-workspace', 'step-a');
    INSERT INTO agent_messages (id, taskId, stepId, rawMessageId)
      VALUES ('message-1', 'live-workspace', 'step-a', 'raw-1');
  `);
  const database = {
    prepare(statement: string) {
      const prepared = client.prepare(statement);
      return {
        reader: prepared.columns().length > 0,
        all: (parameters: readonly unknown[]) =>
          prepared.all(...(parameters as SQLInputValue[])),
        run: (parameters: readonly unknown[]) => {
          if (failStatement?.(statement)) {
            throw new Error('injected migration failure');
          }
          return prepared.run(...(parameters as SQLInputValue[]));
        },
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

function columns(table: string): string[] {
  return client
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => (row as { name: string }).name);
}

function hasIndex(name: string): boolean {
  return Boolean(
    client
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(name),
  );
}

function allowAllOperations(): void {
  client.setAuthorizer(null);
}

function expectMain077StepState(): void {
  expect(columns('task_steps')).toContain('archivedAt');
  expect(
    client
      .prepare("SELECT archivedAt FROM task_steps WHERE id = 'step-a'")
      .get(),
  ).toEqual({ archivedAt: '2026-02-10' });
  expect(hasIndex('idx_tasks_parent_task_id')).toBe(true);
  expect(hasIndex('task_steps_task_idx')).toBe(true);
  expect(client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
}

describe('078_pr_workspace_support', () => {
  it('migrates full schema and backfills rules and lifecycle without losing data', async () => {
    await up(db);

    expect(columns('tasks')).toEqual([
      'id', 'projectId', 'type', 'name', 'prompt', 'status', 'worktreePath',
      'startCommitHash', 'sourceBranch', 'branchName', 'cleanupWorktreePath',
      'cleanupBranchName', 'hasUnread', 'userCompleted', 'sortOrder',
      'workItemIds', 'workItemUrls', 'pullRequestId', 'pullRequestUrl',
      'pendingMessage', 'todoItems', 'parentTaskId', 'createdAt', 'updatedAt',
      'prWorkspaceState', 'prWorkspacePendingAt',
    ]);
    expect(columns('task_steps')).toContain('sessionRules');
    expect(
      client.prepare('SELECT id, sessionRules FROM task_steps ORDER BY id').all(),
    ).toEqual([
      { id: 'step-a', sessionRules: RULES },
      { id: 'step-normal', sessionRules: null },
      { id: 'step-z', sessionRules: RULES },
    ]);
    expect(
      client
        .prepare(
          'SELECT id, prWorkspaceState, prWorkspacePendingAt FROM tasks ORDER BY id',
        )
        .all(),
    ).toEqual([
      { id: 'completed-no-workspace', prWorkspaceState: 'active', prWorkspacePendingAt: null },
      { id: 'completed-workspace', prWorkspaceState: 'cleanup-pending', prWorkspacePendingAt: '2026-02-02' },
      { id: 'live-workspace', prWorkspaceState: 'active', prWorkspacePendingAt: null },
      { id: 'normal-task', prWorkspaceState: null, prWorkspacePendingAt: null },
      { id: 'user-completed-workspace', prWorkspaceState: 'cleanup-pending', prWorkspacePendingAt: '2026-02-03' },
    ]);
    expect(
      client
        .prepare(
          `SELECT type, name, prompt, hasUnread, sortOrder, workItemIds,
                  workItemUrls, pullRequestId, pullRequestUrl, pendingMessage,
                  todoItems, parentTaskId FROM tasks WHERE id = 'live-workspace'`,
        )
        .get(),
    ).toEqual({
      type: 'pr-review',
      name: 'Live',
      prompt: 'prompt',
      hasUnread: 1,
      sortOrder: 4,
      workItemIds: '["1"]',
      workItemUrls: '["url"]',
      pullRequestId: '12',
      pullRequestUrl: 'pr-url',
      pendingMessage: 'pending',
      todoItems: '[{"id":"todo"}]',
      parentTaskId: null,
    });
    expect(client.prepare('SELECT * FROM raw_messages').all()).toHaveLength(1);
    expect(client.prepare('SELECT * FROM agent_messages').all()).toHaveLength(1);
    expect(hasIndex('idx_tasks_parent_task_id')).toBe(true);
    expectMain077StepState();
    expect((await sql`PRAGMA foreign_key_check`.execute(db)).rows).toEqual([]);
    expect(client.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
  });

  it('restores latest rules deterministically and removes all added columns', async () => {
    await up(db);
    client
      .prepare('UPDATE task_steps SET sortOrder = ?, createdAt = ?, sessionRules = ? WHERE id = ?')
      .run(6, '2026-01-01', '{"winner":"sort"}', 'step-a');
    client
      .prepare('UPDATE task_steps SET sortOrder = ?, createdAt = ?, sessionRules = ? WHERE id = ?')
      .run(5, '2026-03-01', '{"winner":"wrong-sort"}', 'step-z');
    const insertStep = client.prepare(`
      INSERT INTO task_steps
        (id, taskId, name, promptTemplate, sessionRules, sortOrder, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertStep.run('step-created', 'completed-workspace', 'Created', 'c', '{"winner":"createdAt"}', 0, '2026-03-01', '2026-03-01');
    insertStep.run('step-id-a', 'user-completed-workspace', 'A', 'a', '{"winner":"wrong-id"}', 0, '2026-04-01', '2026-04-01');
    insertStep.run('step-id-z', 'user-completed-workspace', 'Z', 'z', '{"winner":"id"}', 0, '2026-04-01', '2026-04-01');

    await down(db);

    expect(columns('tasks')).toEqual([
      'id', 'projectId', 'type', 'name', 'prompt', 'status', 'worktreePath',
      'startCommitHash', 'sourceBranch', 'branchName', 'hasUnread',
      'userCompleted', 'sortOrder', 'workItemIds', 'workItemUrls',
      'pullRequestId', 'pullRequestUrl', 'pendingMessage', 'todoItems',
      'parentTaskId', 'createdAt', 'updatedAt', 'sessionRules',
    ]);
    expect(columns('task_steps')).not.toContain('sessionRules');
    expectMain077StepState();
    expect(client.prepare('SELECT sessionRules FROM tasks WHERE id = ?').get('live-workspace')).toEqual({ sessionRules: '{"winner":"sort"}' });
    expect(client.prepare('SELECT sessionRules FROM tasks WHERE id = ?').get('completed-workspace')).toEqual({ sessionRules: '{"winner":"createdAt"}' });
    expect(client.prepare('SELECT sessionRules FROM tasks WHERE id = ?').get('user-completed-workspace')).toEqual({ sessionRules: '{"winner":"id"}' });
    expect(client.prepare('SELECT * FROM raw_messages').all()).toHaveLength(1);
    expect(client.prepare('SELECT * FROM agent_messages').all()).toHaveLength(1);
    expect(hasIndex('idx_tasks_parent_task_id')).toBe(true);
    expect((await sql`PRAGMA foreign_key_check`.execute(db)).rows).toEqual([]);
    expect(client.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
  });

  it('allows pre-existing violations across rowid-changing up and down recreations', async () => {
    client.exec('PRAGMA foreign_keys = OFF');
    client.prepare("INSERT INTO tasks (id, projectId, prompt, updatedAt) VALUES ('task-gap', 'project-1', 'prompt', '2026-01-01')").run();
    client.prepare("INSERT INTO tasks (id, projectId, prompt, updatedAt) VALUES ('task-orphan', 'missing-project', 'prompt', '2026-01-01')").run();
    client.prepare("DELETE FROM tasks WHERE id = 'task-gap'").run();
    client.prepare("INSERT INTO raw_messages (id, taskId, stepId) VALUES ('raw-orphan', 'live-workspace', 'missing-step')").run();
    client.exec('PRAGMA foreign_keys = ON');
    const taskRowidBefore = client.prepare('PRAGMA foreign_key_check').all().find((row) => row.table === 'tasks')?.rowid;

    await up(db);

    const taskViolation = client.prepare('PRAGMA foreign_key_check').all().find((row) => row.table === 'tasks');
    expect(taskViolation).toMatchObject({ table: 'tasks', parent: 'projects', fkid: 0 });
    expect(taskViolation?.rowid).not.toBe(taskRowidBefore);
    client.exec('PRAGMA foreign_keys = OFF');
    client.prepare("INSERT INTO task_steps (id, taskId, name, promptTemplate, updatedAt) VALUES ('step-gap', 'live-workspace', 'Gap', 'g', '2026-01-01')").run();
    client.prepare("INSERT INTO task_steps (id, taskId, name, promptTemplate, updatedAt) VALUES ('step-orphan', 'missing-task', 'Orphan', 'o', '2026-01-01')").run();
    client.prepare("DELETE FROM task_steps WHERE id = 'step-gap'").run();
    client.exec('PRAGMA foreign_keys = ON');
    const stepRowidBefore = client.prepare('PRAGMA foreign_key_check').all().find((row) => row.table === 'task_steps')?.rowid;

    await down(db);

    const violations = client.prepare('PRAGMA foreign_key_check').all();
    const stepViolation = violations.find((row) => row.table === 'task_steps');
    expect(stepViolation).toMatchObject({ table: 'task_steps', parent: 'tasks', fkid: 0 });
    expect(stepViolation?.rowid).not.toBe(stepRowidBefore);
    expect(violations.filter((row) => row.table === 'raw_messages')).toHaveLength(1);
    expect(client.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
  });

  it('rejects a foreign key violation introduced during up', async () => {
    client.exec(`
      CREATE TRIGGER corrupt_step_task
      AFTER UPDATE OF sessionRules ON task_steps
      WHEN NEW.id = 'step-a'
      BEGIN
        UPDATE task_steps SET taskId = 'missing-task' WHERE id = NEW.id;
      END;
    `);

    await expect(up(db)).rejects.toThrow('Foreign key violation');

    expect(columns('tasks')).toContain('sessionRules');
    expect(columns('tasks')).not.toContain('cleanupWorktreePath');
    expect(columns('task_steps')).not.toContain('sessionRules');
    expectMain077StepState();
    expect(client.prepare("SELECT taskId FROM task_steps WHERE id = 'step-a'").get()).toEqual({ taskId: 'live-workspace' });
    expect(client.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
  });

  it('rolls back a late up failure and retries the full migration', async () => {
    failStatement = (statement) =>
      statement.includes('UPDATE tasks') && statement.includes('prWorkspaceState');

    await expect(up(db)).rejects.toThrow('injected migration failure');
    expect(columns('tasks')).toContain('sessionRules');
    expect(columns('tasks')).not.toContain('cleanupWorktreePath');
    expect(columns('tasks')).not.toContain('prWorkspaceState');
    expect(columns('task_steps')).not.toContain('sessionRules');
    expectMain077StepState();
    expect(client.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 5 });
    expect(client.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);

    failStatement = undefined;
    await expect(up(db)).resolves.toBeUndefined();
    expect(columns('tasks')).toContain('cleanupBranchName');
    expect(columns('tasks')).toContain('prWorkspacePendingAt');
    expect(columns('task_steps')).toContain('sessionRules');
    expectMain077StepState();
  });

  it('rolls back a late down failure and retries the full rollback', async () => {
    await up(db);
    failStatement = (statement) => statement.includes('cleanupBranchName');

    await expect(down(db)).rejects.toThrow('injected migration failure');
    expect(columns('tasks')).not.toContain('sessionRules');
    expect(columns('tasks')).toContain('cleanupWorktreePath');
    expect(columns('tasks')).toContain('prWorkspaceState');
    expect(columns('task_steps')).toContain('sessionRules');
    expectMain077StepState();
    expect(client.prepare('SELECT * FROM raw_messages').all()).toHaveLength(1);
    expect(client.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);

    failStatement = undefined;
    await expect(down(db)).resolves.toBeUndefined();
    expect(columns('tasks')).toContain('sessionRules');
    expect(columns('tasks')).not.toContain('cleanupWorktreePath');
    expect(columns('tasks')).not.toContain('prWorkspaceState');
    expect(columns('task_steps')).not.toContain('sessionRules');
    expectMain077StepState();
  });

  it('rolls back table recreation failures and restores FK enforcement', async () => {
    client.setAuthorizer((actionCode, arg1) =>
      actionCode === constants.SQLITE_DROP_TABLE && arg1 === 'tasks'
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK,
    );
    try {
      await expect(up(db)).rejects.toThrow();
    } finally {
      allowAllOperations();
    }
    expect(columns('tasks')).toContain('sessionRules');
    expect(columns('tasks')).not.toContain('cleanupWorktreePath');
    expect(columns('task_steps')).not.toContain('sessionRules');
    expectMain077StepState();
    expect(client.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);

    await up(db);
    client.setAuthorizer((actionCode, arg1) =>
      actionCode === constants.SQLITE_DROP_TABLE && arg1 === 'task_steps'
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK,
    );
    try {
      await expect(down(db)).rejects.toThrow();
    } finally {
      allowAllOperations();
    }
    expect(columns('tasks')).not.toContain('sessionRules');
    expect(columns('tasks')).toContain('prWorkspaceState');
    expect(columns('task_steps')).toContain('sessionRules');
    expectMain077StepState();
    expect(client.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
  });

  it('preserves task deletion cascades after up and down', async () => {
    await up(db);
    client.prepare("DELETE FROM tasks WHERE id = 'live-workspace'").run();
    expect(client.prepare('SELECT * FROM raw_messages').all()).toHaveLength(0);
    expect(client.prepare('SELECT * FROM agent_messages').all()).toHaveLength(0);
    expect(client.prepare("SELECT * FROM task_steps WHERE taskId = 'live-workspace'").all()).toHaveLength(0);

    await down(db);
    client.prepare("DELETE FROM tasks WHERE id = 'normal-task'").run();
    expect(client.prepare("SELECT * FROM task_steps WHERE taskId = 'normal-task'").all()).toHaveLength(0);
    expect(client.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
  });
});
