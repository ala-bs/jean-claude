import { beforeEach, describe, expect, it, vi } from 'vitest';

import { feedQueryKeys } from '@/lib/feed-query-keys';

import { cache$, resetCache } from './cache-store';
import {
  getFeedQueryKeyForCacheEvent,
  getPermissionQueryKeysForEvent,
  getReactQueryKeysForCacheEvent,
  handleCacheEvent,
  handlePermissionsChangedEvent,
} from './cache-listener';
import { resetCacheResourceSubscriptionsForTests } from './cache-subscriptions';
import { retainResource } from './cache-actions';


beforeEach(() => {
  resetCache();
  resetCacheResourceSubscriptionsForTests();
});

describe('getFeedQueryKeyForCacheEvent', () => {
  it('maps feed cache events to active React Query feed keys', () => {
    expect(
      getFeedQueryKeyForCacheEvent({
        type: 'feed.sourceChanged',
        source: 'pullRequests',
      }),
    ).toBe(feedQueryKeys.pullRequests);

    expect(
      getFeedQueryKeyForCacheEvent({
        type: 'feed.sourceChanged',
        source: 'workItems',
      }),
    ).toBe(feedQueryKeys.workItems);
  });

  it('ignores non-feed cache events', () => {
    expect(
      getFeedQueryKeyForCacheEvent({
        type: 'resource.invalidate',
        resourceKey: 'projects',
        reason: 'test',
      }),
    ).toBeNull();
  });

  it('maps pull request thread cache events to React Query thread keys', () => {
    expect(
      getReactQueryKeysForCacheEvent({
        type: 'pullRequest.threadsChanged',
        providerId: 'github',
        repoId: 'repo-1',
        pullRequestId: 42,
      }),
    ).toEqual([
      feedQueryKeys.pullRequests,
      ['pull-request-threads', 'github', 'repo-1', 42],
    ]);
  });

  it('maps pull request cache events to pull request feed keys', () => {
    expect(
      getReactQueryKeysForCacheEvent({
        type: 'pullRequest.patch',
        providerId: 'github',
        repoId: 'repo-1',
        pullRequestId: 42,
        patch: { title: 'Updated' },
      }),
    ).toEqual([feedQueryKeys.pullRequests]);
  });

  it('does not map feed snapshot pull request upserts to feed query invalidations', () => {
    expect(
      getReactQueryKeysForCacheEvent({
        type: 'pullRequest.upsert',
        providerId: 'github',
        repoId: 'repo-1',
        projectId: 'project-1',
        invalidateFeed: false,
        pullRequest: {
          id: 42,
          title: 'PR title',
          status: 'active',
          isDraft: false,
          createdBy: { id: 'user-1', displayName: 'User', uniqueName: 'u' },
          creationDate: '2026-01-01T00:00:00.000Z',
          sourceRefName: 'refs/heads/feature',
          targetRefName: 'refs/heads/main',
          url: 'https://example.com/pr/42',
          reviewers: [],
        },
      }),
    ).toEqual([]);
  });

  it('maps task events to task feed and completed-task keys', () => {
    expect(
      getReactQueryKeysForCacheEvent({
        type: 'task.delete',
        taskId: 'task-1',
        projectId: 'project-1',
      }),
    ).toEqual([feedQueryKeys.tasks, ['tasks', 'allCompleted']]);
  });

  it('invalidates pending workspace decisions only for PR workspace task events', () => {
    const prTask = {
      ...createTaskForDecisionTest(),
      type: 'pr-review' as const,
      pullRequestId: '42',
      prWorkspaceState: 'cleanup-pending' as const,
    };

    expect(
      getReactQueryKeysForCacheEvent({ type: 'task.upsert', task: prTask }),
    ).toContainEqual(['pr-workspace-decisions']);
    expect(
      getReactQueryKeysForCacheEvent({
        type: 'task.upsert',
        task: { ...prTask, type: 'agent', pullRequestId: null },
      }),
    ).not.toContainEqual(['pr-workspace-decisions']);
  });

  it('invalidates decisions only when PR workspace state enters or leaves pending', () => {
    const activeTask = {
      ...createTaskForDecisionTest(),
      type: 'pr-review' as const,
      pullRequestId: '42',
      prWorkspaceState: 'active' as const,
    };
    cache$.tasks[activeTask.id].set(activeTask);

    expect(
      getReactQueryKeysForCacheEvent({
        type: 'task.upsert',
        task: { ...activeTask, updatedAt: '2026-01-02T00:00:00.000Z' },
      }),
    ).not.toContainEqual(['pr-workspace-decisions']);
    expect(
      getReactQueryKeysForCacheEvent({
        type: 'task.upsert',
        task: { ...activeTask, prWorkspaceState: 'cleanup-pending' },
      }),
    ).toContainEqual(['pr-workspace-decisions']);

    cache$.tasks[activeTask.id].prWorkspaceState.set('cleanup-pending');
    expect(
      getReactQueryKeysForCacheEvent({
        type: 'task.upsert',
        task: { ...activeTask, prWorkspaceState: 'kept' },
      }),
    ).toContainEqual(['pr-workspace-decisions']);
  });

  it('maps project deletes to all project-backed feed keys', () => {
    expect(
      getReactQueryKeysForCacheEvent({
        type: 'project.delete',
        projectId: 'project-1',
      }),
    ).toEqual([
      feedQueryKeys.tasks,
      feedQueryKeys.pullRequests,
      feedQueryKeys.workItems,
      ['pr-workspace-decisions'],
      ['tasks', 'allCompleted'],
    ]);
  });

  it('maps step cache events to the task feed key', () => {
    expect(
      getReactQueryKeysForCacheEvent({
        type: 'step.delete',
        stepId: 'step-1',
        taskId: 'task-1',
      }),
    ).toEqual([feedQueryKeys.tasks]);
  });

  it('does not invalidate task feed query for local-only task patches', () => {
    expect(
      getReactQueryKeysForCacheEvent({
        type: 'task.patch',
        taskId: 'task-1',
        projectId: 'project-1',
        patch: { hasUnread: false },
        invalidateFeed: false,
      }),
    ).toEqual([['tasks', 'allCompleted']]);
  });
});

