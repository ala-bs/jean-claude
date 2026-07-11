// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cache$, resetCache } from '@/cache/cache-store';
import { createRoot, type Root } from 'react-dom/client';
import { ingestTask, selectTask } from '@/cache/domains/tasks';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { updateFeedTaskPendingMessage, useDeleteWorktree } from './use-tasks';
import { api } from '@/lib/api';
import { createElement } from 'react';
import type { FeedItem } from '@shared/feed-types';
import { flushSync } from 'react-dom';
import { setDocumentResource } from '@/cache/cache-actions';
import type { Task } from '@shared/types';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    type: 'agent',
    name: 'Task 1',
    prompt: 'Do work',
    status: 'running',
    worktreePath: '/worktrees/task-1',
    startCommitHash: 'abc123',
    sourceBranch: 'main',
    branchName: 'task-1',
    hasUnread: false,
    userCompleted: false,
    sessionRules: {},
    workItemIds: null,
    workItemUrls: null,
    pullRequestId: null,
    pullRequestUrl: null,
    pendingMessage: null,
    todoItems: [],
    parentTaskId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createTaskFeedItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'task:task-1',
    source: 'task',
    attention: 'waiting',
    timestamp: '2026-01-01T00:00:00.000Z',
    projectId: 'project-1',
    projectName: 'Project 1',
    projectColor: '#123456',
    projectPriority: 'normal',
    title: 'Task 1',
    taskId: 'task-1',
    ...overrides,
  };
}

describe('updateFeedTaskPendingMessage', () => {
  beforeEach(() => {
    resetCache();
  });

  it('updates cached feed task item pending message', () => {
    setDocumentResource('feed:tasks', [createTaskFeedItem()], 123);

    updateFeedTaskPendingMessage('task-1', 'new note');

    expect(cache$.documents['feed:tasks'].data.get()).toMatchObject([
      { taskId: 'task-1', pendingMessage: 'new note' },
    ]);
    expect(cache$.resources['feed:tasks'].lastFetchedAt.get()).toBe(123);
  });

  it('updates cached child feed task item pending message', () => {
    setDocumentResource(
      'feed:tasks',
      [
        createTaskFeedItem({
          taskId: 'parent-task',
          children: [createTaskFeedItem({ taskId: 'child-task' })],
        }),
      ],
      123,
    );

    updateFeedTaskPendingMessage('child-task', 'child note');

    const [item] = cache$.documents['feed:tasks'].data.get() as FeedItem[];
    expect(item.children?.[0]?.pendingMessage).toBe('child note');
  });

  it('clears cached feed task item pending message', () => {
    setDocumentResource(
      'feed:tasks',
      [createTaskFeedItem({ pendingMessage: 'old note' })],
      123,
    );

    updateFeedTaskPendingMessage('task-1', null);

    const [item] = cache$.documents['feed:tasks'].data.get() as FeedItem[];
    expect(item.pendingMessage).toBeUndefined();
  });
});

describe('useDeleteWorktree', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    resetCache();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      flushSync(() => root?.unmount());
    }
    container?.remove();
    root = null;
    container = null;
    vi.restoreAllMocks();
  });

  it('passes keepBranch and clears cached worktree fields after deletion', async () => {
    ingestTask(createTask());
    const deleteWorktree = vi
      .spyOn(api.tasks.worktree, 'delete')
      .mockResolvedValue({});
    let mutation: ReturnType<typeof useDeleteWorktree> | undefined;

    function Harness() {
      mutation = useDeleteWorktree();
      return null;
    }

    const queryClient = new QueryClient();
    root = createRoot(container!);
    flushSync(() =>
      root?.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness),
        ),
      ),
    );

    await mutation?.mutateAsync({ taskId: 'task-1', keepBranch: true });

    expect(deleteWorktree).toHaveBeenCalledWith('task-1', { keepBranch: true });
    expect(selectTask('task-1')).toMatchObject({
      worktreePath: null,
      branchName: null,
      startCommitHash: null,
      sourceBranch: null,
    });
  });
});
