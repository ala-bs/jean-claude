import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  WorkItemSummary,
  WorkItemSummaryRequest,
} from '@shared/work-item-summary-types';

import { api } from '@/lib/api';
import { invalidateFeedResource } from '@/cache/feed-cache';

export const workItemSummaryKeys = {
  detail: (providerId: string, workItemId: number) =>
    ['work-item-summary', providerId, workItemId] as const,
  batch: (providerId: string, workItemIds: number[]) =>
    [
      'work-item-summaries',
      providerId,
      [...new Set(workItemIds)].sort((left, right) => left - right),
    ] as const,
};

export function useWorkItemSummary(request: WorkItemSummaryRequest | null) {
  return useQuery({
    queryKey: workItemSummaryKeys.detail(
      request?.providerId ?? '',
      request?.workItemId ?? 0,
    ),
    queryFn: () => api.azureDevOps.getWorkItemSummary(request!),
    enabled: request !== null,
    staleTime: 60_000,
  });
}

export function useCachedWorkItemSummaries({
  providerId,
  workItemIds,
}: {
  providerId: string | null;
  workItemIds: number[];
}) {
  const queryKey = workItemSummaryKeys.batch(providerId ?? '', workItemIds);
  return useQuery({
    queryKey,
    queryFn: () =>
      api.azureDevOps.getCachedWorkItemSummaries({
        providerId: providerId!,
        workItemIds: queryKey[2],
      }),
    enabled: !!providerId && workItemIds.length > 0,
    staleTime: 60_000,
  });
}

export function useGenerateWorkItemSummary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: WorkItemSummaryRequest) =>
      api.azureDevOps.generateWorkItemSummary(request),
    retry: false,
    onSuccess: (summary: WorkItemSummary) => {
      queryClient.setQueryData(
        workItemSummaryKeys.detail(summary.providerId, summary.workItemId),
        summary,
      );
      void queryClient.invalidateQueries({
        queryKey: ['work-item-summaries', summary.providerId],
      });
      invalidateFeedResource(queryClient, 'workItems');
    },
  });
}
