import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AzureDevOpsPullRequest } from '@shared/azure-devops-types';

import { ProjectRepository, TaskRepository } from '../database/repositories';
import { PrViewSnapshotRepository } from '../database/repositories/pr-view-snapshots';
import { TaskStepRepository } from '../database/repositories/task-steps';

import {
  getCurrentUser,
  getPullRequestActivityMetadata,
  getPullRequestStatuses,
  listPullRequests,
} from './azure-devops-service';
import {
  getPrFeedItems,
  getTaskFeedItems,
  invalidatePrCache,
} from './feed-service';
import { completePrReviewTasksForMergedPr } from './pr-review-task-service';
import { emitCacheEvent } from './cache-event-service';
import { hasUncommittedWorktreeChanges } from './worktree-service';



vi.mock('../database/repositories', () => ({
  FeedNoteRepository: {},
  ProjectRepository: {
    findAll: vi.fn(),
  },
  TaskRepository: {
    findAllActive: vi.fn(),
    findChildrenForTasks: vi.fn(),
  },
}));

vi.mock('../database/repositories/pr-view-snapshots', () => ({
  PrViewSnapshotRepository: {
    findByProject: vi.fn(),
  },
}));

vi.mock('../database/repositories/task-steps', () => ({
  TaskStepRepository: {
    findByTaskIds: vi.fn(),
  },
}));

vi.mock('./azure-devops-service', () => ({
  getCurrentUser: vi.fn(),
  getPullRequestActivityMetadata: vi.fn(),
  getPullRequestStatuses: vi.fn(),
  getWorkItemById: vi.fn(),
  listPullRequests: vi.fn(),
  queryAssignedWorkItems: vi.fn(),
}));

vi.mock('./cache-event-service', () => ({
  emitCacheEvent: vi.fn(),
}));

vi.mock('./pr-review-task-service', () => ({
  completePrReviewTasksForMergedPr: vi.fn(),
}));

vi.mock('./worktree-service', () => ({
  hasUncommittedWorktreeChanges: vi.fn(),
}));

vi.mock('./step-service', () => ({
  getMostRecentlyUpdatedStep: vi.fn(),
}));

function createPullRequest(
  overrides: Partial<AzureDevOpsPullRequest> = {},
): AzureDevOpsPullRequest {
  return {
    id: 9886,
    title: 'Smartbar POC',
    status: 'active',
    isDraft: true,
    createdBy: {
      id: 'user-1',
      displayName: 'Jose Daniel Canizares Proano',
      uniqueName: 'jose@example.com',
    },
    creationDate: '2026-06-19T00:00:00.000Z',
    sourceRefName: 'refs/heads/feature/smartbar',
    targetRefName: 'refs/heads/main',
    url: 'https://example.com/pr/9886',
    reviewers: [],
    ...overrides,
  };
}

describe('getPrFeedItems', () => {
  beforeEach(() => {
    invalidatePrCache();
    vi.mocked(ProjectRepository.findAll).mockResolvedValue([
      {
        id: 'project-1',
        name: 'oes-v2',
        color: '#ff6b6b',
        logoPath: null,
        repoProviderId: 'provider-1',
        repoProjectId: 'ado-project-1',
        repoId: 'repo-1',
        showPrsInFeed: true,
        prPriority: 'normal',
      } as never,
    ]);
    vi.mocked(getCurrentUser).mockResolvedValue({
      id: 'current-user',
      displayName: 'Current User',
      emailAddress: 'current@example.com',
    });
    vi.mocked(listPullRequests).mockResolvedValue([createPullRequest()]);
    vi.mocked(getPullRequestActivityMetadata).mockResolvedValue({
      lastCommitDate: null,
      lastThreadActivityDate: null,
      activeThreadCount: 0,
      unresolvedCommentCount: 0,
    });
    vi.mocked(PrViewSnapshotRepository.findByProject).mockResolvedValue([]);
    vi.mocked(emitCacheEvent).mockClear();
  });

  it('includes PR title and draft state in pull request feed items', async () => {
    const items = await getPrFeedItems();

    expect(items[0]).toMatchObject({
      source: 'pull-request',
      pullRequestId: 9886,
      pullRequestUrl: 'https://example.com/pr/9886',
      title: 'Smartbar POC',
      isDraft: true,
    });
  });

  it('emits fetched PR snapshots for shared cache ingestion', async () => {
    await getPrFeedItems();

    expect(emitCacheEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pullRequest.upsert',
        providerId: 'provider-1',
        repoId: 'repo-1',
        projectId: 'project-1',
        pullRequest: expect.objectContaining({
          id: 9886,
          title: 'Smartbar POC',
          isDraft: true,
        }),
      }),
    );
  });
});

