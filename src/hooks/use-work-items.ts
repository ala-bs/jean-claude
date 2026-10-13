import { useEffect, useMemo } from 'react';
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
  type WorkItemCommentReactionType,
  type WorkItemHistoryEntry,
} from '@/lib/api';
import {
  type AzureFieldRefName,
  CORE_FIELD_METADATA,
  FIELD_BOARD_COLUMN,
  FIELD_BOARD_COLUMN_DONE,
  FIELD_STATE,
  getTitle,
  type WorkItemFieldMetadata,
} from '@shared/work-item-field-types';
import { hashRefNames } from '@shared/work-item-display-config-types';
import { markDocumentStale } from '@/cache/cache-actions';
import { useToastStore } from '@/stores/toasts';

let boardColumnMutationSequence = 0;
const boardColumnUpdateQueues = new Map<string, Promise<unknown>>();

/**
 * Reported once per distinct refName set for the lifetime of the renderer:
 * every work item in a rejected response carries the same marker, and the
 * queries refetch, so without this the user would get a toast per item per
 * refetch.
 */
const reportedPartialFieldFailures = new Set<string>();

/**
 * Design failure mode F3: Azure rejected one or more configured extra fields
 * and the service retried without them. The rows are silently absent from the
 * panel (the F2 skip path), so without this the degradation is invisible.
 */
