import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  api,
  type AzureDevOpsBoardColumn,
  type AzureDevOpsIteration,
  type AzureDevOpsPullRequestStatus,
  type AzureDevOpsUser,
  type AzureDevOpsWorkItem,
  type AzureDevOpsWorkItemState,
  type WorkItemComment,
  type WorkItemHistoryEntry,
} from '@/lib/api';
import { markDocumentStale } from '@/cache/cache-actions';
import { useToastStore } from '@/stores/toasts';

let boardColumnMutationSequence = 0;
const boardColumnUpdateQueues = new Map<string, Promise<unknown>>();

export function useWorkItems(params: {
  providerId: string;
  projectId: string;
  projectName: string;
  enabled?: boolean;
  refetchOnMount?: 'always' | boolean;
  filters: {
    states?: string[];
    workItemTypes?: string[];
    excludeWorkItemTypes?: string[];
    searchText?: string;
    iterationPath?: string;
    iterationPaths?: string[];
    assignedTo?: string;
  };
}) {
  return useQuery<AzureDevOpsWorkItem[]>({
    queryKey: [
      'work-items',
      params.providerId,
      params.projectId,
      params.filters,
    ],
    queryFn: () => api.azureDevOps.queryWorkItems(params),
    enabled:
      params.enabled !== false &&
      !!params.providerId &&
      !!params.projectId &&
      !!params.projectName,
    staleTime: 60_000,
    refetchOnMount: params.refetchOnMount,
  });
}

export function useWorkItemOwners(params: {
  providerId: string | null;
  projectName: string | null;
}) {
  return useQuery<Array<{ displayName: string; value: string }>>({
    queryKey: ['work-item-owners', params.providerId, params.projectName],
    queryFn: () =>
      api.azureDevOps.queryWorkItemOwners({
        providerId: params.providerId!,
        projectName: params.projectName!,
      }),
    enabled: !!params.providerId && !!params.projectName,
    staleTime: 5 * 60_000,
  });
}

export function useIterations(params: {
  providerId: string;
  projectName: string;
  refetchOnMount?: 'always' | boolean;
}) {
  return useQuery<AzureDevOpsIteration[]>({
    queryKey: ['iterations', params.providerId, params.projectName],
    queryFn: () => api.azureDevOps.getIterations(params),
    enabled: !!params.providerId && !!params.projectName,
    refetchOnMount: params.refetchOnMount,
    staleTime: 5 * 60_000, // 5 minutes - iterations change infrequently
  });
}

export function useBoardColumns(params: {
  providerId: string;
  projectId: string;
  projectName: string;
  enabled?: boolean;
  refetchOnMount?: 'always' | boolean;
}) {
  return useQuery<AzureDevOpsBoardColumn[]>({
    queryKey: [
      'work-item-board-columns',
      params.providerId,
      params.projectId,
      params.projectName,
    ],
    queryFn: () => api.azureDevOps.getBoardColumns(params),
    enabled:
      params.enabled !== false &&
      !!params.providerId &&
      !!params.projectId &&
      !!params.projectName,
    staleTime: 5 * 60_000,
    refetchOnMount: params.refetchOnMount,
  });
}

export function useWorkItemById(params: {
  providerId: string | null;
  workItemId: number | null;
}) {
  return useQuery({
    queryKey: ['work-item', params.providerId, params.workItemId],
    queryFn: () =>
      api.azureDevOps.getWorkItemById({
        providerId: params.providerId!,
        workItemId: params.workItemId!,
      }),
    enabled: !!params.providerId && !!params.workItemId,
    staleTime: 5 * 60_000,
  });
}

export function useWorkItemsByIds(params: {
  providerId: string | null;
  projectName: string | null;
  workItemIds: number[];
}) {
  return useQuery<AzureDevOpsWorkItem[]>({
    queryKey: [
      'work-items-by-ids',
      params.providerId,
      params.projectName,
      [...new Set(params.workItemIds)].sort((a, b) => a - b),
    ],
    queryFn: () =>
      api.azureDevOps.getWorkItemsByIds({
        providerId: params.providerId!,
        projectName: params.projectName!,
        workItemIds: [...new Set(params.workItemIds)],
      }),
    enabled:
      !!params.providerId && !!params.projectName && params.workItemIds.length > 0,
    staleTime: 5 * 60_000,
  });
}

