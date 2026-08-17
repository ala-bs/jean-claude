import { db } from '../index';
import { ProviderRepository } from './providers';
import type { WorkItemSummaryRow } from '../schema';

export type PersistedWorkItemSummary = WorkItemSummaryRow;

export type UpsertWorkItemSummary = Omit<PersistedWorkItemSummary, 'id'>;

export const WorkItemSummaryRepository = {
  findByWorkItem: async ({
    providerId,
    workItemId,
  }: {
    providerId: string;
    workItemId: number;
  }): Promise<PersistedWorkItemSummary | null> => {
    const row = await db
      .selectFrom('work_item_summaries')
      .selectAll()
      .where('providerId', '=', providerId)
      .where('workItemId', '=', workItemId)
      .executeTakeFirst();

    return row ?? null;
  },

  findByWorkItems: async ({
    providerId,
    workItemIds,
  }: {
    providerId: string;
    workItemIds: number[];
  }): Promise<PersistedWorkItemSummary[]> => {
    const uniqueWorkItemIds = [...new Set(workItemIds)];
    if (uniqueWorkItemIds.length === 0) return [];

    const rows = await db
      .selectFrom('work_item_summaries')
      .selectAll()
      .where('providerId', '=', providerId)
      .where('workItemId', 'in', uniqueWorkItemIds)
      .execute();

    return rows;
  },

  upsert: async (
    data: UpsertWorkItemSummary,
  ): Promise<PersistedWorkItemSummary> => {
    const provider = await ProviderRepository.findById(data.providerId);
    if (!provider) {
      throw new Error(
        `Cannot save work item summary for missing provider ${data.providerId}`,
      );
    }

    const values = data;
    const row = await db
      .insertInto('work_item_summaries')
      .values(values)
      .onConflict((conflict) =>
        conflict.columns(['providerId', 'workItemId']).doUpdateSet({
          content: values.content,
          sourceHash: values.sourceHash,
          sourceChangedDate: values.sourceChangedDate,
          sourceLatestCommentId: values.sourceLatestCommentId,
          sourceCommentCount: values.sourceCommentCount,
          generatedAt: values.generatedAt,
          updatedAt: values.updatedAt,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return row;
  },
};
