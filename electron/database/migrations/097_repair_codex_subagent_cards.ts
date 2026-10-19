import { Kysely, sql } from 'kysely';

/**
 * Repairs Codex sub-agent timeline entries written by the broken
 * `subAgentActivity` mapping.
 *
 * Codex emits one activity item id per event and also reports the *main*
 * thread as an agent (`agentPath: "/root"`, `agentThreadId` = the main thread).
 * The old normalizer therefore:
 *   1. created a phantom "root" sub-agent card and re-parented every later
 *      main-thread entry into it, hiding the whole conversation, and
 *   2. created a fresh card per `interacted` event instead of one per agent,
 *      none of which ever completed.
 *
 * This migration unburies the hidden entries, drops the phantom cards,
 * collapses the duplicates onto the first card per agent, and resolves cards
 * whose step is no longer running.
 */

const CODEX_SUBAGENT_WHERE = `
  json_extract(data, '$.type') = 'tool-use'
  and json_extract(data, '$.name') = 'sub-agent'
  and json_extract(data, '$.input.agentType') = 'Codex'
`;

type CardRow = {
  toolId: string;
  stepId: string | null;
  messageIndex: number;
  description: string | null;
};

export async function up(db: Kysely<unknown>): Promise<void> {
  const cards = await sql<CardRow>`
    select
      toolId,
      stepId,
      messageIndex,
      json_extract(data, '$.input.description') as description
    from agent_messages
    where ${sql.raw(CODEX_SUBAGENT_WHERE)}
    order by messageIndex
  `.execute(db);

  // Phantom cards: the main agent reporting on itself.
  const phantomToolIds = cards.rows
    .filter((card) => card.description === 'root')
    .map((card) => card.toolId);

  // One keeper per (step, agent name); every later card is a duplicate of it.
  const keeperByAgent = new Map<string, string>();
  const duplicateToKeeper = new Map<string, string>();
  for (const card of cards.rows) {
    if (card.description === 'root') continue;
    const key = `${card.stepId ?? ''}\u0000${card.description ?? ''}`;
    const keeper = keeperByAgent.get(key);
    if (keeper === undefined) {
      keeperByAgent.set(key, card.toolId);
      continue;
    }
    duplicateToKeeper.set(card.toolId, keeper);
  }

  await db.transaction().execute(async (trx) => {
    for (const toolId of phantomToolIds) {
      await sql`
        update agent_messages
        set parentToolId = null,
            data = json_remove(data, '$.parentToolId')
        where parentToolId = ${toolId}
      `.execute(trx);
    }

    for (const [duplicateToolId, keeperToolId] of duplicateToKeeper) {
      await sql`
        update agent_messages
        set parentToolId = ${keeperToolId},
            data = json_set(data, '$.parentToolId', ${keeperToolId})
        where parentToolId = ${duplicateToolId}
      `.execute(trx);
    }

    const removableToolIds = [...phantomToolIds, ...duplicateToKeeper.keys()];
    for (const toolId of removableToolIds) {
      await sql`
        delete from agent_messages
        where toolId = ${toolId}
          and ${sql.raw(CODEX_SUBAGENT_WHERE)}
      `.execute(trx);
    }

    // Resolve cards that can no longer complete on their own, so they stop
    // rendering as live sub-agents on finished steps.
    await sql`
      update agent_messages
      set data = json_set(data, '$.result', json('{"output":""}'))
      where ${sql.raw(CODEX_SUBAGENT_WHERE)}
        and json_extract(data, '$.result') is null
        and stepId in (select id from task_steps where status <> 'running')
    `.execute(trx);
  });
}

export async function down(): Promise<void> {
  // Irreversible: the phantom cards and duplicate entries carried no
  // information that is not already present on the surviving cards.
}