export function useLinkedPullRequestStatuses(params: {
  providerId: string | null;
  linkedPrs: Array<{ prId: number; projectId: string; repoId: string }>;
}) {
  return useQuery<AzureDevOpsPullRequestStatus[]>({
    queryKey: ['linked-pull-request-statuses', params.providerId, params.linkedPrs],
    queryFn: () =>
      api.azureDevOps.getPullRequestStatuses({
        providerId: params.providerId!,
        linkedPrs: params.linkedPrs,
      }),
    enabled: !!params.providerId && params.linkedPrs.length > 0,
    staleTime: 60_000,
  });
}

export function useWorkItemStates(params: {
  providerId: string | null;
  projectName: string | null;
  workItemType: string | null;
}) {
  return useQuery<AzureDevOpsWorkItemState[]>({
    queryKey: [
      'work-item-states',
      params.providerId,
      params.projectName,
      params.workItemType,
    ],
    queryFn: () =>
      api.azureDevOps.getWorkItemStates({
        providerId: params.providerId!,
        projectName: params.projectName!,
        workItemType: params.workItemType!,
      }),
    enabled:
      !!params.providerId && !!params.projectName && !!params.workItemType,
    staleTime: 5 * 60_000,
  });
}

export function useUpdateWorkItemField() {
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  return useMutation({
    mutationFn: api.azureDevOps.updateWorkItemField,
    onSuccess: (_result, variables) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['work-items'] }),
        queryClient.invalidateQueries({
          queryKey: ['work-item', variables.providerId, variables.workItemId],
        }),
        queryClient.invalidateQueries({
          queryKey: ['work-items-by-ids', variables.providerId],
        }),
        queryClient.invalidateQueries({
          queryKey: ['work-item-history', variables.providerId],
        }),
      ]),
    onError: (error) => addToast({ type: 'error', message: error.message }),
  });
}

