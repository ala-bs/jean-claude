import type { AzureDevOpsIteration, AzureDevOpsWorkItem } from '@/lib/api';
import {
  buildAzureBoardBaseModel,
  buildAzureBoardRelationshipModel,
  resolveAzureBoardIterationFilter,
} from '@/features/work-item/ui-azure-board-overlay/build-board-model';
import { describe, expect, it } from 'vitest';

import type { AzureBoardFilters } from '@/stores/azure-board';

const item = (
  id: number,
  fields: Partial<AzureDevOpsWorkItem['fields']> = {},
  links: Pick<AzureDevOpsWorkItem, 'childIds' | 'relatedWorkItemIds'> = {},
) =>
  ({
    id,
    url: '',
    fields: {
      title: `Item ${id}`,
      workItemType: 'User Story',
      state: 'Active',
      ...fields,
    },
    ...links,
  }) satisfies AzureDevOpsWorkItem;

const filters = (values: Partial<AzureBoardFilters> = {}): AzureBoardFilters => ({
  search: '',
  workItemTypes: [],
  assignees: [],
  iterations: [],
  tags: [],
  ...values,
});

const iterations: AzureDevOpsIteration[] = [
  {
    id: 'old',
    name: 'Sprint 1',
    path: 'Team\\Sprint 1',
    startDate: null,
    finishDate: null,
    isCurrent: false,
  },
  {
    id: 'current',
    name: 'Sprint 2',
    path: 'Team\\Sprint 2',
    startDate: null,
    finishDate: null,
    isCurrent: true,
  },
  {
    id: 'next',
    name: 'Sprint 3',
    path: 'Team\\Sprint 3',
    startDate: null,
    finishDate: null,
    isCurrent: false,
  },
];

