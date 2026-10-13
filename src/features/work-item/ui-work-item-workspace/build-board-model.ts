import type { AzureDevOpsIteration, AzureDevOpsWorkItem } from '@/lib/api';
import {
  getAssignee,
  getState,
  getTags,
  getWorkItemType,
} from '@shared/work-item-field-types';
import {
  getLinkedBugCandidateIds,
  isAzureBacklogItemType,
  isWorkItemClosedState,
  matchesAnyAzureWorkItemAssignee,
} from '@/features/work-item/ui-work-item-board/utils';
import type { AzureBoardFilters } from '@/stores/azure-board';
import { normalizeOwnerName } from '@/features/work-item/utils-owner-color';

/**
 * Exact tag membership: the item must carry the selected tag as a whole tag,
 * compared case-insensitively after trimming. `backend` does not match an item
 * tagged only `backend-infra`.
 */
function matchesAnySelectedTag(
  item: AzureDevOpsWorkItem,
  selectedTags: string[],
) {
  if (selectedTags.length === 0) return true;
  const itemTags = new Set(
    getTags(item).map((tag) => tag.toLocaleLowerCase()),
  );
  return selectedTags.some((tag) =>
    itemTags.has(tag.trim().toLocaleLowerCase()),
  );
}

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
    // No current iteration exists, so "Current" cannot narrow anything. Fetch
    // unfiltered rather than rendering an empty board the user has no obvious
    // way out of; the `no-match` status still drives the explanatory banner.
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
    ...new Set(
      metadataItems.map((item) => getWorkItemType(item)).filter((type) => !!type),
    ),
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
    .map((item) => getAssignee(item)?.displayName.trim())
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
    for (const tag of getTags(item)) {
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
        getAssignee(item)?.displayName,
        filters.assignees,
      ) && matchesAnySelectedTag(item, filters.tags),
  );
  const stories = visibleItems.filter((item) =>
    isAzureBacklogItemType(getWorkItemType(item)),
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
    if (!isAzureBacklogItemType(getWorkItemType(story))) continue;
    const bugs = getLinkedBugCandidateIds(story)
      .map((id) => childById.get(id))
      .filter(
        (item): item is AzureDevOpsWorkItem =>
          !!item && getWorkItemType(item).toLocaleLowerCase() === 'bug',
      );
    if (bugs.length > 0) {
      childBugProgressByWorkItemId[story.id] = {
        closed: bugs.filter((bug) => isWorkItemClosedState(getState(bug)))
          .length,
        total: bugs.length,
      };
    }
  }

  const selectedWorkItem =
    visibleItems.find((item) => item.id === bugsForWorkItemId) ?? null;
  const bugsForWorkItem =
    selectedWorkItem && isAzureBacklogItemType(getWorkItemType(selectedWorkItem))
      ? selectedWorkItem
      : null;
  const relatedIds = new Set(
    bugsForWorkItem ? getLinkedBugCandidateIds(bugsForWorkItem) : [],
  );
  // Preserve Azure child-batch response order used before model extraction.
  const relatedBugs = childWorkItems.filter(
    (item) =>
      relatedIds.has(item.id) &&
      getWorkItemType(item).toLocaleLowerCase() === 'bug',
  );

  return { childBugProgressByWorkItemId, bugsForWorkItem, relatedBugs };
}