export function useUpdateWorkItemBoardColumn() {
  const queryClient = useQueryClient();
  const addToast = useToastStore((state) => state.addToast);
  return useMutation({
    mutationFn: ({ state: _state, isDone: _isDone, ...params }: {
      providerId: string;
      projectId: string;
      projectName: string;
      workItemId: number;
      column: string;
      teamId: string;
      boardId: string;
      state: string;
      isDone: boolean;
    }) => enqueueWorkItemBoardColumnUpdate({
      key: `${params.providerId}:${params.workItemId}`,
      update: () => api.azureDevOps.updateWorkItemBoardColumn(params),
    }),
    onMutate: async (variables) => {
      const mutationId = ++boardColumnMutationSequence;
      const detailKey = [
        'work-item',
        variables.providerId,
        variables.workItemId,
      ];
      const workItemsKey = ['work-items', variables.providerId];
      const workItemsByIdsKey = ['work-items-by-ids', variables.providerId];
      const pullRequestWorkItemsFilter = {
        queryKey: ['pull-request-work-items'],
        predicate: (query: { queryKey: readonly unknown[] }) =>
          query.queryKey[2] === variables.providerId,
      };
      await Promise.all([
        queryClient.cancelQueries({ queryKey: detailKey }),
        queryClient.cancelQueries({ queryKey: workItemsKey }),
        queryClient.cancelQueries({ queryKey: workItemsByIdsKey }),
        queryClient.cancelQueries(pullRequestWorkItemsFilter),
      ]);
      const previousDetail =
        queryClient.getQueryData<AzureDevOpsWorkItem | null>(detailKey);
      const previousWorkItems =
        queryClient.getQueriesData<AzureDevOpsWorkItem[]>({
          queryKey: workItemsKey,
        });
      const previousWorkItemsByIds =
        queryClient.getQueriesData<AzureDevOpsWorkItem[]>({
          queryKey: workItemsByIdsKey,
        });
      const previousPullRequestWorkItems =
        queryClient.getQueriesData<AzureDevOpsWorkItem[]>(
          pullRequestWorkItemsFilter,
        );
      const updateItem = (item: AzureDevOpsWorkItem) =>
        applyWorkItemBoardColumnUpdate(item, { ...variables, mutationId });

      if (previousDetail) {
        queryClient.setQueryData(detailKey, updateItem(previousDetail));
      }
      queryClient.setQueriesData<AzureDevOpsWorkItem[]>(
        { queryKey: workItemsKey },
        (items) => items?.map(updateItem),
      );
      queryClient.setQueriesData<AzureDevOpsWorkItem[]>(
        { queryKey: workItemsByIdsKey },
        (items) => items?.map(updateItem),
      );
      queryClient.setQueriesData<AzureDevOpsWorkItem[]>(
        pullRequestWorkItemsFilter,
        (items) => items?.map(updateItem),
      );
      return {
        previousDetail,
        previousWorkItems,
        previousWorkItemsByIds,
        previousPullRequestWorkItems,
        mutationId,
      };
    },
    onError: (error, variables, context) => {
      if (context?.previousDetail) {
        queryClient.setQueryData<AzureDevOpsWorkItem | null>(
          ['work-item', variables.providerId, variables.workItemId],
          (item) =>
            item
              ? rollbackWorkItemBoardColumnUpdate(
                  item,
                  context.previousDetail!,
                  { ...variables, mutationId: context.mutationId },
                )
              : item,
        );
      }
      const rollbackQueries = (
        snapshots: Array<[readonly unknown[], AzureDevOpsWorkItem[] | undefined]>,
      ) => snapshots.forEach(([queryKey, previousItems]) => {
        const previousItem = previousItems?.find(
          (item) => item.id === variables.workItemId,
        );
        if (!previousItem) return;
        queryClient.setQueryData<AzureDevOpsWorkItem[]>(queryKey, (items) =>
          items?.map((item) =>
            rollbackWorkItemBoardColumnUpdate(item, previousItem, {
              ...variables,
              mutationId: context!.mutationId,
            }),
          ),
        );
      });
      rollbackQueries(context?.previousWorkItems ?? []);
      rollbackQueries(context?.previousWorkItemsByIds ?? []);
      rollbackQueries(context?.previousPullRequestWorkItems ?? []);
      addToast({ type: 'error', message: error.message });
    },
    onSettled: (_result, _error, variables, context) => {
      const cachedItems = [
        queryClient.getQueryData<AzureDevOpsWorkItem | null>([
          'work-item',
          variables.providerId,
          variables.workItemId,
        ]),
        ...queryClient
          .getQueriesData<AzureDevOpsWorkItem[]>({
            queryKey: ['work-items', variables.providerId],
          })
          .flatMap(([, items]) => items ?? []),
        ...queryClient
          .getQueriesData<AzureDevOpsWorkItem[]>({
            queryKey: ['work-items-by-ids', variables.providerId],
          })
          .flatMap(([, items]) => items ?? []),
      ].filter((item): item is AzureDevOpsWorkItem => !!item);
      const hasNewerMutation = context && hasNewerWorkItemBoardColumnMutation({
        items: cachedItems,
        workItemId: variables.workItemId,
        mutationId: context.mutationId,
      });
      if (hasNewerMutation) {
        markDocumentStale('feed:workItems');
        return Promise.resolve([]);
      }
      if (context) {
        const clearItem = (item: AzureDevOpsWorkItem) =>
          clearWorkItemBoardColumnUpdate(item, context.mutationId);
        const pullRequestWorkItemsFilter = {
          queryKey: ['pull-request-work-items'],
          predicate: (query: { queryKey: readonly unknown[] }) =>
            query.queryKey[2] === variables.providerId,
        };
        queryClient.setQueryData<AzureDevOpsWorkItem | null>(
          ['work-item', variables.providerId, variables.workItemId],
          (item) => (item ? clearItem(item) : item),
        );
        queryClient.setQueriesData<AzureDevOpsWorkItem[]>(
          { queryKey: ['work-items', variables.providerId] },
          (items) => items?.map(clearItem),
        );
        queryClient.setQueriesData<AzureDevOpsWorkItem[]>(
          { queryKey: ['work-items-by-ids', variables.providerId] },
          (items) => items?.map(clearItem),
        );
        queryClient.setQueriesData<AzureDevOpsWorkItem[]>(
          pullRequestWorkItemsFilter,
          (items) => items?.map(clearItem),
        );
      }
      markDocumentStale('feed:workItems');
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: ['work-items'] }),
        queryClient.invalidateQueries({
          queryKey: ['work-item', variables.providerId, variables.workItemId],
        }),
        queryClient.invalidateQueries({
          queryKey: ['work-items-by-ids', variables.providerId],
        }),
        queryClient.invalidateQueries({
          queryKey: ['work-item-history', variables.providerId],
        }),
        queryClient.invalidateQueries({
          queryKey: ['pull-request-work-items'],
        }),
      ]);
    },
  });
}

export function applyWorkItemBoardColumnUpdate(
  item: AzureDevOpsWorkItem,
  update: {
    workItemId: number;
    column: string;
    state: string;
    isDone: boolean;
    mutationId: number;
  },
): AzureDevOpsWorkItem {
  if (item.id !== update.workItemId) return item;
  const optimisticItem: AzureDevOpsWorkItem & {
    __boardColumnMutationId: number;
  } = {
    ...item,
    fields: {
      ...item.fields,
      state: update.state,
      boardColumn: update.column,
      boardColumnDone: update.isDone,
    },
    __boardColumnMutationId: update.mutationId,
  };
  return optimisticItem;
}

