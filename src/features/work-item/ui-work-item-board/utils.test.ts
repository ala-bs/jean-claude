import { describe, expect, it } from 'vitest';

import type { AzureDevOpsWorkItem } from '@/lib/api';

import { groupWorkItemsByBoardColumns } from './utils';

function workItem(id: number, stackRank?: number): AzureDevOpsWorkItem {
  return {
    id,
    url: `https://example.test/${id}`,
    fields: {
      title: `Item ${id}`,
      workItemType: 'User Story',
      state: 'New',
      stackRank,
    },
  };
}

describe('groupWorkItemsByBoardColumns', () => {
  it('sorts cards by Stack Rank within each column', () => {
    const [column] = groupWorkItemsByBoardColumns({
      boardColumns: [{
        id: 'new',
        name: 'New',
        stateMappings: { 'User Story': 'New' },
      }],
      workItems: [workItem(3, 30), workItem(1, 10), workItem(2, 20)],
    });

    expect(column.items.map((item) => item.id)).toEqual([1, 2, 3]);
  });

  it('places unranked cards last and preserves their response order', () => {
    const [column] = groupWorkItemsByBoardColumns({
      boardColumns: [{
        id: 'new',
        name: 'New',
        stateMappings: { 'User Story': 'New' },
      }],
      workItems: [workItem(3), workItem(1, 10), workItem(2)],
    });

    expect(column.items.map((item) => item.id)).toEqual([1, 3, 2]);
  });

  it('treats non-finite ranks as unranked', () => {
    const [column] = groupWorkItemsByBoardColumns({
      boardColumns: [{
        id: 'new',
        name: 'New',
        stateMappings: { 'User Story': 'New' },
      }],
      workItems: [workItem(3, Number.NaN), workItem(1, 10), workItem(2, Number.POSITIVE_INFINITY)],
    });

    expect(column.items.map((item) => item.id)).toEqual([1, 3, 2]);
  });
});