describe('getTaskFeedItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ProjectRepository.findAll).mockResolvedValue([
      {
        id: 'project-1',
        name: 'oes-v2',
        color: '#ff6b6b',
        logoPath: null,
        repoProviderId: 'provider-1',
        repoProjectId: 'ado-project-1',
        repoId: 'repo-1',
      } as never,
    ]);
    vi.mocked(TaskStepRepository.findByTaskIds).mockResolvedValue({});
    vi.mocked(TaskRepository.findChildrenForTasks).mockResolvedValue({});
    vi.mocked(getPullRequestStatuses).mockResolvedValue(
      new Map([
        [
          'ado-project-1:repo-1:12',
          {
            status: 'completed',
            isDraft: false,
            mergeStatus: 'succeeded',
            approvedBy: [],
            url: 'https://example.com/pr/12',
          },
        ],
      ]),
    );
    vi.mocked(completePrReviewTasksForMergedPr).mockResolvedValue([
      { id: 'review-task' } as never,
    ]);
  });

  it('omits a pr-review task completed by merged PR status from the current feed response', async () => {
    vi.mocked(TaskRepository.findAllActive).mockResolvedValue([
      {
        id: 'review-task',
        projectId: 'project-1',
        type: 'pr-review',
        name: 'Review PR #12',
        prompt: 'Review PR #12',
        status: 'waiting',
        hasUnread: false,
        userCompleted: false,
        pullRequestId: '12',
        pullRequestUrl: 'https://example.com/pr/12',
        workItemIds: null,
        workItemUrls: null,
        pendingMessage: null,
        updatedAt: '2026-07-05T00:00:00.000Z',
        projectName: 'oes-v2',
        projectColor: '#ff6b6b',
        projectLogoPath: null,
        repoProviderId: 'provider-1',
        repoId: 'repo-1',
      } as never,
    ]);

    await expect(getTaskFeedItems()).resolves.toEqual([]);

    expect(completePrReviewTasksForMergedPr).toHaveBeenCalledWith({
      projectId: 'project-1',
      pullRequestId: 12,
    });
  });

  it('adds active PR thread count to linked task items', async () => {
    vi.mocked(getPullRequestStatuses).mockResolvedValue(
      new Map([
        [
          'ado-project-1:repo-1:12',
          {
            status: 'active',
            isDraft: false,
            mergeStatus: 'succeeded',
            approvedBy: [],
            activeThreadCount: 2,
            url: 'https://example.com/pr/12',
          },
        ],
      ]),
    );
    vi.mocked(TaskRepository.findAllActive).mockResolvedValue([
      {
        id: 'task-1',
        projectId: 'project-1',
        type: 'code',
        name: 'Linked task',
        prompt: 'Linked task',
        status: 'waiting',
        hasUnread: false,
        userCompleted: false,
        pullRequestId: '12',
        pullRequestUrl: 'https://example.com/pr/12',
        workItemIds: null,
        workItemUrls: null,
        pendingMessage: null,
        updatedAt: '2026-07-05T00:00:00.000Z',
        projectName: 'oes-v2',
        projectColor: '#ff6b6b',
        projectLogoPath: null,
        repoProviderId: 'provider-1',
        repoId: 'repo-1',
      } as never,
    ]);

    await expect(getTaskFeedItems()).resolves.toEqual([
      expect.objectContaining({
        taskId: 'task-1',
        workItemPrStatus: 'active',
        activeThreadCount: 2,
      }),
    ]);
  });

  it('marks a PR-linked task when its worktree has uncommitted changes', async () => {
    vi.mocked(TaskRepository.findAllActive).mockResolvedValue([
      {
        id: 'task-1',
        projectId: 'project-1',
        type: 'agent',
        name: 'Ship feed indicator',
        prompt: 'Ship feed indicator',
        status: 'waiting',
        hasUnread: false,
        userCompleted: false,
        pullRequestId: '12',
        pullRequestUrl: 'https://example.com/pr/12',
        worktreePath: '/repo/worktrees/task-1',
        workItemIds: null,
        workItemUrls: null,
        pendingMessage: null,
        updatedAt: '2026-07-14T00:00:00.000Z',
        projectName: 'oes-v2',
        projectColor: '#ff6b6b',
        projectLogoPath: null,
        repoProviderId: 'provider-1',
        repoId: 'repo-1',
      } as never,
    ]);
    vi.mocked(hasUncommittedWorktreeChanges).mockResolvedValue(true);
    vi.mocked(getPullRequestStatuses).mockResolvedValue(new Map());

    await expect(getTaskFeedItems()).resolves.toEqual([
      expect.objectContaining({
        taskId: 'task-1',
        hasUncommittedChanges: true,
      }),
    ]);
    expect(hasUncommittedWorktreeChanges).toHaveBeenCalledWith(
      '/repo/worktrees/task-1',
    );
  });

  it('does not check worktree status for a task without an associated PR', async () => {
    vi.mocked(TaskRepository.findAllActive).mockResolvedValue([
      {
        id: 'task-1',
        projectId: 'project-1',
        type: 'agent',
        name: 'No PR yet',
        prompt: 'No PR yet',
        status: 'waiting',
        hasUnread: false,
        userCompleted: false,
        pullRequestId: null,
        pullRequestUrl: null,
        worktreePath: '/repo/worktrees/task-1',
        workItemIds: null,
        workItemUrls: null,
        pendingMessage: null,
        updatedAt: '2026-07-14T00:00:00.000Z',
        projectName: 'oes-v2',
        projectColor: '#ff6b6b',
        projectLogoPath: null,
        repoProviderId: 'provider-1',
        repoId: 'repo-1',
      } as never,
    ]);
    vi.mocked(getPullRequestStatuses).mockResolvedValue(new Map());

    await getTaskFeedItems();

    expect(hasUncommittedWorktreeChanges).not.toHaveBeenCalled();
  });

  it('keeps a PR-linked task in the feed when its worktree status check fails', async () => {
    vi.mocked(TaskRepository.findAllActive).mockResolvedValue([
      {
        id: 'task-1',
        projectId: 'project-1',
        type: 'agent',
        name: 'Status unavailable',
        prompt: 'Status unavailable',
        status: 'waiting',
        hasUnread: false,
        userCompleted: false,
        pullRequestId: '12',
        pullRequestUrl: 'https://example.com/pr/12',
        worktreePath: '/repo/worktrees/task-1',
        workItemIds: null,
        workItemUrls: null,
        pendingMessage: null,
        updatedAt: '2026-07-14T00:00:00.000Z',
        projectName: 'oes-v2',
        projectColor: '#ff6b6b',
        projectLogoPath: null,
        repoProviderId: 'provider-1',
        repoId: 'repo-1',
      } as never,
    ]);
    vi.mocked(hasUncommittedWorktreeChanges).mockRejectedValue(
      new Error('git status timed out'),
    );
    vi.mocked(getPullRequestStatuses).mockResolvedValue(new Map());

    const items = await getTaskFeedItems();

    expect(items).toEqual([
      expect.objectContaining({ taskId: 'task-1' }),
    ]);
    expect(items[0]).not.toHaveProperty('hasUncommittedChanges');
  });
});