describe('handleCacheEvent', () => {
  it('ignores unrelated events without an active matching resource', () => {
    const queryClient = { invalidateQueries: vi.fn() };

    handleCacheEvent(
      {
        type: 'resource.invalidate',
        resourceKey: 'projects',
        reason: 'test',
      },
      queryClient,
    );

    expect(cache$.resources.projects.get()).toBeUndefined();
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });

  it('invalidates React Query thread data for active thread subscriptions', () => {
    const queryClient = { invalidateQueries: vi.fn() };
    retainResource('pullRequestThreads:github:repo-1:42');

    handleCacheEvent(
      {
        type: 'pullRequest.threadsChanged',
        providerId: 'github',
        repoId: 'repo-1',
        pullRequestId: 42,
      },
      queryClient,
    );

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: feedQueryKeys.pullRequests,
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['pull-request-threads', 'github', 'repo-1', 42],
    });
  });

  it('applies pull request events for active feed subscriptions', () => {
    const queryClient = { invalidateQueries: vi.fn() };
    retainResource('feed:pullRequests');

    handleCacheEvent(
      {
        type: 'pullRequest.patch',
        providerId: 'github',
        repoId: 'repo-1',
        pullRequestId: 42,
        patch: { title: 'Updated' },
      },
      queryClient,
    );

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: feedQueryKeys.pullRequests,
    });
  });

  it('hydrates pull request snapshots without invalidating the producing feed query', () => {
    const queryClient = { invalidateQueries: vi.fn() };
    retainResource('feed:pullRequests');

    handleCacheEvent(
      {
        type: 'pullRequest.upsert',
        providerId: 'github',
        repoId: 'repo-1',
        projectId: 'project-1',
        invalidateFeed: false,
        pullRequest: {
          id: 42,
          title: 'PR title',
          status: 'active',
          isDraft: false,
          createdBy: { id: 'user-1', displayName: 'User', uniqueName: 'u' },
          creationDate: '2026-01-01T00:00:00.000Z',
          sourceRefName: 'refs/heads/feature',
          targetRefName: 'refs/heads/main',
          url: 'https://example.com/pr/42',
          reviewers: [],
        },
      },
      queryClient,
    );

    expect(
      cache$.pullRequests['pullRequest:github:repo-1:42'].get()?.title,
    ).toBe('PR title');
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });

  it('invalidates task feed data for active feed subscriptions on task events', () => {
    const queryClient = { invalidateQueries: vi.fn() };
    retainResource('feed:tasks');

    handleCacheEvent(
      {
        type: 'task.delete',
        taskId: 'task-1',
        projectId: 'project-1',
      },
      queryClient,
    );

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: feedQueryKeys.tasks,
    });
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['tasks', 'allCompleted'],
    });
  });

  it('invalidates decisions from a PR task delete even without active cache subscriptions', () => {
    const queryClient = { invalidateQueries: vi.fn() };
    applyPrTaskForDecisionTest();

    handleCacheEvent(
      { type: 'task.delete', taskId: 'pr-task', projectId: 'project-1' },
      queryClient,
    );

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['pr-workspace-decisions'],
    });
    expect(cache$.tasks['pr-task'].get()).toBeUndefined();
  });

  it('recognizes queued PR task deletes when no task snapshot is cached', () => {
    const queryClient = {
      getQueryData: vi.fn().mockReturnValue([
        { projectId: 'project-1', pullRequestId: 42, taskIds: ['pr-task'] },
      ]),
      invalidateQueries: vi.fn(),
    };

    handleCacheEvent(
      { type: 'task.delete', taskId: 'pr-task', projectId: 'project-1' },
      queryClient,
    );

    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['pr-workspace-decisions'],
    });
  });
});

