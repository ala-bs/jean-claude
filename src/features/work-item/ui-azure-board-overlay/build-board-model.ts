import type { AzureDevOpsIteration, AzureDevOpsWorkItem } from '@/lib/api';
import {
  getLinkedBugCandidateIds,
  isAzureBacklogItemType,
  isWorkItemClosedState,
  matchesAnyAzureWorkItemAssignee,
  matchesAnyAzureWorkItemTag,
  parseAzureWorkItemTags,
} from '@/features/work-item/ui-work-item-board/utils';
import type { AzureBoardFilters } from '@/stores/azure-board';
import { normalizeOwnerName } from '@/features/work-item/utils-owner-color';

type BaseModelParams = {
  metadataItems: AzureDevOpsWorkItem[];
  items: AzureDevOpsWorkItem[];
  iterations: AzureDevOpsIteration[];
  filters: AzureBoardFilters;
};

export function resolveAzureBoardIterationPaths({
  iterations,
  selectedIterations,
}: {
  iterations: AzureDevOpsIteration[];
  selectedIterations: string[];
}) {
  const currentIteration = iterations.find((iteration) => iteration.isCurrent);
  return [
    ...new Set(
      selectedIterations
        .map((iteration) =>
          iteration === '__current__' ? currentIteration?.path : iteration,
        )
        .filter((iteration): iteration is string => !!iteration),
    ),
  ];
}

export function resolveAzureBoardIterationFilter({
  iterations,
  selectedIterations,
  iterationsStatus,
}: {
  iterations: AzureDevOpsIteration[];
  selectedIterations: string[];
  iterationsStatus: 'pending' | 'error' | 'success';
}):
  | { status: 'pending' | 'error' | 'no-match'; paths: [] }
  | { status: 'partial'; paths: string[] }
  | { status: 'resolved'; paths: string[] } {
  const includesCurrent = selectedIterations.includes('__current__');
  const explicitPaths = selectedIterations.filter(
    (iteration) => iteration !== '__current__',
  );

  if (!includesCurrent) {
    return {
      status: 'resolved',
      paths: [...new Set(explicitPaths)],
    };
  }
  if (iterationsStatus === 'error') {
    return explicitPaths.length > 0
      ? { status: 'partial', paths: [...new Set(explicitPaths)] }
      : { status: 'error', paths: [] };
  }
  if (explicitPaths.length > 0 && iterationsStatus === 'pending') {
    return { status: 'partial', paths: [...new Set(explicitPaths)] };
  }
  if (explicitPaths.length > 0) {
    return {
      status: 'resolved',
      paths: resolveAzureBoardIterationPaths({ iterations, selectedIterations }),
    };
  }
  if (iterationsStatus === 'pending') return { status: 'pending', paths: [] };

  const currentIteration = iterations.find((iteration) => iteration.isCurrent);
  if (!currentIteration) {
    return { status: 'no-match', paths: [] };
  }
  return { status: 'resolved', paths: [currentIteration.path] };
}

