import { describe, expect, it } from 'vitest';

import type { FeedItem } from '@shared/feed-types';

import { getUnpushedPullRequestKeys } from '.';

function createTaskItem(overrides: Partial<FeedItem>): FeedItem {
  return {
    id: 'task:task-1',
    source: 'task',
    attention: 'waiting',
    timestamp: '2026-07-15T00:00:00.000Z',
    projectId: 'project-1',
    projectName: 'Project',
    projectColor: '#000000',
    projectPriority: 'normal',
    title: 'Task',
    ...overrides,
  };
}

describe('getUnpushedPullRequestKeys', () => {
  it('keys unpushed tasks by project and pull request ID', () => {
    const keys = getUnpushedPullRequestKeys([
      createTaskItem({ pullRequestId: 12, hasUnpushedCommits: true }),
      createTaskItem({
        id: 'task:task-2',
        projectId: 'project-2',
        pullRequestId: 12,
        hasUnpushedCommits: false,
      }),
      createTaskItem({
        id: 'task:task-3',
        pullRequestId: 13,
      }),
      createTaskItem({
        id: 'task:parent',
        children: [
          createTaskItem({
            id: 'task:child',
            pullRequestId: 14,
            hasUnpushedCommits: true,
          }),
        ],
      }),
    ]);

    expect(keys).toEqual(new Set(['project-1:12', 'project-1:14']));
  });
});