function usePartialFieldFailureToast(
  data: AzureDevOpsWorkItem[] | AzureDevOpsWorkItem | null | undefined,
) {
  const addToast = useToastStore((state) => state.addToast);
  const failedRefNames = useMemo(() => {
    const items = Array.isArray(data) ? data : data ? [data] : [];
    for (const item of items) {
      if (item.partialFieldFailure && item.partialFieldFailure.length > 0) {
        return item.partialFieldFailure;
      }
    }
    return null;
  }, [data]);

  useEffect(() => {
    if (!failedRefNames || failedRefNames.length === 0) return;
    const key = [...failedRefNames].sort().join(',');
    if (reportedPartialFieldFailures.has(key)) return;
    reportedPartialFieldFailures.add(key);
    addToast({
      type: 'error',
      message: `Some configured work item fields could not be loaded: ${failedRefNames.join(', ')}. Check Project Settings → Integrations.`,
    });
  }, [failedRefNames, addToast]);
}

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
  extraFieldRefNames?: AzureFieldRefName[];
}) {
  const extraFieldRefNames = params.extraFieldRefNames;
  const query = useQuery<AzureDevOpsWorkItem[]>({
    queryKey: [
      'work-items',
      params.providerId,
      params.projectId,
      params.filters,
      hashRefNames(extraFieldRefNames ?? []),
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
  usePartialFieldFailureToast(query.data);
  return query;
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
  extraFieldRefNames?: AzureFieldRefName[];
}) {
  const query = useQuery({
    queryKey: [
      'work-item',
      params.providerId,
      params.workItemId,
      hashRefNames(params.extraFieldRefNames ?? []),
    ],
    queryFn: () =>
      api.azureDevOps.getWorkItemById({
        providerId: params.providerId!,
        workItemId: params.workItemId!,
        extraFieldRefNames: params.extraFieldRefNames,
      }),
    enabled: !!params.providerId && !!params.workItemId,
    staleTime: 5 * 60_000,
  });
  usePartialFieldFailureToast(query.data);
  return query;
}

export function useWorkItemsByIds(params: {
  providerId: string | null;
  projectName: string | null;
  workItemIds: number[];
  enabled?: boolean;
  extraFieldRefNames?: AzureFieldRefName[];
}) {
  const query = useQuery<AzureDevOpsWorkItem[]>({
    queryKey: [
      'work-items-by-ids',
      params.providerId,
      params.projectName,
      [...new Set(params.workItemIds)].sort((a, b) => a - b),
      hashRefNames(params.extraFieldRefNames ?? []),
    ],
    queryFn: () =>
      api.azureDevOps.getWorkItemsByIds({
        providerId: params.providerId!,
        projectName: params.projectName!,
        workItemIds: [...new Set(params.workItemIds)],
        extraFieldRefNames: params.extraFieldRefNames,
      }),
    enabled:
      params.enabled !== false &&
      !!params.providerId && !!params.projectName && params.workItemIds.length > 0,
    staleTime: 5 * 60_000,
  });
  usePartialFieldFailureToast(query.data);
  return query;
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

const EMPTY_FIELD_METADATA: WorkItemFieldMetadata[] = [];

/**
 * Azure's field metadata for one project. Cached for an hour — work item type
 * definitions change very rarely.
 */
export function useWorkItemTypeFields(params: {
  providerId: string | undefined;
  azureProjectId: string | undefined;
}) {
  return useQuery<WorkItemFieldMetadata[]>({
    queryKey: [
      'work-item-type-fields',
      params.providerId,
      params.azureProjectId,
    ],
    queryFn: () =>
      api.azureDevOps.getWorkItemTypeFields({
        providerId: params.providerId!,
        azureProjectId: params.azureProjectId!,
      }),
    enabled: !!params.providerId && !!params.azureProjectId,
    staleTime: 60 * 60 * 1000,
  });
}

/**
 * The refName → metadata map used by every field renderer. Built-in core
 * metadata sits underneath so core fields stay renderable when Azure metadata
 * is unavailable. Memoized: the returned object identity is stable between
 * renders as long as the query data is.
 */
export function useWorkItemFieldMetadataMap(params: {
  providerId: string | undefined;
  azureProjectId: string | undefined;
}): Record<AzureFieldRefName, WorkItemFieldMetadata> {
  const { data } = useWorkItemTypeFields(params);
  const fields = data ?? EMPTY_FIELD_METADATA;
  return useMemo(() => {
    const map: Record<AzureFieldRefName, WorkItemFieldMetadata> = {
      ...CORE_FIELD_METADATA,
    };
    for (const field of fields) {
      map[field.refName] = field;
    }
    return map;
  }, [fields]);
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
      const previousDetails = queryClient.getQueriesData<AzureDevOpsWorkItem | null>(
        { queryKey: detailKey },
      );
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

      queryClient.setQueriesData<AzureDevOpsWorkItem | null>(
        { queryKey: detailKey },
        (item) => (item ? updateItem(item) : item),
      );
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
        previousDetails,
        previousWorkItems,
        previousWorkItemsByIds,
        previousPullRequestWorkItems,
        mutationId,
      };
    },
    onError: (error, variables, context) => {
      for (const [queryKey, previousDetail] of context?.previousDetails ?? []) {
        if (!previousDetail) continue;
        queryClient.setQueryData<AzureDevOpsWorkItem | null>(
          queryKey,
          (item) =>
            item
              ? rollbackWorkItemBoardColumnUpdate(item, previousDetail, {
                  ...variables,
                  mutationId: context!.mutationId,
                })
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
        ...queryClient
          .getQueriesData<AzureDevOpsWorkItem | null>({
            queryKey: ['work-item', variables.providerId, variables.workItemId],
          })
          .map(([, item]) => item),
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
        queryClient.setQueriesData<AzureDevOpsWorkItem | null>(
          {
            queryKey: ['work-item', variables.providerId, variables.workItemId],
          },
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
      [FIELD_STATE]: update.state,
      [FIELD_BOARD_COLUMN]: update.column,
      [FIELD_BOARD_COLUMN_DONE]: update.isDone,
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
  const state = item.fields[FIELD_STATE] === update.state
    ? previousItem.fields[FIELD_STATE]
    : item.fields[FIELD_STATE];
  const boardColumn = item.fields[FIELD_BOARD_COLUMN] === update.column
    ? previousItem.fields[FIELD_BOARD_COLUMN]
    : item.fields[FIELD_BOARD_COLUMN];
  const boardColumnDone = item.fields[FIELD_BOARD_COLUMN_DONE] === update.isDone
    ? previousItem.fields[FIELD_BOARD_COLUMN_DONE]
    : item.fields[FIELD_BOARD_COLUMN_DONE];
  const { __boardColumnMutationId: _mutationId, ...itemWithoutMutation } =
    optimisticItem;
  return {
    ...itemWithoutMutation,
    fields: {
      ...item.fields,
      [FIELD_STATE]: state,
      [FIELD_BOARD_COLUMN]: boardColumn,
      [FIELD_BOARD_COLUMN_DONE]: boardColumnDone,
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

export function useUpdateWorkItemComment() {
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  return useMutation({
    mutationFn: (params: {
      providerId: string;
      projectName: string;
      workItemId: number;
      commentId: number;
      text: string;
    }) => api.azureDevOps.updateWorkItemComment(params),
    onSuccess: (comment, variables) => {
      queryClient.setQueryData<WorkItemComment[]>(
        ['work-item-comments', variables.providerId, variables.projectName, [variables.workItemId]],
        (existing) =>
          existing?.map((item) =>
            item.id === comment.id
              ? { ...item, ...comment, reactions: item.reactions }
              : item,
          ),
      );
      queryClient.invalidateQueries({ queryKey: ['work-item-comments', variables.providerId, variables.projectName] });
    },
    onError: (error, variables) => {
      console.error('[work-item-comment] update failed', {
        workItemId: variables.workItemId,
        commentId: variables.commentId,
        error,
      });
      addToast({
        message:
          error instanceof Error
            ? `Failed to update comment: ${error.message}`
            : 'Failed to update work item comment',
        type: 'error',
      });
    },
  });
}

export function useSetWorkItemCommentReaction() {
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  return useMutation({
    mutationFn: (params: {
      providerId: string;
      projectName: string;
      workItemId: number;
      commentId: number;
      reactionType: WorkItemCommentReactionType;
      engaged: boolean;
    }) => api.azureDevOps.setWorkItemCommentReaction(params),
    onMutate: async (variables) => {
      const queryKey = ['work-item-comments', variables.providerId, variables.projectName, [variables.workItemId]];
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<WorkItemComment[]>(queryKey);
      queryClient.setQueryData<WorkItemComment[]>(queryKey, (comments) => comments?.map((comment) => {
        if (comment.id !== variables.commentId) return comment;
        const reactions = [...(comment.reactions ?? [])];
        const index = reactions.findIndex((reaction) => reaction.type === variables.reactionType);
        const current = index >= 0 ? reactions[index] : { type: variables.reactionType, count: 0, isCurrentUserEngaged: false };
        const next = { ...current, count: Math.max(0, current.count + (variables.engaged ? 1 : -1)), isCurrentUserEngaged: variables.engaged };
        if (index >= 0) reactions[index] = next; else reactions.push(next);
        return { ...comment, reactions };
      }));
      return { previous, queryKey };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(context.queryKey, context.previous);
      addToast({ message: 'Failed to update comment reaction', type: 'error' });
    },
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: ['work-item-comments', variables.providerId, variables.projectName] });
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
  enabled?: boolean;
}) {
  const workItemIds = [...new Set(params.workItemIds)].sort(
    (left, right) => left - right,
  );

  return useQuery<Record<number, TestCaseWithSteps[]>>({
    queryKey: [
      'related-test-cases-batch',
      params.providerId,
      params.projectName,
      workItemIds,
    ],
    queryFn: async () => {
      if (
        !params.providerId ||
        !params.projectName ||
        workItemIds.length === 0
      )
        return {};
      const results = await Promise.all(
        workItemIds.map(async (workItemId) => {
          const testCases = await api.azureDevOps.getRelatedTestCases({
            providerId: params.providerId!,
            projectName: params.projectName!,
            workItemId,
          });
          return [
            workItemId,
            testCases.map((tc) => ({
              id: tc.id,
              title: getTitle(tc),
              steps: tc.testSteps,
            })),
          ] as const;
        }),
      );
      return Object.fromEntries(results);
    },
    enabled:
      params.enabled !== false &&
      !!params.providerId &&
      !!params.projectName &&
      workItemIds.length > 0,
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
      const previous = queryClient.getQueriesData<AzureDevOpsWorkItem | null>({
        queryKey,
      });
      queryClient.setQueriesData<AzureDevOpsWorkItem | null>(
        { queryKey },
        (item) =>
          item
            ? {
                ...item,
                fields: { ...item.fields, [FIELD_STATE]: variables.state },
              }
            : item,
      );
      return { previous, queryKey };
    },
    onError: (_error, _variables, context) => {
      for (const [key, item] of context?.previous ?? []) {
        queryClient.setQueryData(key, item);
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
