import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cache$, resetCache } from './cache-store';
import {
  getResourceChangeVersion,
  setDocumentResource,
} from './cache-actions';
import {
  invalidateFeedResource,
  invalidateFeedResources,
  updateFeedDocument,
  updateFeedTaskWorktreeFlags,
} from './feed-cache';
import type { FeedItem } from '@shared/feed-types';
import { feedQueryKeys } from '@/lib/feed-query-keys';

function createFeedItem(id: string) {
  return {
    id,
    source: 'task' as const,
    attention: 'running' as const,
    timestamp: '2026-01-01T00:00:00.000Z',
    projectId: 'project-1',
    projectName: 'Project 1',
    projectColor: '#000000',
    projectPriority: 'normal' as const,
    title: id,
    taskId: id,
  };
}

beforeEach(() => {
  resetCache();
});

describe('feed cache helpers', () => {
  it('marks feed resource stale and invalidates matching query key', () => {
    const queryClient = { invalidateQueries: vi.fn() };
    setDocumentResource('feed:tasks', []);

    invalidateFeedResource(queryClient, 'tasks');

    expect(cache$.resources['feed:tasks'].get()?.stale).toBe(true);
    expect(cache$.documents['feed:tasks'].get()?.stale).toBe(true);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: feedQueryKeys.tasks,
    });
  });

  it('invalidates multiple feed resources', () => {
    const queryClient = { invalidateQueries: vi.fn() };
    setDocumentResource('feed:tasks', []);
    setDocumentResource('feed:workItems', []);

    invalidateFeedResources(queryClient, ['tasks', 'workItems']);

    expect(cache$.resources['feed:tasks'].get()?.stale).toBe(true);
    expect(cache$.resources['feed:workItems'].get()?.stale).toBe(true);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: feedQueryKeys.tasks,
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: feedQueryKeys.workItems,
    });
  });

  it('updates feed document data without clearing stale metadata', () => {
    setDocumentResource('feed:tasks', [createFeedItem('task-1')]);
    cache$.resources['feed:tasks'].assign({ stale: true });
    cache$.documents['feed:tasks'].assign({ stale: true });

    updateFeedDocument('tasks', (items) => [
      { ...items[0], title: 'Updated' },
    ]);

    expect(cache$.documents['feed:tasks'].data.get()).toMatchObject([
      { id: 'task-1', title: 'Updated' },
    ]);
    expect(cache$.resources['feed:tasks'].get()?.stale).toBe(true);
    expect(cache$.documents['feed:tasks'].get()?.stale).toBe(true);
  });
});

describe('updateFeedTaskWorktreeFlags', () => {
  it('patches flags on a nested child task and bumps the change version', () => {
    setDocumentResource('feed:tasks', [
      {
        ...createFeedItem('parent-1'),
        hasUncommittedChanges: true,
        children: [
          { ...createFeedItem('child-1'), hasUncommittedChanges: true },
          { ...createFeedItem('child-2'), hasUncommittedChanges: true },
        ],
      },
    ]);
    const versionBefore = getResourceChangeVersion('feed:tasks');

    updateFeedTaskWorktreeFlags('child-1', {
      hasUncommittedChanges: false,
      hasUnpushedCommits: true,
    });

    const [parent] = cache$.documents['feed:tasks'].data.get() as FeedItem[];
    expect(parent.hasUncommittedChanges).toBe(true);
    expect(parent.children?.[0]).toMatchObject({
      hasUncommittedChanges: false,
      hasUnpushedCommits: true,
    });
    expect(parent.children?.[1].hasUncommittedChanges).toBe(true);
    expect(getResourceChangeVersion('feed:tasks')).toBeGreaterThan(
      versionBefore,
    );
  });

  it('does not touch the document when flags already match', () => {
    setDocumentResource('feed:tasks', [
      {
        ...createFeedItem('task-1'),
        hasUncommittedChanges: false,
        hasUnpushedCommits: false,
      },
    ]);
    const before = cache$.documents['feed:tasks'].data.get();
    const versionBefore = getResourceChangeVersion('feed:tasks');

    updateFeedTaskWorktreeFlags('task-1', {
      hasUncommittedChanges: false,
      hasUnpushedCommits: false,
    });

    expect(cache$.documents['feed:tasks'].data.get()).toBe(before);
    expect(getResourceChangeVersion('feed:tasks')).toBe(versionBefore);
  });

  it('is a no-op when the feed document is not loaded', () => {
    expect(() =>
      updateFeedTaskWorktreeFlags('task-1', {
        hasUncommittedChanges: false,
        hasUnpushedCommits: false,
      }),
    ).not.toThrow();
    expect(cache$.documents['feed:tasks'].data.get()).toBeUndefined();
  });
});
