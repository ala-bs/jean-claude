import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cache$, resetCache } from '@/cache/cache-store';
import { ingestTask } from '@/cache/domains/tasks';
import { setDocumentResource } from '@/cache/cache-actions';
import { api } from '@/lib/api';
import type { FeedItem } from '@shared/feed-types';
import type { Task } from '@shared/types';

import { syncFeedWorktreeFlags } from './use-worktree-diff';

function createTask(overrides: Partial<Task>): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    prompt: 'Do the thing',
    status: 'completed',
    worktreePath: '/tmp/worktree',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Task;
}

function createFeedItem(): FeedItem {
  return {
    id: 'task-1',
    source: 'task',
    attention: 'completed',
    timestamp: '2026-01-01T00:00:00.000Z',
    projectId: 'project-1',
    projectName: 'Project 1',
    projectColor: '#000000',
    projectPriority: 'normal',
    title: 'Task 1',
    taskId: 'task-1',
    hasUncommittedChanges: true,
    hasUnpushedCommits: false,
  } as FeedItem;
}

/** The sync reads the task from the main process, not the renderer cache. */
function mockTask(task: Task | undefined) {
  vi.spyOn(api.tasks, 'findById').mockResolvedValue(task);
}

function feedItems() {
  return cache$.documents['feed:tasks'].data.get() as FeedItem[];
}

beforeEach(() => {
  resetCache();
  vi.restoreAllMocks();
  setDocumentResource('feed:tasks', [createFeedItem()]);
});

describe('syncFeedWorktreeFlags', () => {
  it('patches feed flags from the authoritative worktree status', async () => {
    mockTask(createTask({}));
    vi.spyOn(api.tasks.worktree, 'getStatus').mockResolvedValue({
      hasUncommittedChanges: false,
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      hasUnpushedCommits: true,
      currentBranch: 'feature',
    });

    await syncFeedWorktreeFlags('task-1');

    expect(feedItems()[0]).toMatchObject({
      hasUncommittedChanges: false,
      hasUnpushedCommits: true,
    });
  });

  it('skips tasks without a worktree (status would report the project repo)', async () => {
    // Stale renderer cache still shows a worktree: the fresh task must win.
    ingestTask(createTask({}));
    mockTask(createTask({ worktreePath: null }));
    const getStatus = vi.spyOn(api.tasks.worktree, 'getStatus');

    await syncFeedWorktreeFlags('task-1');

    expect(getStatus).not.toHaveBeenCalled();
    expect(feedItems()[0].hasUncommittedChanges).toBe(true);
  });

  it('skips when the task no longer exists', async () => {
    mockTask(undefined);
    const getStatus = vi.spyOn(api.tasks.worktree, 'getStatus');

    await syncFeedWorktreeFlags('task-1');

    expect(getStatus).not.toHaveBeenCalled();
    expect(feedItems()[0].hasUncommittedChanges).toBe(true);
  });

  it('ignores a slower earlier sync so the latest status wins', async () => {
    mockTask(createTask({}));
    const base = {
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      currentBranch: 'feature',
    };
    type Status = Awaited<ReturnType<typeof api.tasks.worktree.getStatus>>;
    let resolveFirst: (value: Status) => void = () => {};
    vi.spyOn(api.tasks.worktree, 'getStatus')
      .mockImplementationOnce(
        () =>
          new Promise<Status>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        ...base,
        hasUncommittedChanges: false,
        hasUnpushedCommits: false,
      });

    const first = syncFeedWorktreeFlags('task-1');
    await syncFeedWorktreeFlags('task-1');
    resolveFirst({
      ...base,
      hasUncommittedChanges: true,
      hasUnpushedCommits: true,
    });
    await first;

    expect(feedItems()[0]).toMatchObject({
      hasUncommittedChanges: false,
      hasUnpushedCommits: false,
    });
  });

  it('leaves the feed untouched when status fails', async () => {
    mockTask(createTask({}));
    vi.spyOn(api.tasks.worktree, 'getStatus').mockRejectedValue(
      new Error('boom'),
    );

    await expect(syncFeedWorktreeFlags('task-1')).resolves.toBeUndefined();
    expect(feedItems()[0].hasUncommittedChanges).toBe(true);
  });
});
