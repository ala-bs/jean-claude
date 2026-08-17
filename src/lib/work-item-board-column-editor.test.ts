import { describe, expect, it } from 'vitest';

import {
  applyWorkItemBoardColumnUpdate,
  enqueueWorkItemBoardColumnUpdate,
  getWorkItemBoardColumnMutationId,
  hasNewerWorkItemBoardColumnMutation,
  rollbackWorkItemBoardColumnUpdate,
} from '@/hooks/use-work-items';
import type { AzureDevOpsBoardColumn } from '@/lib/api';
import type { AzureDevOpsWorkItem } from '@/lib/api';
import { getEditableBoardColumns } from '@/features/work-item/ui-work-item-board-column-editor/utils';

const columns: AzureDevOpsBoardColumn[] = [
  {
    id: 'new',
    name: 'New',
    columnType: 'incoming',
    stateMappings: { Bug: 'New', Task: 'New' },
  },
  {
    id: 'testing',
    name: 'Testing',
    stateMappings: { Bug: 'Resolved' },
  },
  {
    id: 'done',
    name: 'Done',
    columnType: 'Outgoing',
    stateMappings: { Bug: 'Closed', Task: 'Closed' },
  },
];

describe('board column editor options', () => {
  it('only includes columns mapped for work item type', () => {
    expect(
      getEditableBoardColumns({
        columns,
        workItemType: 'Task',
        currentColumn: 'New',
      }).map((column) => column.name),
    ).toEqual(['New', 'Done']);
  });

  it('keeps unknown current column visible', () => {
    const result = getEditableBoardColumns({
      columns,
      workItemType: 'Task',
      currentColumn: 'Custom',
    });
    expect(result.map((column) => column.name)).toEqual([
      'Custom',
      'New',
      'Done',
    ]);
    expect(result[0].stateMappings).toEqual({});
  });

});

describe('board column optimistic cache updates', () => {
  const item: AzureDevOpsWorkItem = {
    id: 42,
    url: 'https://example/42',
    fields: {
      title: 'Original title',
      workItemType: 'Bug',
      state: 'Active',
      boardColumn: 'Doing',
      boardColumnDone: false,
    },
  };
  const update = {
    workItemId: 42,
    column: 'Done',
    state: 'Closed',
    isDone: true,
    mutationId: 1,
  };

  it('updates only matching work item board fields', () => {
    expect(applyWorkItemBoardColumnUpdate(item, update)).toMatchObject({
      id: 42,
      fields: {
        title: 'Original title',
        state: 'Closed',
        boardColumn: 'Done',
        boardColumnDone: true,
      },
    });
    expect(
      applyWorkItemBoardColumnUpdate({ ...item, id: 43 }, update),
    ).toEqual({ ...item, id: 43 });
  });

  it('rolls back board fields while preserving newer unrelated edits', () => {
    const optimistic = applyWorkItemBoardColumnUpdate(item, update);
    const current = {
      ...optimistic,
      fields: { ...optimistic.fields, title: 'Newer title' },
    };
    expect(
      rollbackWorkItemBoardColumnUpdate(current, item, update),
    ).toMatchObject({
      fields: {
        title: 'Newer title',
        state: 'Active',
        boardColumn: 'Doing',
        boardColumnDone: false,
      },
    });
  });

  it('does not overwrite a newer board update during rollback', () => {
    const newer = {
      ...item,
      fields: {
        ...item.fields,
        state: 'Resolved',
        boardColumn: 'Testing',
      },
    };
    expect(rollbackWorkItemBoardColumnUpdate(newer, item, update)).toBe(newer);
  });

  it('rolls back unchanged board fields while preserving newer state', () => {
    const optimistic = applyWorkItemBoardColumnUpdate(item, update);
    const current = {
      ...optimistic,
      fields: { ...optimistic.fields, state: 'Resolved' },
    };
    expect(
      rollbackWorkItemBoardColumnUpdate(current, item, update),
    ).toMatchObject({
      fields: {
        state: 'Resolved',
        boardColumn: 'Doing',
        boardColumnDone: false,
      },
    });
  });

  it('does not let an older failure roll back a newer same-state move', () => {
    const firstUpdate = {
      ...update,
      column: 'Ready',
      state: 'Active',
      isDone: false,
    };
    const secondUpdate = {
      ...firstUpdate,
      column: 'Doing',
      mutationId: 2,
    };
    const afterFirst = applyWorkItemBoardColumnUpdate(item, firstUpdate);
    const afterSecond = applyWorkItemBoardColumnUpdate(afterFirst, secondUpdate);

    expect(getWorkItemBoardColumnMutationId(afterSecond)).toBe(2);
    expect(
      hasNewerWorkItemBoardColumnMutation({
        items: [afterSecond],
        workItemId: item.id,
        mutationId: firstUpdate.mutationId,
      }),
    ).toBe(true);
    expect(
      rollbackWorkItemBoardColumnUpdate(afterSecond, item, firstUpdate),
    ).toBe(afterSecond);
  });
});

describe('board column update queue', () => {
  it('runs moves for one work item in invocation order', async () => {
    let releaseFirst: (() => void) | undefined;
    const calls: string[] = [];
    const first = enqueueWorkItemBoardColumnUpdate({
      key: 'provider-1:42',
      update: () => new Promise<void>((resolve) => {
        calls.push('first:start');
        releaseFirst = () => {
          calls.push('first:end');
          resolve();
        };
      }),
    });
    const second = enqueueWorkItemBoardColumnUpdate({
      key: 'provider-1:42',
      update: async () => {
        calls.push('second');
      },
    });

    await Promise.resolve();
    expect(calls).toEqual(['first:start']);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(calls).toEqual(['first:start', 'first:end', 'second']);
  });

  it('continues queue after an earlier move fails', async () => {
    const calls: string[] = [];
    const first = enqueueWorkItemBoardColumnUpdate({
      key: 'provider-1:43',
      update: async () => {
        calls.push('first');
        throw new Error('failed');
      },
    });
    const second = enqueueWorkItemBoardColumnUpdate({
      key: 'provider-1:43',
      update: async () => {
        calls.push('second');
      },
    });

    await expect(first).rejects.toThrow('failed');
    await second;
    expect(calls).toEqual(['first', 'second']);
  });
});
