import { Kysely } from 'kysely';

/**
 * Two indexes for the hottest message reads.
 *
 * 1. `agent_messages (stepId, messageIndex)` — the per-step message load
 *    (`AgentMessageRepository.findByStepId`) previously seeked
 *    `agent_messages_step_idx` and then built a TEMP B-TREE to satisfy
 *    `ORDER BY messageIndex`. Extending the key makes the sort free.
 *
 * 2. `raw_messages (taskId, rawFormat)` — opencode compaction filters on
 *    `taskId AND rawFormat`, but only `taskId` was indexed, so every run
 *    read the whole task slice of the largest table in the database just to
 *    discard non-opencode rows.
 *
 * Each new index is a superset of an existing single-column one, so the old
 * one is dropped: a strict prefix index can never be chosen over its extension
 * and only costs B-tree maintenance on the message-insert hot path.
 * `agent_messages_step_type_message_index_idx` (stepId, type, messageIndex) is
 * NOT redundant — it serves `findLatestResultByStepId` — and is left alone.
 *
 * Measured on a 3.3 GB production database (agent_messages 67k rows / 433 MB,
 * raw_messages 190k rows / 2 GB): ~0.5s and ~0.6s respectively, so running
 * this on the blocking startup migrator is acceptable.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex('idx_agent_messages_stepId_messageIndex')
    .ifNotExists()
    .on('agent_messages')
    .columns(['stepId', 'messageIndex'])
    .execute();
  await db.schema.dropIndex('agent_messages_step_idx').ifExists().execute();

  await db.schema
    .createIndex('idx_raw_messages_taskId_rawFormat')
    .ifNotExists()
    .on('raw_messages')
    .columns(['taskId', 'rawFormat'])
    .execute();
  await db.schema.dropIndex('idx_raw_messages_task_id').ifExists().execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Restore the prefix indexes before removing their replacements so the
  // rolled-back schema is never left without a stepId/taskId lookup path.
  await db.schema
    .createIndex('agent_messages_step_idx')
    .ifNotExists()
    .on('agent_messages')
    .columns(['stepId'])
    .execute();
  await db.schema
    .createIndex('idx_raw_messages_task_id')
    .ifNotExists()
    .on('raw_messages')
    .columns(['taskId'])
    .execute();

  await db.schema
    .dropIndex('idx_raw_messages_taskId_rawFormat')
    .ifExists()
    .execute();
  await db.schema
    .dropIndex('idx_agent_messages_stepId_messageIndex')
    .ifExists()
    .execute();
}
