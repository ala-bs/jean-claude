import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { api } from '@/lib/api';
import type { CacheEvent } from '@shared/cache-events';
import { feedQueryKeys } from '@/lib/feed-query-keys';


import {
  applyCacheEvent,
  isPrWorkspaceDecisionTaskEvent,
  PR_WORKSPACE_DECISIONS_QUERY_KEY,
} from './cache-events';
import { shouldApplyCacheEvent } from './cache-subscriptions';
import { startCacheGarbageCollector } from './cache-gc';


export function getFeedQueryKeyForCacheEvent(event: CacheEvent) {
  switch (event.type) {
    case 'feed.sourceChanged':
      switch (event.source) {
        case 'tasks':
          return feedQueryKeys.tasks;
        case 'pullRequests':
          return feedQueryKeys.pullRequests;
        case 'notes':
          return feedQueryKeys.notes;
        case 'workItems':
          return feedQueryKeys.workItems;
      }
      break;
    case 'project.delete':
    case 'task.upsert':
    case 'task.delete':
    case 'step.upsert':
    case 'step.patch':
    case 'step.delete':
      return feedQueryKeys.tasks;
    case 'task.patch':
      return event.invalidateFeed === false ? null : feedQueryKeys.tasks;
    case 'pullRequest.upsert':
      if (event.invalidateFeed === false) {
        return null;
      }
      return feedQueryKeys.pullRequests;
    case 'pullRequest.patch':
      return feedQueryKeys.pullRequests;
    case 'pullRequest.threadsChanged':
      return feedQueryKeys.pullRequests;
  }

  return null;
}

export function getReactQueryKeysForCacheEvent(event: CacheEvent) {
  const queryKeys: Array<readonly unknown[]> = [];
  const feedQueryKey = getFeedQueryKeyForCacheEvent(event);

  if (feedQueryKey) {
    queryKeys.push(feedQueryKey);
  }

  if (event.type === 'project.upsert') {
    queryKeys.push(
      feedQueryKeys.tasks,
      feedQueryKeys.pullRequests,
      feedQueryKeys.workItems,
    );
  }

  if (event.type === 'project.delete') {
    queryKeys.push(
      feedQueryKeys.pullRequests,
      feedQueryKeys.workItems,
      PR_WORKSPACE_DECISIONS_QUERY_KEY,
    );
  }

  if (event.type === 'pullRequest.threadsChanged') {
    queryKeys.push([
      'pull-request-threads',
      event.providerId,
      event.repoId,
      event.pullRequestId,
    ]);
  }

  if (
    event.type === 'project.delete' ||
    event.type === 'project.upsert' ||
    event.type === 'task.upsert' ||
    event.type === 'task.patch' ||
    event.type === 'task.delete'
  ) {
    queryKeys.push(['tasks', 'allCompleted']);
  }

  if (isPrWorkspaceDecisionTaskEvent(event)) {
    queryKeys.push(PR_WORKSPACE_DECISIONS_QUERY_KEY);
  }

  return queryKeys;
}

export function handleCacheEvent(
  event: CacheEvent,
  queryClient: Pick<QueryClient, 'invalidateQueries'> &
    Partial<Pick<QueryClient, 'getQueryData'>>,
) {
  const queuedDecisions = queryClient.getQueryData?.<
    Array<{ taskIds: string[] }>
  >(PR_WORKSPACE_DECISIONS_QUERY_KEY);
  const deletesQueuedPrWorkspaceTask =
    event.type === 'task.delete' &&
    queuedDecisions?.some((decision) =>
      decision.taskIds.includes(event.taskId),
    ) === true;
  const invalidatesPrWorkspaceDecisions =
    event.type === 'project.delete' ||
    deletesQueuedPrWorkspaceTask ||
    isPrWorkspaceDecisionTaskEvent(event);
  const mustApplyPrWorkspaceDeletion =
    invalidatesPrWorkspaceDecisions && event.type === 'task.delete';

  if (!shouldApplyCacheEvent(event) && !mustApplyPrWorkspaceDeletion) {
    if (invalidatesPrWorkspaceDecisions) {
      void queryClient.invalidateQueries({
        queryKey: PR_WORKSPACE_DECISIONS_QUERY_KEY,
      });
    }
    return;
  }

  const queryKeys = getReactQueryKeysForCacheEvent(event);
  if (
    invalidatesPrWorkspaceDecisions &&
    !queryKeys.includes(PR_WORKSPACE_DECISIONS_QUERY_KEY)
  ) {
    queryKeys.push(PR_WORKSPACE_DECISIONS_QUERY_KEY);
  }
  applyCacheEvent(event);

  for (const queryKey of queryKeys) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

export function CacheListener() {
  const queryClient = useQueryClient();

  useEffect(
    () =>
      api.cache.onEvent((event) => {
        handleCacheEvent(event, queryClient);
      }),
    [queryClient],
  );
  useEffect(() => startCacheGarbageCollector(), []);

  return null;
}
