import type { FeedItem } from '@shared/feed-types';
import type { QueryClient } from '@tanstack/react-query';

import { markDocumentStale, markResourceChanged } from '@/cache/cache-actions';
import { cache$ } from '@/cache/cache-store';
import { feedQueryKeys } from '@/lib/feed-query-keys';

export type FeedResourceSource = 'tasks' | 'pullRequests' | 'notes' | 'workItems';

const feedResourceKeys = {
  tasks: 'feed:tasks',
  pullRequests: 'feed:pullRequests',
  notes: 'feed:notes',
  workItems: 'feed:workItems',
} as const satisfies Record<FeedResourceSource, string>;

const feedResourceQueryKeys = {
  tasks: feedQueryKeys.tasks,
  pullRequests: feedQueryKeys.pullRequests,
  notes: feedQueryKeys.notes,
  workItems: feedQueryKeys.workItems,
} as const satisfies Record<FeedResourceSource, readonly unknown[]>;

export function feedResourceKey(source: FeedResourceSource) {
  return feedResourceKeys[source];
}

export function invalidateFeedResource(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
  source: FeedResourceSource,
) {
  markDocumentStale(feedResourceKeys[source]);
  void queryClient.invalidateQueries({
    queryKey: feedResourceQueryKeys[source],
  });
}

export function invalidateFeedResources(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
  sources: FeedResourceSource[],
) {
  for (const source of sources) {
    invalidateFeedResource(queryClient, source);
  }
}

export function updateFeedDocument(
  source: FeedResourceSource,
  update: (items: FeedItem[]) => FeedItem[],
) {
  const key = feedResourceKeys[source];
  const current = cache$.documents[key].data.get() as FeedItem[] | undefined;
  if (!current) return;

  const next = update(current);
  if (next === current) return;

  markResourceChanged(key);
  cache$.documents[key].data.set(next);
}

/**
 * Optimistically updates worktree-derived flags on a task feed item (and its
 * children). These flags are only produced by the server feed enrichment, so
 * without this the badge can stay stale until a feed load actually commits.
 */
export function updateFeedTaskWorktreeFlags(
  taskId: string,
  flags: Pick<FeedItem, 'hasUncommittedChanges' | 'hasUnpushedCommits'>,
) {
  updateFeedDocument('tasks', (items) => {
    const updateItem = (item: FeedItem): FeedItem => {
      const children = item.children?.map(updateItem);
      const childrenChanged = children?.some(
        (child, index) => child !== item.children?.[index],
      );
      const withChildren = childrenChanged ? { ...item, children } : item;

      if (
        item.source !== 'task' ||
        item.taskId !== taskId ||
        (item.hasUncommittedChanges === flags.hasUncommittedChanges &&
          item.hasUnpushedCommits === flags.hasUnpushedCommits)
      ) {
        return withChildren;
      }

      return { ...withChildren, ...flags };
    };

    const next = items.map(updateItem);
    return next.some((item, index) => item !== items[index]) ? next : items;
  });
}
