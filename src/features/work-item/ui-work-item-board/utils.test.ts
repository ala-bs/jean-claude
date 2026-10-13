import { describe, expect, it } from 'vitest';
import {
  FIELD_BOARD_COLUMN,
  FIELD_STACK_RANK,
  FIELD_STATE,
  FIELD_WORK_ITEM_TYPE,
} from '@shared/work-item-field-types';

import type { AzureDevOpsBoardColumn, AzureDevOpsWorkItem } from '@/lib/api';

import { groupWorkItemsByBoardColumns } from './utils';

function makeWorkItem({
  id,
  stackRank,
  state = 'Active',
  boardColumn,
}: {
  id: number;
  stackRank?: number;
  state?: string;
  boardColumn?: string;
}): AzureDevOpsWorkItem {
  return {
    id,
    url: `https://example.invalid/${id}`,
    fields: {
      [FIELD_WORK_ITEM_TYPE]: 'User Story',
      [FIELD_STATE]: state,
      ...(stackRank === undefined ? {} : { [FIELD_STACK_RANK]: stackRank }),
      ...(boardColumn === undefined ? {} : { [FIELD_BOARD_COLUMN]: boardColumn }),
    },
  };
}

// Pinned against the pre-refName behaviour of `sortWorkItemsByStackRank`:
// finite ranks ascending first, then every item without a usable rank in its
// original relative order. Ties keep their original relative order too.
const STACK_RANK_FIXTURE = [
  makeWorkItem({ id: 1 }),
  makeWorkItem({ id: 2, stackRank: 300 }),
  makeWorkItem({ id: 3 }),
  makeWorkItem({ id: 4, stackRank: 100 }),
  makeWorkItem({ id: 5, stackRank: Number.NaN }),
  makeWorkItem({ id: 6, stackRank: 200 }),
  makeWorkItem({ id: 7, stackRank: 100 }),
];

const EXPECTED_ORDER = [4, 7, 6, 2, 1, 3, 5];

describe('groupWorkItemsByBoardColumns stack-rank ordering', () => {
  it('sorts by stack rank and pushes items with no stack rank to the end (state fallback)', () => {
    const [column] = groupWorkItemsByBoardColumns({
      workItems: STACK_RANK_FIXTURE,
      boardColumns: [],
    });

    expect(column.name).toBe('Active');
    expect(column.items.map((item) => item.id)).toEqual(EXPECTED_ORDER);
  });

  it('sorts by stack rank within a board column', () => {
    const boardColumns: AzureDevOpsBoardColumn[] = [
      { id: 'col-doing', name: 'Doing', stateMappings: { 'User Story': 'Active' } },
    ];
    const workItems = STACK_RANK_FIXTURE.map((item) => ({
      ...item,
      fields: { ...item.fields, [FIELD_BOARD_COLUMN]: 'Doing' },
    }));

    const [column] = groupWorkItemsByBoardColumns({ workItems, boardColumns });

    expect(column.id).toBe('col-doing');
    expect(column.items.map((item) => item.id)).toEqual(EXPECTED_ORDER);
  });

  it('treats a non-finite stack rank the same as a missing one', () => {
    const [column] = groupWorkItemsByBoardColumns({
      workItems: [
        makeWorkItem({ id: 10, stackRank: Number.POSITIVE_INFINITY }),
        makeWorkItem({ id: 11, stackRank: 5 }),
        makeWorkItem({ id: 12 }),
      ],
      boardColumns: [],
    });

    expect(column.items.map((item) => item.id)).toEqual([11, 10, 12]);
  });

  it('orders state groups by workflow order and sorts each group independently', () => {
    const columns = groupWorkItemsByBoardColumns({
      workItems: [
        makeWorkItem({ id: 20, state: 'Closed', stackRank: 2 }),
        makeWorkItem({ id: 21, state: 'New' }),
        makeWorkItem({ id: 22, state: 'New', stackRank: 9 }),
        makeWorkItem({ id: 23, state: 'Closed', stackRank: 1 }),
      ],
      boardColumns: [],
    });

    expect(
      columns.map((column) => [column.name, column.items.map((i) => i.id)]),
    ).toEqual([
      ['New', [22, 21]],
      ['Closed', [23, 20]],
    ]);
  });
});
