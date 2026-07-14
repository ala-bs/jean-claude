import { useEffect, useMemo } from 'react';


import {
  getFeedPullRequestIdentityKey,
  partitionFeedItems,
} from '@/lib/feed-partition';
import { api } from '@/lib/api';
import type { CacheSubscription } from '@shared/cache-events';
import type { FeedItem } from '@shared/feed-types';
import type { Project } from '@shared/types';
import { setDocumentResource } from '@/cache/cache-actions';
import { useCacheResource } from '@/cache/use-cache-resource';
import { useFeedStore } from '@/stores/feed';
import { useNavigationStore } from '@/stores/navigation';
import { useProjects } from '@/hooks/use-projects';
import { useTaskMessagesStore } from '@/stores/task-messages';
import { useUIStore } from '@/stores/ui';
import { useWindowFocused } from '@/hooks/use-window-focused';



export const FEED_CACHE_SUBSCRIPTIONS: CacheSubscription[] = [
  { resourceKey: 'feed:tasks' },
  { resourceKey: 'feed:pullRequests' },
  { resourceKey: 'feed:notes' },
  { resourceKey: 'feed:workItems' },
];

function ingestFeedItems(key: string, items: FeedItem[]) {
  setDocumentResource(key, items);
}

function shouldHideReviewPr(item: FeedItem) {
  return (
    item.source === 'pull-request' &&
    (item.isOwnedByCurrentUser || item.isApprovedByMe)
  );
}

export function mergeTaskPrInfo(taskItems: FeedItem[], prItems: FeedItem[]) {
  const prByKey = new Map<string, FeedItem>();
  for (const item of prItems) {
    const key = getFeedPullRequestIdentityKey(item);
    if (key) {
      prByKey.set(key, item);
    }
  }

  const mergeItem = (item: FeedItem): FeedItem => {
    const children = item.children?.map(mergeItem);
    const withChildren = children ? { ...item, children } : item;

    if (item.source !== 'task' || item.pullRequestId == null)
      return withChildren;

    const prKey = getFeedPullRequestIdentityKey(item);
    const pr = prKey ? prByKey.get(prKey) : undefined;
    if (!pr) {
      return withChildren;
    }

    return {
      ...withChildren,
      activeThreadCount:
        withChildren.activeThreadCount ?? pr.activeThreadCount,
      unresolvedCommentCount:
        withChildren.unresolvedCommentCount ?? pr.unresolvedCommentCount,
    };
  };

  return taskItems.map(mergeItem);
}

export function getFeedItemProjectPriority(
  item: FeedItem,
  projectsById: Map<string, Project>,
): FeedItem['projectPriority'] {
  const project = projectsById.get(item.projectId);

  if (!project) {
    return item.projectPriority;
  }

  if (item.source === 'pull-request') {
    return project.prPriority;
  }

  if (item.source === 'work-item') {
    return project.workItemPriority;
  }

  return item.projectPriority;
}

export function refineFeedItemAttention(
  items: FeedItem[],
  pendingRequestsByTaskId: Record<string, { type: 'permission' | 'question' }>,
) {
  const taskIdsWithQuestions = new Set<string>();
  const taskIdsWithPermissions = new Set<string>();

  // Check lightweight task-level pending request map instead of full loaded
  // message cache; message streaming should not recompute feed.
  for (const [taskId, req] of Object.entries(pendingRequestsByTaskId)) {
    if (req.type === 'question') {
      taskIdsWithQuestions.add(taskId);
    } else if (req.type === 'permission') {
      taskIdsWithPermissions.add(taskId);
    }
  }

  const refineItem = (item: FeedItem): FeedItem => {
    const children = item.children?.map(refineItem);
    const itemWithChildren = children ? { ...item, children } : item;

    if (!item.taskId) {
      return itemWithChildren;
    }

    // Running tasks can ask permission or question, so refine running too.
    const refinable =
      item.attention === 'waiting' ||
      item.attention === 'needs-permission' ||
      item.attention === 'running';

    if (!refinable) {
      return itemWithChildren;
    }

    if (taskIdsWithQuestions.has(item.taskId)) {
      return { ...itemWithChildren, attention: 'has-question' as const };
    }

    if (taskIdsWithPermissions.has(item.taskId)) {
      return { ...itemWithChildren, attention: 'needs-permission' as const };
    }

    return itemWithChildren;
  };

  return items.map(refineItem);
}