export function buildAzureBoardBaseModel({
  metadataItems,
  items,
  iterations,
  filters,
}: BaseModelParams) {
  const currentIteration = iterations.find((iteration) => iteration.isCurrent);
  const resolvedIterationPaths = resolveAzureBoardIterationPaths({
    iterations,
    selectedIterations: filters.iterations,
  });

  const types = [
    ...new Set(metadataItems.map((item) => item.fields.workItemType)),
  ].sort();
  for (const persistedType of filters.workItemTypes) {
    if (
      !types.some(
        (type) =>
          type.toLocaleLowerCase() === persistedType.toLocaleLowerCase(),
      )
    ) {
      types.push(persistedType);
    }
  }
  types.sort((a, b) => a.localeCompare(b));

  const assigneesByKey = new Map<string, string>();
  for (const assignee of metadataItems
    .map((item) => item.fields.assignedTo?.trim())
    .filter((value): value is string => !!value)) {
    const key = normalizeOwnerName(assignee);
    if (!assigneesByKey.has(key)) assigneesByKey.set(key, assignee);
  }
  for (const persistedAssignee of filters.assignees) {
    const key = normalizeOwnerName(persistedAssignee);
    if (!assigneesByKey.has(key)) assigneesByKey.set(key, persistedAssignee);
  }
  const assignees = [...assigneesByKey.values()].sort((a, b) =>
    a.localeCompare(b),
  );

  const tagsByKey = new Map<string, string>();
  for (const item of metadataItems) {
    for (const tag of parseAzureWorkItemTags(item.fields.tags)) {
      const key = tag.toLocaleLowerCase();
      if (!tagsByKey.has(key)) tagsByKey.set(key, tag);
    }
  }
  for (const persistedTag of filters.tags) {
    const key = persistedTag.toLocaleLowerCase();
    if (!tagsByKey.has(key)) tagsByKey.set(key, persistedTag);
  }
  const tagOptions = [...tagsByKey.values()].sort((a, b) =>
    a.localeCompare(b),
  );

  const visibleItems = items.filter(
    (item) =>
      matchesAnyAzureWorkItemAssignee(
        item.fields.assignedTo,
        filters.assignees,
      ) && matchesAnyAzureWorkItemTag(item.fields.tags, filters.tags),
  );
  const stories = visibleItems.filter(
    (item) => isAzureBacklogItemType(item.fields.workItemType),
  );
  const storyLinkedWorkItemIds = [
    ...new Set(stories.flatMap(getLinkedBugCandidateIds)),
  ];
  const knownIterationPaths = new Set(
    iterations.map((iteration) => iteration.path.toLocaleLowerCase()),
  );
  const missingSelectedIterations = filters.iterations
    .filter(
      (iteration) =>
        iteration !== '__current__' &&
        !knownIterationPaths.has(iteration.toLocaleLowerCase()),
    )
    .map((iteration) => ({
      value: iteration,
      label: iteration.split(/[\\/]/).at(-1) || iteration,
    }));
  const iterationOptions = [
    ...(currentIteration
      ? [
          {
            value: '__current__',
            label: currentIteration.name,
            badge: 'Current',
          },
        ]
      : filters.iterations.includes('__current__')
        ? [
            {
              value: '__current__',
              label: 'Current iteration',
              badge: 'Current',
            },
          ]
        : []),
    ...[...iterations]
      .filter((iteration) => !iteration.isCurrent)
      .reverse()
      .map((iteration) => ({ value: iteration.path, label: iteration.name })),
    ...missingSelectedIterations,
  ];

  return {
    visibleItems,
    types,
    assignees,
    tagOptions,
    iterationOptions,
    resolvedIterationPaths,
    storyLinkedWorkItemIds,
  };
}

export function buildAzureBoardRelationshipModel({
  visibleItems,
  childWorkItems,
  bugsForWorkItemId,
}: {
  visibleItems: AzureDevOpsWorkItem[];
  childWorkItems: AzureDevOpsWorkItem[];
  bugsForWorkItemId: number | null;
}) {
  const childById = new Map(childWorkItems.map((item) => [item.id, item]));
  const childBugProgressByWorkItemId: Record<
    number,
    { closed: number; total: number }
  > = {};

  for (const story of visibleItems) {
    if (!isAzureBacklogItemType(story.fields.workItemType)) continue;
    const bugs = getLinkedBugCandidateIds(story)
      .map((id) => childById.get(id))
      .filter(
        (item): item is AzureDevOpsWorkItem =>
          item?.fields.workItemType.toLocaleLowerCase() === 'bug',
      );
    if (bugs.length > 0) {
      childBugProgressByWorkItemId[story.id] = {
        closed: bugs.filter((bug) => isWorkItemClosedState(bug.fields.state))
          .length,
        total: bugs.length,
      };
    }
  }

  const selectedWorkItem =
    visibleItems.find((item) => item.id === bugsForWorkItemId) ?? null;
  const bugsForWorkItem =
    selectedWorkItem && isAzureBacklogItemType(selectedWorkItem.fields.workItemType)
      ? selectedWorkItem
      : null;
  const relatedIds = new Set(
    bugsForWorkItem ? getLinkedBugCandidateIds(bugsForWorkItem) : [],
  );
  // Preserve Azure child-batch response order used before model extraction.
  const relatedBugs = childWorkItems.filter(
    (item) =>
      relatedIds.has(item.id) &&
      item.fields.workItemType.toLocaleLowerCase() === 'bug',
  );

  return { childBugProgressByWorkItemId, bugsForWorkItem, relatedBugs };
}
