import { Kysely, sql } from 'kysely';

type ForeignKeyViolation = {
  table: string;
  rowid: number;
  parent: string;
  fkid: number;
};

function foreignKeyViolationSignature(row: ForeignKeyViolation): string {
  return JSON.stringify([row.table, row.parent, row.fkid]);
}

async function loadForeignKeyViolationCounts(
  db: Kysely<unknown>,
): Promise<Map<string, number>> {
  const result = await sql<ForeignKeyViolation>`PRAGMA foreign_key_check`.execute(
    db,
  );
  const counts = new Map<string, number>();
  for (const row of result.rows) {
    const signature = foreignKeyViolationSignature(row);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return counts;
}

async function assertNoNewForeignKeyViolations(
  db: Kysely<unknown>,
  baseline: Map<string, number>,
): Promise<void> {
  const result = await sql<ForeignKeyViolation>`PRAGMA foreign_key_check`.execute(
    db,
  );
  const remainingBaseline = new Map(baseline);
  const introduced = result.rows.filter((row) => {
    const signature = foreignKeyViolationSignature(row);
    const remaining = remainingBaseline.get(signature) ?? 0;
    if (remaining === 0) return true;
    remainingBaseline.set(signature, remaining - 1);
    return false;
  });
  if (introduced.length > 0) {
    throw new Error(`Foreign key violation: ${JSON.stringify(introduced)}`);
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const baselineViolations = await loadForeignKeyViolationCounts(db);
  await sql`PRAGMA foreign_keys = OFF`.execute(db);

  try {
    await db.transaction().execute(async (trx) => {
      await trx.schema
        .alterTable('tasks')
        .addColumn('cleanupWorktreePath', 'text')
        .execute();
      await trx.schema
        .alterTable('tasks')
        .addColumn('cleanupBranchName', 'text')
        .execute();
      await trx.schema
        .alterTable('task_steps')
        .addColumn('sessionRules', 'text')
        .execute();
      await sql`
        UPDATE task_steps
        SET sessionRules = (
          SELECT tasks.sessionRules
          FROM tasks
          WHERE tasks.id = task_steps.taskId
        )
      `.execute(trx);

      await sql`DROP TABLE IF EXISTS tasks_new`.execute(trx);
      await sql`
        CREATE TABLE tasks_new (
          id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          type TEXT DEFAULT 'agent',
          name TEXT,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'waiting',
          worktreePath TEXT,
          startCommitHash TEXT,
          sourceBranch TEXT,
          branchName TEXT,
          cleanupWorktreePath TEXT,
          cleanupBranchName TEXT,
          hasUnread INTEGER NOT NULL DEFAULT 0,
          userCompleted INTEGER NOT NULL DEFAULT 0,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          workItemIds TEXT,
          workItemUrls TEXT,
          pullRequestId TEXT,
          pullRequestUrl TEXT,
          pendingMessage TEXT,
          todoItems TEXT,
          parentTaskId TEXT,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          updatedAt TEXT NOT NULL
        )
      `.execute(trx);
      await sql`
        INSERT INTO tasks_new (
          id, projectId, type, name, prompt, status, worktreePath,
          startCommitHash, sourceBranch, branchName, cleanupWorktreePath,
          cleanupBranchName, hasUnread, userCompleted, sortOrder, workItemIds,
          workItemUrls, pullRequestId, pullRequestUrl, pendingMessage, todoItems,
          parentTaskId, createdAt, updatedAt
        )
        SELECT
          id, projectId, type, name, prompt, status, worktreePath,
          startCommitHash, sourceBranch, branchName, cleanupWorktreePath,
          cleanupBranchName, hasUnread, userCompleted, sortOrder, workItemIds,
          workItemUrls, pullRequestId, pullRequestUrl, pendingMessage, todoItems,
          parentTaskId, createdAt, updatedAt
        FROM tasks
      `.execute(trx);
      await trx.schema.dropTable('tasks').execute();
      await sql`ALTER TABLE tasks_new RENAME TO tasks`.execute(trx);
      await trx.schema
        .createIndex('idx_tasks_parent_task_id')
        .on('tasks')
        .column('parentTaskId')
        .execute();

      await trx.schema
        .alterTable('tasks')
        .addColumn('prWorkspaceState', 'text')
        .execute();
      await trx.schema
        .alterTable('tasks')
        .addColumn('prWorkspacePendingAt', 'text')
        .execute();
      await sql`
        UPDATE tasks
        SET prWorkspaceState = CASE
          WHEN (status = 'completed' OR userCompleted = 1)
            AND (
              worktreePath IS NOT NULL
              OR startCommitHash IS NOT NULL
              OR sourceBranch IS NOT NULL
              OR branchName IS NOT NULL
              OR cleanupWorktreePath IS NOT NULL
              OR cleanupBranchName IS NOT NULL
            )
          THEN 'cleanup-pending'
          ELSE 'active'
        END,
        prWorkspacePendingAt = CASE
          WHEN (status = 'completed' OR userCompleted = 1)
            AND (
              worktreePath IS NOT NULL
              OR startCommitHash IS NOT NULL
              OR sourceBranch IS NOT NULL
              OR branchName IS NOT NULL
              OR cleanupWorktreePath IS NOT NULL
              OR cleanupBranchName IS NOT NULL
            )
          THEN COALESCE(updatedAt, createdAt)
          ELSE NULL
        END
        WHERE type = 'pr-review'
      `.execute(trx);

      await assertNoNewForeignKeyViolations(trx, baselineViolations);
    });
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const baselineViolations = await loadForeignKeyViolationCounts(db);
  await sql`PRAGMA foreign_keys = OFF`.execute(db);

  try {
    await db.transaction().execute(async (trx) => {
      await trx.schema
        .alterTable('tasks')
        .dropColumn('prWorkspacePendingAt')
        .execute();
      await trx.schema
        .alterTable('tasks')
        .dropColumn('prWorkspaceState')
        .execute();
      await trx.schema
        .alterTable('tasks')
        .addColumn('sessionRules', 'text')
        .execute();
      await sql`
        UPDATE tasks
        SET sessionRules = (
          SELECT task_steps.sessionRules
          FROM task_steps
          WHERE task_steps.taskId = tasks.id
          ORDER BY task_steps.sortOrder DESC,
                   task_steps.createdAt DESC,
                   task_steps.id DESC
          LIMIT 1
        )
      `.execute(trx);

      await sql`DROP TABLE IF EXISTS task_steps_new`.execute(trx);
      await sql`
        CREATE TABLE task_steps_new (
          id TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'agent',
          dependsOn TEXT NOT NULL DEFAULT '[]',
          promptTemplate TEXT NOT NULL,
          resolvedPrompt TEXT,
          status TEXT NOT NULL DEFAULT 'ready',
          sessionId TEXT,
          interactionMode TEXT,
          modelPreference TEXT,
          thinkingEffort TEXT,
          agentBackend TEXT,
          output TEXT,
          images TEXT,
          meta TEXT,
          autoStart INTEGER NOT NULL DEFAULT 0,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
          archivedAt TEXT
        )
      `.execute(trx);
      await sql`
        INSERT INTO task_steps_new (
          id, taskId, name, type, dependsOn, promptTemplate, resolvedPrompt,
          status, sessionId, interactionMode, modelPreference, thinkingEffort,
          agentBackend, output, images, meta, autoStart, sortOrder, createdAt,
          updatedAt, archivedAt
        )
        SELECT
          id, taskId, name, type, dependsOn, promptTemplate, resolvedPrompt,
          status, sessionId, interactionMode, modelPreference, thinkingEffort,
          agentBackend, output, images, meta, autoStart, sortOrder, createdAt,
          updatedAt, archivedAt
        FROM task_steps
      `.execute(trx);
      await trx.schema.dropTable('task_steps').execute();
      await sql`ALTER TABLE task_steps_new RENAME TO task_steps`.execute(trx);
      await trx.schema
        .createIndex('task_steps_task_idx')
        .on('task_steps')
        .column('taskId')
        .execute();

      await trx.schema
        .alterTable('tasks')
        .dropColumn('cleanupWorktreePath')
        .execute();
      await trx.schema
        .alterTable('tasks')
        .dropColumn('cleanupBranchName')
        .execute();

      await assertNoNewForeignKeyViolations(trx, baselineViolations);
    });
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}