export function useFeed() {
  const windowFocused = useWindowFocused();
  const { data: projects = [] } = useProjects();
  const pinned = useFeedStore((s) => s.pinned);
  const dismissed = useFeedStore((s) => s.dismissed);
  const lowPriority = useFeedStore((s) => s.lowPriority);
  const hiddenProjectIds = useFeedStore((s) => s.hiddenProjectIds);
  const prProjectOrder = useUIStore((s) => s.settings.prProjectOrder);
  const reconcile = useFeedStore((s) => s.reconcile);
  const lastAttention = useFeedStore((s) => s.lastAttention);
  const pendingRequestsByTaskId = useTaskMessagesStore(
    (s) => s.pendingRequestsByTaskId,
  );
  const feedRefetchInterval = windowFocused ? 3 * 60 * 1000 : false;

  const pinnedIds = useMemo(() => new Set(pinned.map((p) => p.id)), [pinned]);
  const dismissedIds = useMemo(() => new Set(dismissed), [dismissed]);
  const lowPriorityIds = useMemo(() => new Set(lowPriority), [lowPriority]);
  const hiddenProjectIdSet = useMemo(
    () => new Set(hiddenProjectIds),
    [hiddenProjectIds],
  );

  const taskQuery = useCacheResource({
    key: 'feed:tasks',
    load: async () => api.feed.getTaskItems(),
    ingest: (items) => ingestFeedItems('feed:tasks', items),
    staleTime: feedRefetchInterval === false ? Infinity : feedRefetchInterval,
  });
  const prQuery = useCacheResource({
    key: 'feed:pullRequests',
    load: async () => api.feed.getPullRequestItems(),
    ingest: (items) => ingestFeedItems('feed:pullRequests', items),
    staleTime: feedRefetchInterval === false ? Infinity : feedRefetchInterval,
  });
  const noteQuery = useCacheResource({
    key: 'feed:notes',
    load: async () => api.feed.getNoteItems(),
    ingest: (items) => ingestFeedItems('feed:notes', items),
    staleTime: feedRefetchInterval === false ? Infinity : feedRefetchInterval,
  });
  const workItemQuery = useCacheResource({
    key: 'feed:workItems',
    load: async () => api.feed.getWorkItemItems(),
    ingest: (items) => ingestFeedItems('feed:workItems', items),
    staleTime: feedRefetchInterval === false ? Infinity : feedRefetchInterval,
  });
  const taskRefetch = taskQuery.refetch;
  const prRefetch = prQuery.refetch;
  const noteRefetch = noteQuery.refetch;
  const workItemRefetch = workItemQuery.refetch;

  useEffect(() => {
    if (feedRefetchInterval === false) return;

    const intervalId = window.setInterval(() => {
      void taskRefetch();
      void prRefetch();
      void noteRefetch();
      void workItemRefetch();
    }, feedRefetchInterval);

    return () => window.clearInterval(intervalId);
  }, [
    feedRefetchInterval,
    noteRefetch,
    prRefetch,
    taskRefetch,
    workItemRefetch,
  ]);

  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );

  const queryData = useMemo(() => {
    const prItems = prQuery.data ?? [];
    const workItems = workItemQuery.data ?? [];
    const taskItems = mergeTaskPrInfo(taskQuery.data ?? [], prItems);
    const noteItems = (noteQuery.data ?? []).filter(
      (item) => !item.isCompleted,
    );
    const taskWorkItemIds = new Set(
      taskItems.flatMap((item) => (item.workItemIds ?? []).map(Number)),
    );
    const workItemItems = workItems.filter(
      (item) =>
        item.workItemId === undefined || !taskWorkItemIds.has(item.workItemId),
    );

    return [...taskItems, ...prItems, ...noteItems, ...workItemItems];
  }, [noteQuery.data, prQuery.data, taskQuery.data, workItemQuery.data]);

  const isLoading =
    taskQuery.isLoading ||
    prQuery.isLoading ||
    noteQuery.isLoading ||
    workItemQuery.isLoading;
  const isFetching =
    taskQuery.isFetching ||
    prQuery.isFetching ||
    noteQuery.isFetching ||
    workItemQuery.isFetching;
  const isError =
    taskQuery.isError ||
    prQuery.isError ||
    noteQuery.isError ||
    workItemQuery.isError;
  const hasAnyFeedData =
    taskQuery.data !== undefined ||
    prQuery.data !== undefined ||
    noteQuery.data !== undefined ||
    workItemQuery.data !== undefined;

  const reconcilePrState = useNavigationStore((s) => s.reconcilePrState);

  useEffect(() => {
    const items = queryData;
    if (!hasAnyFeedData) {
      return;
    }

    const next = items.map((item) => ({
      id: item.id,
      attention: item.attention,
    }));
    const sameLength = Object.keys(lastAttention).length === next.length;
    const sameAttention =
      sameLength &&
      next.every((item) => lastAttention[item.id] === item.attention);

    if (!sameAttention) {
      reconcile(next);
    }

    // Reconcile persisted PR view state — prune entries for PRs that are
    // no longer active (completed, abandoned, or gone from feed).
    // Only reconcile on a successful fetch to avoid nuking state on errors.
    if (prQuery.data && !prQuery.isError) {
      const activePrKeys = new Set<string>();
      for (const item of prQuery.data) {
        if (item.source === 'pull-request' && item.pullRequestId != null) {
          activePrKeys.add(`${item.projectId}:${item.pullRequestId}`);
        }
      }
      reconcilePrState(activePrKeys);
    }
  }, [
    hasAnyFeedData,
    lastAttention,
    prQuery.data,
    prQuery.isError,
    queryData,
    reconcile,
    reconcilePrState,
  ]);

  // Refine waiting/permission attention from in-memory pending request state.
  const refinedItems = useMemo(() => {
    return refineFeedItemAttention(queryData, pendingRequestsByTaskId);
  }, [queryData, pendingRequestsByTaskId]);

  const visibleFeedItems = useMemo(
    () => refinedItems.filter((item) => !shouldHideReviewPr(item)),
    [refinedItems],
  );

  const getProjectPriority = useMemo(
    () => (item: FeedItem) => getFeedItemProjectPriority(item, projectsById),
    [projectsById],
  );

  // Collect PR IDs already shown in a task's rail so we can hide the
  // standalone PR feed item (the rail already surfaces it).
  const taskOwnedPrKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const item of visibleFeedItems) {
      if (item.source === 'task' && item.taskType !== 'pr-review') {
        const key = getFeedPullRequestIdentityKey(item);
        if (key) keys.add(key);
      }
      // Also check children (subtasks) that own PRs
      if (item.children) {
        for (const child of item.children) {
          if (child.source === 'task' && child.taskType !== 'pr-review') {
            const key = getFeedPullRequestIdentityKey(child);
            if (key) keys.add(key);
          }
        }
      }
    }
    return keys;
  }, [visibleFeedItems]);

  const projectOptions = useMemo(() => {
    const byProjectId = new Map<
      string,
      { id: string; name: string; color: string; itemCount: number }
    >();

    for (const item of visibleFeedItems) {
      const existing = byProjectId.get(item.projectId);
      if (existing) {
        existing.itemCount += 1;
        continue;
      }

      const project = projectsById.get(item.projectId);
      byProjectId.set(item.projectId, {
        id: item.projectId,
        name:
          item.source === 'note'
            ? 'Notes'
            : (project?.name ?? item.projectName),
        color:
          item.source === 'note'
            ? 'var(--color-ink-3)'
            : (project?.color ?? item.projectColor),
        itemCount: 1,
      });
    }

    return Array.from(byProjectId.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [projectsById, visibleFeedItems]);

  const filteredOutCount = useMemo(
    () =>
      visibleFeedItems.filter((item) => hiddenProjectIdSet.has(item.projectId))
        .length,
    [visibleFeedItems, hiddenProjectIdSet],
  );

  const {
    pinnedItems,
    actionNeededItems,
    prReviewItems,
    activeTaskItems,
    highPriorityItems,
    normalItems,
    lowPriorityItems,
    dismissedCount,
  } = useMemo(() => {
    return partitionFeedItems({
      visibleFeedItems,
      hiddenProjectIdSet,
      pinned,
      pinnedIds,
      dismissedIds,
      lowPriorityIds,
      taskOwnedPrKeys,
      prProjectOrder,
      getProjectPriority,
    });
  }, [
    visibleFeedItems,
    getProjectPriority,
    pinned,
    pinnedIds,
    dismissedIds,
    hiddenProjectIdSet,
    lowPriorityIds,
    prProjectOrder,
    taskOwnedPrKeys,
  ]);

  const allVisibleItems = useMemo(
    () => [
      ...pinnedItems,
      ...prReviewItems,
      ...actionNeededItems,
      ...activeTaskItems,
      ...highPriorityItems,
      ...normalItems,
    ],
    [
      pinnedItems,
      prReviewItems,
      actionNeededItems,
      activeTaskItems,
      highPriorityItems,
      normalItems,
    ],
  );

  return {
    data: refinedItems,
    isLoading,
    isFetching,
    isError,
    refetch: async () => {
      await Promise.all([
        taskQuery.refetch(),
        prQuery.refetch(),
        noteQuery.refetch(),
        workItemQuery.refetch(),
      ]);
    },
    pinnedItems,
    actionNeededItems,
    prReviewItems,
    activeTaskItems,
    highPriorityItems,
    normalItems,
    lowPriorityItems,
    dismissedCount,
    allVisibleItems,
    projectOptions,
    hiddenProjectIds,
    filteredOutCount,
  };
}
