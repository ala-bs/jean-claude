import { describe, expect, it } from 'vitest';

import type { FeedItem } from '@shared/feed-types';

import { partitionFeedItems } from './feed-partition';

function prItem(overrides: Partial<FeedItem> & { id: string }): FeedItem {
  return {
    source: 'pull-request',
    attention: 'review-requested',
    timestamp: '2026-05-30T00:00:00.000Z',
    projectId: 'project-1',
    projectName: 'Project',
    projectColor: '#fff',
    projectPriority: 'normal',
    title: overrides.id,
    pullRequestId: Number(overrides.id.replace(/\D/g, '')) || 1,
    ...overrides,
  };
}

function taskItem(overrides: Partial<FeedItem> & { id: string }): FeedItem {
  return {
    source: 'task',
    attention: 'waiting',
    timestamp: '2026-05-30T00:00:00.000Z',
    projectId: 'project-1',
    projectName: 'Project',
    projectColor: '#fff',
    projectPriority: 'normal',
    title: overrides.id,
    taskId: overrides.id,
    ...overrides,
  };
}

describe('partitionFeedItems', () => {
  it('keeps manually low-priority PRs at the end of the carousel', async () => {
    const markedLow = prItem({ id: 'pr:project-1:1' });
    const projectLow = prItem({
      id: 'pr:project-1:2',
      projectPriority: 'low',
    });
    const normal = prItem({ id: 'pr:project-1:3' });

    const result = partitionFeedItems({
      visibleFeedItems: [markedLow, projectLow, normal],
      hiddenProjectIdSet: new Set(),
      pinned: [],
      pinnedIds: new Set(),
      dismissedIds: new Set(),
      lowPriorityIds: new Set([markedLow.id]),
      taskOwnedPrIds: new Set(),
    });

    expect(result.prReviewItems.map((item) => item.id)).toEqual([
      normal.id,
      projectLow.id,
      markedLow.id,
    ]);
    expect(result.lowPriorityItems.map((item) => item.id)).toEqual([]);
  });

  it('keeps draft PRs in the carousel', async () => {
    const draft = prItem({ id: 'pr:project-1:1', isDraft: true });
    const normal = prItem({ id: 'pr:project-1:2' });

    const result = partitionFeedItems({
      visibleFeedItems: [draft, normal],
      hiddenProjectIdSet: new Set(),
      pinned: [],
      pinnedIds: new Set(),
      dismissedIds: new Set(),
      lowPriorityIds: new Set(),
      taskOwnedPrIds: new Set(),
    });

    expect(result.prReviewItems.map((item) => item.id)).toEqual([
      draft.id,
      normal.id,
    ]);
    expect(result.normalItems.map((item) => item.id)).toEqual([]);
    expect(result.lowPriorityItems.map((item) => item.id)).toEqual([]);
  });

  it('orders PR reviews by custom project order', async () => {
    const firstProject = prItem({
      id: 'pr:project-1:1',
      projectId: 'project-1',
    });
    const secondProject = prItem({
      id: 'pr:project-2:2',
      projectId: 'project-2',
    });
    const unorderedProject = prItem({
      id: 'pr:project-3:3',
      projectId: 'project-3',
    });

    const result = partitionFeedItems({
      visibleFeedItems: [firstProject, unorderedProject, secondProject],
      hiddenProjectIdSet: new Set(),
      pinned: [],
      pinnedIds: new Set(),
      dismissedIds: new Set(),
      lowPriorityIds: new Set(),
      taskOwnedPrIds: new Set(),
      prProjectOrder: ['project-2', 'project-1'],
    });

    expect(result.prReviewItems.map((item) => item.id)).toEqual([
      secondProject.id,
      firstProject.id,
      unorderedProject.id,
    ]);
  });

  it('orders task parents by latest child task activity', async () => {
    const parentWithRecentChild = taskItem({
      id: 'task:parent-with-recent-child',
      timestamp: '2026-05-30T00:00:00.000Z',
      children: [
        taskItem({
          id: 'task:recent-child',
          timestamp: '2026-06-02T00:00:00.000Z',
          parentTaskId: 'parent-with-recent-child',
        }),
      ],
    });
    const newerParent = taskItem({
      id: 'task:newer-parent',
      timestamp: '2026-06-01T00:00:00.000Z',
    });

    const result = partitionFeedItems({
      visibleFeedItems: [newerParent, parentWithRecentChild],
      hiddenProjectIdSet: new Set(),
      pinned: [],
      pinnedIds: new Set(),
      dismissedIds: new Set(),
      lowPriorityIds: new Set(),
      taskOwnedPrIds: new Set(),
    });

    expect(result.highPriorityItems.map((item) => item.id)).toEqual([
      parentWithRecentChild.id,
      newerParent.id,
    ]);
  });

  it('keeps PRs in review carousel when only owned by a PR review task', async () => {
    const reviewTask = taskItem({
      id: 'task:review-pr-1',
      taskType: 'pr-review',
      pullRequestId: 1,
    });
    const reviewedPr = prItem({ id: 'pr:project-1:1', pullRequestId: 1 });

    const taskOwnedPrKeys = new Set<string>();
    if (reviewTask.taskType !== 'pr-review') {
      taskOwnedPrKeys.add('project-1:1');
    }

    const result = partitionFeedItems({
      visibleFeedItems: [reviewTask, reviewedPr],
      hiddenProjectIdSet: new Set(),
      pinned: [],
      pinnedIds: new Set(),
      dismissedIds: new Set(),
      lowPriorityIds: new Set(),
      taskOwnedPrKeys,
    });

    expect(result.prReviewItems.map((item) => item.id)).toContain(reviewedPr.id);
  });
});

