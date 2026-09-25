import { describe, expect, it } from 'vitest';

import type { FeedItem } from '@shared/feed-types';
import { selectAssociatedWorkItemTasks } from './index';

function taskItem(
  taskId: string,
  workItemIds: string[],
  overrides: Partial<FeedItem> = {},
): FeedItem {
  return {
    id: `task:${taskId}`,
    source: 'task',
    attention: 'waiting',
    timestamp: '2026-09-25T00:00:00.000Z',
    projectId: 'project-1',
    projectName: 'Project',
    projectColor: '#fff',
    projectPriority: 'normal',
    title: taskId,
    taskId,
    workItemIds,
    ...overrides,
  };
}

describe('selectAssociatedWorkItemTasks', () => {
  it('matches normalized IDs, includes children, and excludes completed tasks', () => {
    const items = [
      taskItem('parent', ['42'], {
        children: [
          taskItem('child', ['42']),
          taskItem('completed-child', ['42'], { isCompleted: true }),
        ],
      }),
      taskItem('other', ['99']),
    ];

    expect(
      selectAssociatedWorkItemTasks(items, 42).map((item) => item.taskId),
    ).toEqual(['parent', 'child']);
  });
});
