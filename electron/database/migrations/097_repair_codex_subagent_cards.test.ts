import { describe, expect, it } from 'vitest';
import { Kysely, SqliteDialect } from 'kysely';
import { DatabaseSync } from 'node:sqlite';
import { up } from './097_repair_codex_subagent_cards';

type Row = {
  id: string;
  toolId: string | null;
  parentToolId: string | null;
  data: string;
};

function card({
  id,
  stepId,
  messageIndex,
  description,
  agentType = 'Codex',
}: {
  id: string;
  stepId: string;
  messageIndex: number;
  description: string;
  agentType?: string;
}) {
  return {
    id,
    stepId,
    messageIndex,
    toolId: id,
    parentToolId: null,
    data: JSON.stringify({
      id,
      type: 'tool-use',
      toolId: id,
      name: 'sub-agent',
      input: { agentType, description, prompt: description },
    }),
  };
}

function child({
  id,
  stepId,
  messageIndex,
  parentToolId,
}: {
  id: string;
  stepId: string;
  messageIndex: number;
  parentToolId: string;
}) {
  return {
    id,
    stepId,
    messageIndex,
    toolId: id,
    parentToolId,
    data: JSON.stringify({
      id,
      type: 'assistant-message',
      value: 'hello',
      parentToolId,
    }),
  };
}

/**
 * Kysely's SqliteDialect speaks the better-sqlite3 API (array-bound params and
 * a `reader` flag), which is unavailable in tests — the native module is built
 * for Electron. This adapts `node:sqlite` to the same shape.
 */
function betterSqliteLike(client: DatabaseSync) {
  return {
    prepare(query: string) {
      const statement = client.prepare(query);
      return {
        reader: /^\s*(select|pragma)|returning/i.test(query),
        all: (parameters: unknown[]) =>
          statement.all(...(parameters as never[])),
        run: (parameters: unknown[]) => {
          const result = statement.run(...(parameters as never[]));
          return {
            changes: Number(result.changes),
            lastInsertRowid: Number(result.lastInsertRowid),
          };
        },
        iterate: (parameters: unknown[]) =>
          statement.all(...(parameters as never[]))[Symbol.iterator](),
      };
    },
    close: () => client.close(),
  };
}

function setup(rows: ReturnType<typeof card | typeof child>[]) {
  const client = new DatabaseSync(':memory:');
  client.exec(`
    CREATE TABLE task_steps (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE agent_messages (
      id TEXT PRIMARY KEY, stepId TEXT, messageIndex INTEGER,
      toolId TEXT, parentToolId TEXT, data TEXT
    );
    INSERT INTO task_steps VALUES ('step-done','completed');
    INSERT INTO task_steps VALUES ('step-live','running');
  `);
  const insert = client.prepare(
    'INSERT INTO agent_messages VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.stepId,
      row.messageIndex,
      row.toolId,
      row.parentToolId,
      row.data,
    );
  }
  const db = new Kysely<unknown>({
    dialect: new SqliteDialect({
      database: betterSqliteLike(client) as unknown as ConstructorParameters<
        typeof SqliteDialect
      >[0]['database'],
    }),
  });
  return { client, db };
}

function allRows(client: DatabaseSync): Row[] {
  return client
    .prepare('SELECT id, toolId, parentToolId, data FROM agent_messages')
    .all() as unknown as Row[];
}

describe('097 repair codex sub-agent cards', () => {
  it('unburies entries hidden under phantom "root" cards', async () => {
    const { client, db } = setup([
      card({
        id: 'root-card',
        stepId: 'step-done',
        messageIndex: 1,
        description: 'root',
      }),
      child({
        id: 'main-entry',
        stepId: 'step-done',
        messageIndex: 2,
        parentToolId: 'root-card',
      }),
    ]);

    await up(db);

    const rows = allRows(client);
    expect(rows.map((row) => row.id)).toEqual(['main-entry']);
    expect(rows[0].parentToolId).toBeNull();
    expect(JSON.parse(rows[0].data)).not.toHaveProperty('parentToolId');
  });

  it('collapses duplicate cards for one agent onto the earliest card', async () => {
    const { client, db } = setup([
      card({
        id: 'review-1',
        stepId: 'step-done',
        messageIndex: 1,
        description: 'logic_review',
      }),
      card({
        id: 'review-2',
        stepId: 'step-done',
        messageIndex: 3,
        description: 'logic_review',
      }),
      child({
        id: 'finding',
        stepId: 'step-done',
        messageIndex: 4,
        parentToolId: 'review-2',
      }),
    ]);

    await up(db);

    const rows = allRows(client);
    expect(rows.map((row) => row.id).sort()).toEqual(['finding', 'review-1']);
    const finding = rows.find((row) => row.id === 'finding')!;
    expect(finding.parentToolId).toBe('review-1');
    expect(JSON.parse(finding.data).parentToolId).toBe('review-1');
  });

  it('resolves cards on finished steps but leaves running ones live', async () => {
    const { client, db } = setup([
      card({
        id: 'done-card',
        stepId: 'step-done',
        messageIndex: 1,
        description: 'logic_review',
      }),
      card({
        id: 'live-card',
        stepId: 'step-live',
        messageIndex: 1,
        description: 'logic_review',
      }),
    ]);

    await up(db);

    const rows = allRows(client);
    const done = JSON.parse(rows.find((row) => row.id === 'done-card')!.data);
    const live = JSON.parse(rows.find((row) => row.id === 'live-card')!.data);
    expect(done.result).toEqual({ output: '' });
    expect(live.result).toBeUndefined();
  });

  it('leaves non-Codex sub-agent cards untouched', async () => {
    const { client, db } = setup([
      card({
        id: 'claude-card',
        stepId: 'step-done',
        messageIndex: 1,
        description: 'root',
        agentType: 'Explore',
      }),
      child({
        id: 'claude-child',
        stepId: 'step-done',
        messageIndex: 2,
        parentToolId: 'claude-card',
      }),
    ]);

    await up(db);

    const rows = allRows(client);
    expect(rows.map((row) => row.id).sort()).toEqual([
      'claude-card',
      'claude-child',
    ]);
    expect(rows.find((row) => row.id === 'claude-child')!.parentToolId).toBe(
      'claude-card',
    );
    expect(
      JSON.parse(rows.find((row) => row.id === 'claude-card')!.data).result,
    ).toBeUndefined();
  });
});