function createTaskForDecisionTest() {
  return {
    id: 'pr-task',
    projectId: 'project-1',
    name: 'PR workspace',
    prompt: 'Review PR',
    status: 'waiting' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    userCompleted: false,
    hasUnread: false,
    parentTaskId: null,
    pendingMessage: null,
    pullRequestUrl: null,
    workItemIds: null,
    workItemUrls: null,
    sourceBranch: null,
    startCommitHash: null,
    branchName: null,
    todoItems: [],
    targetBranch: null,
    worktreePath: null,
    branch: null,
    autoStart: false,
    interactionMode: null,
    modelPreference: null,
    thinkingEffort: null,
    agentBackend: null,
    prWorkspaceState: null,
    type: 'agent' as const,
    pullRequestId: null,
  };
}

function applyPrTaskForDecisionTest() {
  cache$.tasks['pr-task'].set({
    ...createTaskForDecisionTest(),
    type: 'pr-review',
    pullRequestId: '42',
    prWorkspaceState: 'cleanup-pending',
  });
}


describe('permissions:changed handling', () => {
  it('invalidates the project permissions key for project and worktree scopes', () => {
    expect(
      getPermissionQueryKeysForEvent({
        scope: 'project',
        projectPath: '/repo',
      }),
    ).toEqual([['projectPermissions', '/repo']]);

    expect(
      getPermissionQueryKeysForEvent({
        scope: 'worktree',
        projectPath: '/repo',
      }),
    ).toEqual([['projectPermissions', '/repo']]);
  });

  it('falls back to the whole prefix when no project path is known', () => {
    expect(getPermissionQueryKeysForEvent({ scope: 'project' })).toEqual([
      ['projectPermissions'],
    ]);
  });

  it('invalidates nothing for session scope (step events carry those rules)', () => {
    expect(
      getPermissionQueryKeysForEvent({ scope: 'session', stepId: 'step-1' }),
    ).toEqual([]);
  });

  it('invalidates global and project permissions for global scope', () => {
    expect(getPermissionQueryKeysForEvent({ scope: 'global' })).toEqual([
      ['globalPermissions'],
      ['projectPermissions'],
    ]);
  });

  it('invalidates every resolved key on the query client', () => {
    const invalidateQueries = vi.fn();
    handlePermissionsChangedEvent(
      { scope: 'project', projectPath: '/repo' },
      { invalidateQueries },
    );

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['projectPermissions', '/repo'],
    });
  });
});