describe('partitionFeedItems - completed PR zone', () => {
  const base = {
    hiddenProjectIdSet: new Set<string>(),
    pinned: [] as { id: string; order: number }[],
    pinnedIds: new Set<string>(),
    dismissedIds: new Set<string>(),
    lowPriorityIds: new Set<string>(),
  };

  it('promotes tasks whose PR is merged out of the normal zones', () => {
    const merged = taskItem({ id: 'task-1', workItemPrStatus: 'completed' });
    const plain = taskItem({ id: 'task-2' });

    const result = partitionFeedItems({
      ...base,
      visibleFeedItems: [merged, plain],
    });

    expect(result.completedPrItems.map((i) => i.id)).toEqual([merged.id]);
    expect(result.highPriorityItems.map((i) => i.id)).toEqual([plain.id]);
  });

  it('promotes a task whose child subtask has a merged PR', () => {
    const parent = taskItem({
      id: 'task-1',
      children: [taskItem({ id: 'task-1a', workItemPrStatus: 'completed' })],
    });

    const result = partitionFeedItems({ ...base, visibleFeedItems: [parent] });

    expect(result.completedPrItems.map((i) => i.id)).toEqual([parent.id]);
  });

  it('keeps blocked tasks in the action-needed zone even when merged', () => {
    const blocked = taskItem({
      id: 'task-1',
      attention: 'needs-permission',
      workItemPrStatus: 'completed',
    });

    const result = partitionFeedItems({ ...base, visibleFeedItems: [blocked] });

    expect(result.actionNeededItems.map((i) => i.id)).toEqual([blocked.id]);
    expect(result.completedPrItems).toEqual([]);
  });

  it('leaves pr-review workspace tasks in the PR workspace zone', () => {
    const review = taskItem({
      id: 'task-1',
      taskType: 'pr-review',
      workItemPrStatus: 'completed',
    });

    const result = partitionFeedItems({ ...base, visibleFeedItems: [review] });

    expect(result.prWorkspaceItems.map((i) => i.id)).toEqual([review.id]);
    expect(result.completedPrItems).toEqual([]);
  });

  it('does not promote dismissed or pinned merged tasks', () => {
    const dismissed = taskItem({ id: 'task-1', workItemPrStatus: 'completed' });
    const pinnedTask = taskItem({ id: 'task-2', workItemPrStatus: 'completed' });

    const result = partitionFeedItems({
      ...base,
      visibleFeedItems: [dismissed, pinnedTask],
      dismissedIds: new Set([dismissed.id]),
      pinned: [{ id: pinnedTask.id, order: 0 }],
      pinnedIds: new Set([pinnedTask.id]),
    });

    expect(result.completedPrItems).toEqual([]);
    expect(result.dismissedCount).toBe(1);
    expect(result.pinnedItems.map((i) => i.id)).toEqual([pinnedTask.id]);
  });
});