export function rollbackWorkItemBoardColumnUpdate(
  item: AzureDevOpsWorkItem,
  previousItem: AzureDevOpsWorkItem,
  update: {
    workItemId: number;
    column: string;
    state: string;
    isDone: boolean;
    mutationId: number;
  },
): AzureDevOpsWorkItem {
  if (item.id !== update.workItemId) return item;
  const optimisticItem = item as AzureDevOpsWorkItem & {
    __boardColumnMutationId?: number;
  };
  if (optimisticItem.__boardColumnMutationId !== update.mutationId) return item;
  const state = item.fields.state === update.state
    ? previousItem.fields.state
    : item.fields.state;
  const boardColumn = item.fields.boardColumn === update.column
    ? previousItem.fields.boardColumn
    : item.fields.boardColumn;
  const boardColumnDone = item.fields.boardColumnDone === update.isDone
    ? previousItem.fields.boardColumnDone
    : item.fields.boardColumnDone;
  const { __boardColumnMutationId: _mutationId, ...itemWithoutMutation } =
    optimisticItem;
  return {
    ...itemWithoutMutation,
    fields: {
      ...item.fields,
      state,
      boardColumn,
      boardColumnDone,
    },
  };
}

export function clearWorkItemBoardColumnUpdate(
  item: AzureDevOpsWorkItem,
  mutationId: number,
): AzureDevOpsWorkItem {
  const optimisticItem = item as AzureDevOpsWorkItem & {
    __boardColumnMutationId?: number;
  };
  if (optimisticItem.__boardColumnMutationId !== mutationId) return item;
  const { __boardColumnMutationId: _mutationId, ...itemWithoutMutation } =
    optimisticItem;
  return itemWithoutMutation;
}

export function getWorkItemBoardColumnMutationId(
  item: AzureDevOpsWorkItem,
): number | undefined {
  return (item as AzureDevOpsWorkItem & {
    __boardColumnMutationId?: number;
  }).__boardColumnMutationId;
}

export function hasNewerWorkItemBoardColumnMutation({
  items,
  workItemId,
  mutationId,
}: {
  items: AzureDevOpsWorkItem[];
  workItemId: number;
  mutationId: number;
}): boolean {
  return items.some((item) => {
    const itemMutationId = getWorkItemBoardColumnMutationId(item);
    return item.id === workItemId &&
      itemMutationId !== undefined &&
      itemMutationId !== mutationId;
  });
}

export function enqueueWorkItemBoardColumnUpdate<T>({
  key,
  update,
}: {
  key: string;
  update: () => Promise<T>;
}): Promise<T> {
  const previous = boardColumnUpdateQueues.get(key);
  const queued = previous
    ? previous.catch(() => undefined).then(update)
    : update();
  boardColumnUpdateQueues.set(key, queued);
  void queued.finally(() => {
    if (boardColumnUpdateQueues.get(key) === queued) {
      boardColumnUpdateQueues.delete(key);
    }
  }).catch(() => undefined);
  return queued;
}

export function useWorkItemComments(params: {
  providerId: string | null;
  projectName: string | null;
  workItemIds: number[];
  enabled?: boolean;
}) {
  return useQuery<WorkItemComment[]>({
    queryKey: [
      'work-item-comments',
      params.providerId,
      params.projectName,
      params.workItemIds,
    ],
    queryFn: async () => {
      if (
        !params.providerId ||
        !params.projectName ||
        params.workItemIds.length === 0
      )
        return [];
      const results = await Promise.all(
        params.workItemIds.map((workItemId) =>
          api.azureDevOps.getWorkItemComments({
            providerId: params.providerId!,
            projectName: params.projectName!,
            workItemId,
          }),
        ),
      );
      return results.flat();
    },
    enabled:
      params.enabled !== false &&
      !!params.providerId &&
      !!params.projectName &&
      params.workItemIds.length > 0,
    staleTime: 60_000,
  });
}

export function useWorkItemHistory(params: {
  providerId: string | null;
  projectName: string | null;
  workItemId: number | null;
  enabled?: boolean;
}) {
  return useQuery<WorkItemHistoryEntry[]>({
    queryKey: [
      'work-item-history',
      params.providerId,
      params.projectName,
      params.workItemId,
    ],
    queryFn: () =>
      api.azureDevOps.getWorkItemHistory({
        providerId: params.providerId!,
        projectName: params.projectName!,
        workItemId: params.workItemId!,
      }),
    enabled:
      params.enabled !== false &&
      !!params.providerId &&
      !!params.projectName &&
      !!params.workItemId,
    staleTime: 60_000,
  });
}

