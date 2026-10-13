import {
  buildAzureBoardBaseModel,
  buildAzureBoardRelationshipModel,
} from './build-board-model';
import { describe, expect, it } from 'vitest';
import {
  FIELD_ASSIGNED_TO,
  FIELD_STATE,
  FIELD_TAGS,
  FIELD_TITLE,
  FIELD_WORK_ITEM_TYPE,
} from '@shared/work-item-field-types';

import type { AzureDevOpsWorkItem } from '@/lib/api';
import { DEFAULT_AZURE_BOARD_FILTERS } from '@/stores/azure-board';

function makeWorkItem({
  id,
  title = `Item ${id}`,
  type = 'User Story',
  state = 'Active',
  tags,
  assignedTo,
  childIds,
}: {
  id: number;
  title?: string;
  type?: string;
  state?: string;
  tags?: string;
  assignedTo?: string;
  childIds?: number[];
}): AzureDevOpsWorkItem {
  return {
    id,
    url: `https://dev.azure.com/example/_workitems/edit/${id}`,
    fields: {
      [FIELD_TITLE]: title,
      [FIELD_WORK_ITEM_TYPE]: type,
      [FIELD_STATE]: state,
      ...(tags === undefined ? {} : { [FIELD_TAGS]: tags }),
      ...(assignedTo === undefined
        ? {}
        : { [FIELD_ASSIGNED_TO]: { displayName: assignedTo } }),
    },
    ...(childIds === undefined ? {} : { childIds }),
  };
}

function baseModel({
  items,
  filters,
}: {
  items: AzureDevOpsWorkItem[];
  filters?: Partial<typeof DEFAULT_AZURE_BOARD_FILTERS>;
}) {
  return buildAzureBoardBaseModel({
    metadataItems: items,
    items,
    iterations: [],
    filters: { ...DEFAULT_AZURE_BOARD_FILTERS, ...filters },
  });
}

describe('buildAzureBoardBaseModel — tag filtering', () => {
  it('matches a whole tag, not a substring of a longer tag', () => {
    const items = [
      makeWorkItem({ id: 1, tags: 'backend' }),
      makeWorkItem({ id: 2, tags: 'backend-infra' }),
      makeWorkItem({ id: 3, tags: 'ui; backend' }),
    ];

    const { visibleItems } = baseModel({ items, filters: { tags: ['backend'] } });

    expect(visibleItems.map((item) => item.id)).toEqual([1, 3]);
  });

  it('keeps every item when no tag filter is selected', () => {
    const items = [
      makeWorkItem({ id: 1, tags: 'backend' }),
      makeWorkItem({ id: 2 }),
    ];

    const { visibleItems } = baseModel({ items });

    expect(visibleItems.map((item) => item.id)).toEqual([1, 2]);
  });

  it('matches tags case-insensitively and ignores surrounding whitespace', () => {
    const items = [makeWorkItem({ id: 1, tags: '  Backend ;  UI ' })];

    const { visibleItems } = baseModel({
      items,
      filters: { tags: [' backend '] },
    });

    expect(visibleItems.map((item) => item.id)).toEqual([1]);
  });

  it('excludes items with no tags when a tag filter is active', () => {
    const items = [makeWorkItem({ id: 1 }), makeWorkItem({ id: 2, tags: 'ui' })];

    const { visibleItems } = baseModel({ items, filters: { tags: ['ui'] } });

    expect(visibleItems.map((item) => item.id)).toEqual([2]);
  });

  it('derives tag options from the split tag string', () => {
    const items = [
      makeWorkItem({ id: 1, tags: 'backend; ui' }),
      makeWorkItem({ id: 2, tags: 'Backend' }),
    ];

    const { tagOptions } = baseModel({ items });

    expect(tagOptions).toEqual(['backend', 'ui']);
  });
});

describe('buildAzureBoardBaseModel — assignee filtering', () => {
  it('keeps only items assigned to a selected assignee', () => {
    const items = [
      makeWorkItem({ id: 1, assignedTo: 'Ada Lovelace' }),
      makeWorkItem({ id: 2, assignedTo: 'Grace Hopper' }),
      makeWorkItem({ id: 3 }),
    ];

    const { visibleItems } = baseModel({
      items,
      filters: { assignees: ['Ada Lovelace'] },
    });

    expect(visibleItems.map((item) => item.id)).toEqual([1]);
  });

  it('derives assignee options from the identity display name', () => {
    const items = [
      makeWorkItem({ id: 1, assignedTo: 'Grace Hopper' }),
      makeWorkItem({ id: 2, assignedTo: 'Ada Lovelace' }),
      makeWorkItem({ id: 3 }),
    ];

    expect(baseModel({ items }).assignees).toEqual([
      'Ada Lovelace',
      'Grace Hopper',
    ]);
  });
});

describe('buildAzureBoardBaseModel — work item type', () => {
  it('derives the type options from the work item type field', () => {
    const items = [
      makeWorkItem({ id: 1, type: 'Bug' }),
      makeWorkItem({ id: 2, type: 'User Story' }),
      makeWorkItem({ id: 3, type: 'Bug' }),
    ];

    expect(baseModel({ items }).types).toEqual(['Bug', 'User Story']);
  });

  it('treats only backlog item types as stories when collecting linked bug ids', () => {
    const items = [
      makeWorkItem({ id: 1, type: 'User Story', childIds: [10] }),
      makeWorkItem({ id: 2, type: 'Bug', childIds: [20] }),
    ];

    expect(baseModel({ items }).storyLinkedWorkItemIds).toEqual([10]);
  });
});

describe('buildAzureBoardRelationshipModel — state', () => {
  it('counts child bugs in a closed state', () => {
    const story = makeWorkItem({
      id: 1,
      type: 'User Story',
      childIds: [10, 11, 12],
    });
    const childWorkItems = [
      makeWorkItem({ id: 10, type: 'Bug', state: 'Closed' }),
      makeWorkItem({ id: 11, type: 'Bug', state: 'Done' }),
      makeWorkItem({ id: 12, type: 'Bug', state: 'Active' }),
    ];

    const { childBugProgressByWorkItemId } = buildAzureBoardRelationshipModel({
      visibleItems: [story],
      childWorkItems,
      bugsForWorkItemId: null,
    });

    expect(childBugProgressByWorkItemId[1]).toEqual({ closed: 2, total: 3 });
  });

  it('resolves related bugs for the selected story by type', () => {
    const story = makeWorkItem({
      id: 1,
      type: 'User Story',
      childIds: [10, 11],
    });
    const childWorkItems = [
      makeWorkItem({ id: 10, type: 'Bug', state: 'Active' }),
      makeWorkItem({ id: 11, type: 'Task', state: 'Active' }),
    ];

    const { bugsForWorkItem, relatedBugs } = buildAzureBoardRelationshipModel({
      visibleItems: [story],
      childWorkItems,
      bugsForWorkItemId: 1,
    });

    expect(bugsForWorkItem?.id).toBe(1);
    expect(relatedBugs.map((item) => item.id)).toEqual([10]);
  });
});
