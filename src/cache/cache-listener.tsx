import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { api } from '@/lib/api';
import type { CacheEvent } from '@shared/cache-events';
import { feedQueryKeys } from '@/lib/feed-query-keys';
import type { PermissionsChangedEvent } from '@shared/permission-types';


import { applyCacheEvent, isPrWorkspaceTaskDeleteEvent } from './cache-events';
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
    queryKeys.push(feedQueryKeys.pullRequests, feedQueryKeys.workItems);
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

  return queryKeys;
}

export function handleCacheEvent(
  event: CacheEvent,
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
) {
  // PR workspace deletions must reconcile caches even when nothing is
  // subscribed, otherwise deleted workspaces linger in the renderer.
  const mustApplyPrWorkspaceDeletion = isPrWorkspaceTaskDeleteEvent(event);

  if (!shouldApplyCacheEvent(event) && !mustApplyPrWorkspaceDeletion) {
    return;
  }

  applyCacheEvent(event);

  for (const queryKey of getReactQueryKeysForCacheEvent(event)) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

/**
 * Query keys to invalidate when persisted permission rules change anywhere.
 * Project-scoped changes invalidate that project's key; global changes (or a
 * change without a known project path) invalidate the whole prefix.
 */
export function getPermissionQueryKeysForEvent(
  event: PermissionsChangedEvent,
): Array<readonly unknown[]> {
  if (event.scope === 'global') {
    return [['globalPermissions'], ['projectPermissions']];
  }
  // Session rules live on the step itself and arrive through step cache events.
  if (event.scope === 'session') {
    return [];
  }
  return [
    event.projectPath
      ? ['projectPermissions', event.projectPath]
      : ['projectPermissions'],
  ];
}

export function handlePermissionsChangedEvent(
  event: PermissionsChangedEvent,
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
) {
  for (const queryKey of getPermissionQueryKeysForEvent(event)) {
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
  useEffect(
    () =>
      api.permissionEvents.onChanged((event) => {
        handlePermissionsChangedEvent(event, queryClient);
      }),
    [queryClient],
  );
  useEffect(() => startCacheGarbageCollector(), []);

  return null;
}