export function useAddWorkItemComment() {
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);

  return useMutation({
    mutationFn: (params: {
      providerId: string;
      projectName: string;
      workItemId: number;
      text: string;
    }) => api.azureDevOps.addWorkItemComment(params),
    onSuccess: (comment, variables) => {
      queryClient.setQueryData<WorkItemComment[]>(
        [
          'work-item-comments',
          variables.providerId,
          variables.projectName,
          [variables.workItemId],
        ],
        (existing) => {
          if (!existing) return existing;
          return [comment, ...existing.filter((c) => c.id !== comment.id)];
        },
      );
      queryClient.invalidateQueries({
        queryKey: [
          'work-item-comments',
          variables.providerId,
          variables.projectName,
        ],
      });
      queryClient.invalidateQueries({
        queryKey: ['work-item-history', variables.providerId],
      });
      queryClient.invalidateQueries({
        queryKey: [
          'work-item-summary',
          variables.providerId,
          variables.workItemId,
        ],
      });
    },
    onError: () => {
      addToast({ message: 'Failed to add work item comment', type: 'error' });
    },
  });
}

export function useRelatedTestCases(params: {
  providerId: string | null;
  projectName: string | null;
  workItemId: number | null;
  enabled?: boolean;
}) {
  return useQuery<AzureDevOpsWorkItem[]>({
    queryKey: [
      'related-test-cases',
      params.providerId,
      params.projectName,
      params.workItemId,
    ],
    queryFn: () =>
      api.azureDevOps.getRelatedTestCases({
        providerId: params.providerId!,
        projectName: params.projectName!,
        workItemId: params.workItemId!,
      }),
    enabled:
      params.enabled !== false &&
      !!params.providerId &&
      !!params.projectName &&
      !!params.workItemId,
    staleTime: 5 * 60_000,
  });
}

export type TestCaseWithSteps = {
  id: number;
  title: string;
  steps?: Array<{ action: string; expectedResult: string }>;
};

/**
 * Fetch related test cases for multiple work items at once.
 * Returns a map of workItemId -> test cases with their steps.
 */
export function useRelatedTestCasesForWorkItems(params: {
  providerId: string | null;
  projectName: string | null;
  workItemIds: number[];
}) {
  return useQuery<Record<number, TestCaseWithSteps[]>>({
    queryKey: [
      'related-test-cases-batch',
      params.providerId,
      params.projectName,
      params.workItemIds,
    ],
    queryFn: async () => {
      if (
        !params.providerId ||
        !params.projectName ||
        params.workItemIds.length === 0
      )
        return {};
      const results = await Promise.all(
        params.workItemIds.map(async (workItemId) => {
          const testCases = await api.azureDevOps.getRelatedTestCases({
            providerId: params.providerId!,
            projectName: params.projectName!,
            workItemId,
          });
          return [
            workItemId,
            testCases.map((tc) => ({
              id: tc.id,
              title: tc.fields.title,
              steps: tc.testSteps,
            })),
          ] as const;
        }),
      );
      return Object.fromEntries(results);
    },
    enabled:
      !!params.providerId &&
      !!params.projectName &&
      params.workItemIds.length > 0,
    staleTime: 5 * 60_000,
  });
}

export function useCurrentAzureUser(providerId: string | null) {
  return useQuery<AzureDevOpsUser>({
    queryKey: ['azure-current-user', providerId],
    queryFn: () => api.azureDevOps.getCurrentUser(providerId!),
    enabled: !!providerId,
    staleTime: 5 * 60_000, // 5 minutes - user info doesn't change often
  });
}

export function useUpdateWorkItemState() {
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);

  return useMutation({
    mutationFn: (params: {
      providerId: string;
      workItemId: number;
      state: string;
    }) => api.azureDevOps.updateWorkItemState(params),
    onMutate: async (variables) => {
      const queryKey = [
        'work-item',
        variables.providerId,
        variables.workItemId,
      ];
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<AzureDevOpsWorkItem | null>(
        queryKey,
      );
      if (previous) {
        queryClient.setQueryData<AzureDevOpsWorkItem>(queryKey, {
          ...previous,
          fields: { ...previous.fields, state: variables.state },
        });
      }
      return { previous, queryKey };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
      addToast({ message: 'Failed to update work item status', type: 'error' });
    },
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['work-item', variables.providerId, variables.workItemId],
      });
      queryClient.invalidateQueries({
        queryKey: ['work-item-history', variables.providerId],
      });
      queryClient.invalidateQueries({
        queryKey: ['work-items'],
      });
      queryClient.invalidateQueries({
        queryKey: ['pull-request-work-items'],
      });
    },
  });
}