describe('buildAzureBoardModel', () => {
  it('keeps persisted options and deduplicates assignees and tags case-insensitively', () => {
    const model = buildAzureBoardBaseModel({
      metadataItems: [
        item(1, {
          workItemType: 'Bug',
          assignedTo: 'Patrick Lin',
          tags: 'Frontend; Urgent',
        }),
        item(2, {
          workItemType: 'Task',
          assignedTo: 'patrick lin',
          tags: 'frontend; Backend',
        }),
      ],
      items: [],
      iterations: [],
      filters: filters({
        workItemTypes: ['Feature'],
        assignees: ['PATRICK LIN', 'Ada Lovelace'],
        tags: ['FRONTEND', 'Selected only'],
      }),
    });

    expect(model.types).toEqual(['Bug', 'Feature', 'Task']);
    expect(model.assignees).toEqual(['Ada Lovelace', 'Patrick Lin']);
    expect(model.tagOptions).toEqual([
      'Backend',
      'Frontend',
      'Selected only',
      'Urgent',
    ]);
  });

  it('filters visible items by any selected assignee and tag', () => {
    const model = buildAzureBoardBaseModel({
      metadataItems: [],
      items: [
        item(1, { assignedTo: 'Patrick Lin', tags: 'Frontend; Urgent' }),
        item(2, { assignedTo: 'Ada Lovelace', tags: 'Frontend' }),
        item(3, { assignedTo: 'Patrick Lin', tags: 'Backend' }),
      ],
      iterations: [],
      filters: filters({ assignees: ['patrick lin'], tags: ['URGENT'] }),
    });

    expect(model.visibleItems.map(({ id }) => id)).toEqual([1]);
  });

  it('places current iteration first and resolves its query path', () => {
    const model = buildAzureBoardBaseModel({
      metadataItems: [],
      items: [],
      iterations,
      filters: filters({ iterations: ['__current__', 'Team\\Sprint 1'] }),
    });

    expect(model.iterationOptions).toEqual([
      { value: '__current__', label: 'Sprint 2', badge: 'Current' },
      { value: 'Team\\Sprint 3', label: 'Sprint 3' },
      { value: 'Team\\Sprint 1', label: 'Sprint 1' },
    ]);
    expect(model.resolvedIterationPaths).toEqual([
      'Team\\Sprint 2',
      'Team\\Sprint 1',
    ]);
  });

  it('keeps a persisted current option when Azure reports no current iteration', () => {
    const model = buildAzureBoardBaseModel({
      metadataItems: [],
      items: [],
      iterations: iterations.filter((iteration) => !iteration.isCurrent),
      filters: filters({ iterations: ['__current__'] }),
    });

    expect(model.iterationOptions[0]).toEqual({
      value: '__current__',
      label: 'Current iteration',
      badge: 'Current',
    });
    expect(model.resolvedIterationPaths).toEqual([]);
  });

  it('keeps current iteration resolution pending until iterations load', () => {
    expect(
      resolveAzureBoardIterationFilter({
        iterations: [],
        selectedIterations: ['__current__'],
        iterationsStatus: 'pending',
      }),
    ).toEqual({ status: 'pending', paths: [] });
  });

  it('matches no items when Azure reports no current iteration', () => {
    expect(
      resolveAzureBoardIterationFilter({
        iterations: iterations.filter((iteration) => !iteration.isCurrent),
        selectedIterations: ['__current__'],
        iterationsStatus: 'success',
      }),
    ).toEqual({ status: 'no-match', paths: [] });
  });

  it('resolves current iteration after iterations load', () => {
    expect(
      resolveAzureBoardIterationFilter({
        iterations,
        selectedIterations: ['__current__', 'Team\\Sprint 1'],
        iterationsStatus: 'success',
      }),
    ).toEqual({
      status: 'resolved',
      paths: ['Team\\Sprint 2', 'Team\\Sprint 1'],
    });
  });

  it('preserves explicit iterations while current iteration is pending', () => {
    expect(
      resolveAzureBoardIterationFilter({
        iterations: [],
        selectedIterations: ['__current__', 'Team\\Sprint 1'],
        iterationsStatus: 'pending',
      }),
    ).toEqual({ status: 'partial', paths: ['Team\\Sprint 1'] });
  });

  it('preserves explicit iterations when no current iteration exists', () => {
    expect(
      resolveAzureBoardIterationFilter({
        iterations: iterations.filter((iteration) => !iteration.isCurrent),
        selectedIterations: ['__current__', 'Team\\Sprint 1'],
        iterationsStatus: 'success',
      }),
    ).toEqual({ status: 'resolved', paths: ['Team\\Sprint 1'] });
  });

  it('surfaces current iteration loading failure', () => {
    expect(
      resolveAzureBoardIterationFilter({
        iterations: [],
        selectedIterations: ['__current__'],
        iterationsStatus: 'error',
      }),
    ).toEqual({ status: 'error', paths: [] });
  });

  it('preserves explicit paths when explicit and current iteration loading fails', () => {
    expect(
      resolveAzureBoardIterationFilter({
        iterations: [],
        selectedIterations: ['__current__', 'Team\\Sprint 1'],
        iterationsStatus: 'error',
      }),
    ).toEqual({ status: 'partial', paths: ['Team\\Sprint 1'] });
  });

  it('keeps selected iteration paths missing from the Azure response', () => {
    const model = buildAzureBoardBaseModel({
      metadataItems: [],
      items: [],
      iterations,
      filters: filters({
        iterations: ['Archived\\Sprint 0', 'Standalone iteration'],
      }),
    });

    expect(model.iterationOptions.slice(-2)).toEqual([
      { value: 'Archived\\Sprint 0', label: 'Sprint 0' },
      { value: 'Standalone iteration', label: 'Standalone iteration' },
    ]);
  });

  it('deduplicates linked IDs, counts only linked bugs, and follows selected story', () => {
    const firstStory = item(100, {}, {
      childIds: [1, 2],
      relatedWorkItemIds: [2, 3],
    });
    const secondStory = item(200, {}, { relatedWorkItemIds: [4] });
    const childWorkItems = [
      item(3, { workItemType: 'Task', state: 'Closed' }),
      item(2, { workItemType: 'bug', state: 'Done' }),
      item(4, { workItemType: 'Bug', state: 'Closed' }),
      item(1, { workItemType: 'Bug', state: 'Active' }),
    ];
    const baseModel = buildAzureBoardBaseModel({
      metadataItems: [],
      items: [firstStory, secondStory],
      iterations: [],
      filters: filters(),
    });
    const relationshipModel = buildAzureBoardRelationshipModel({
      visibleItems: baseModel.visibleItems,
      childWorkItems,
      bugsForWorkItemId: 100,
    });

    expect(baseModel.storyLinkedWorkItemIds).toEqual([1, 2, 3, 4]);
    expect(relationshipModel.childBugProgressByWorkItemId).toEqual({
      100: { closed: 1, total: 2 },
      200: { closed: 1, total: 1 },
    });
    expect(relationshipModel.bugsForWorkItem).toBe(firstStory);
    expect(relationshipModel.relatedBugs.map(({ id }) => id)).toEqual([2, 1]);
  });

  it.each([
    'User Story',
    'Product Backlog Item',
    'Requirement',
    'Issue',
  ])('treats %s as a backlog parent for linked bugs and related panel data', (workItemType) => {
    const backlogItem = item(
      100,
      { workItemType: workItemType.toLocaleLowerCase() },
      { childIds: [1], relatedWorkItemIds: [2] },
    );
    const childWorkItems = [
      item(1, { workItemType: 'Bug', state: 'Active' }),
      item(2, { workItemType: 'Bug', state: 'Done' }),
    ];
    const baseModel = buildAzureBoardBaseModel({
      metadataItems: [],
      items: [backlogItem],
      iterations: [],
      filters: filters(),
    });
    const relationshipModel = buildAzureBoardRelationshipModel({
      visibleItems: baseModel.visibleItems,
      childWorkItems,
      bugsForWorkItemId: backlogItem.id,
    });

    expect(baseModel.storyLinkedWorkItemIds).toEqual([1, 2]);
    expect(relationshipModel.childBugProgressByWorkItemId).toEqual({
      100: { closed: 1, total: 2 },
    });
    expect(relationshipModel.bugsForWorkItem).toBe(backlogItem);
    expect(relationshipModel.relatedBugs.map(({ id }) => id)).toEqual([1, 2]);
  });

  it('ignores a selected story filtered out of visible items', () => {
    const relationshipModel = buildAzureBoardRelationshipModel({
      visibleItems: [item(200)],
      childWorkItems: [item(1, { workItemType: 'Bug' })],
      bugsForWorkItemId: 100,
    });

    expect(relationshipModel.bugsForWorkItem).toBeNull();
    expect(relationshipModel.relatedBugs).toEqual([]);
  });

  it.each(['Bug', 'Task'])('does not open related bug data for %s items', (workItemType) => {
    const nonBacklogItem = item(
      100,
      { workItemType },
      { relatedWorkItemIds: [1] },
    );
    const relationshipModel = buildAzureBoardRelationshipModel({
      visibleItems: [nonBacklogItem],
      childWorkItems: [item(1, { workItemType: 'Bug' })],
      bugsForWorkItemId: 100,
    });

    expect(relationshipModel.bugsForWorkItem).toBeNull();
    expect(relationshipModel.relatedBugs).toEqual([]);
  });

  it('calculates progress from an incomplete child batch', () => {
    const story = item(100, {}, { childIds: [1, 2, 3] });
    const relationshipModel = buildAzureBoardRelationshipModel({
      visibleItems: [story],
      childWorkItems: [item(2, { workItemType: 'Bug', state: 'Done' })],
      bugsForWorkItemId: 100,
    });

    expect(relationshipModel.childBugProgressByWorkItemId).toEqual({
      100: { closed: 1, total: 1 },
    });
    expect(relationshipModel.relatedBugs.map(({ id }) => id)).toEqual([2]);
  });
});
