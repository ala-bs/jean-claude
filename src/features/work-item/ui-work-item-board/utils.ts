import type { AzureDevOpsBoardColumn, AzureDevOpsWorkItem } from '@/lib/api';
import { normalizeOwnerName } from '@/features/work-item/utils-owner-color';

const AZURE_BACKLOG_ITEM_TYPES = new Set([
  'user story',
  'product backlog item',
  'requirement',
  'issue',
]);

export function isAzureBacklogItemType(workItemType: string) {
  return AZURE_BACKLOG_ITEM_TYPES.has(workItemType.trim().toLocaleLowerCase());
}

export function parseAzureWorkItemTags(tags: string | undefined) {
  if (!tags) return [];
  return tags
    .split(';')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function normalizeAzureWorkItemTags(tags: string[]) {
  const normalizedTags = new Map<string, string>();
  for (const value of tags) {
    const tag = value.trim();
    const key = tag.toLocaleLowerCase();
    if (tag && !normalizedTags.has(key)) normalizedTags.set(key, tag);
  }
  return [...normalizedTags.values()];
}

export function serializeAzureWorkItemTags(tags: string[]) {
  return normalizeAzureWorkItemTags(tags).join('; ');
}

export function matchesAnyAzureWorkItemTag(
  tags: string | undefined,
  selectedTags: string[],
) {
  if (selectedTags.length === 0) return true;
  const itemTags = new Set(
    parseAzureWorkItemTags(tags).map((tag) => tag.toLocaleLowerCase()),
  );
  return selectedTags.some((tag) => itemTags.has(tag.trim().toLocaleLowerCase()));
}

export function matchesAnyAzureWorkItemAssignee(
  assignee: string | undefined,
  selectedAssignees: string[],
) {
  if (selectedAssignees.length === 0) return true;
  const normalized = assignee ? normalizeOwnerName(assignee) : '';
  return !!normalized && selectedAssignees.some(
    (selected) => normalizeOwnerName(selected) === normalized,
  );
}

export function getLinkedBugCandidateIds(workItem: AzureDevOpsWorkItem) {
  return [
    ...new Set([
      ...(workItem.childIds ?? []),
      ...(workItem.relatedWorkItemIds ?? []),
    ]),
  ];
}

export function calculateLinkedBugProgress(
  workItem: AzureDevOpsWorkItem,
  workItems: AzureDevOpsWorkItem[],
) {
  const candidateIds = getLinkedBugCandidateIds(workItem);
  if (candidateIds.length === 0) return null;
  const candidateIdSet = new Set(candidateIds);
  const bugs = workItems.filter(
    (item) =>
      candidateIdSet.has(item.id) &&
      item.fields.workItemType.toLocaleLowerCase() === 'bug',
  );
  if (bugs.length === 0) return null;
  return {
    closed: bugs.filter((item) => isWorkItemClosedState(item.fields.state)).length,
    total: bugs.length,
  };
}

export function isWorkItemClosedState(state: string) {
  const normalized = state.trim().toLocaleLowerCase();
  return normalized === 'closed' || normalized === 'done';
}

export function pushWorkItemStack(stack: number[], workItemId: number) {
  return stack.at(-1) === workItemId ? stack : [...stack, workItemId];
}

const STATUS_WORKFLOW_ORDER: Record<string, number> = {
  New: 1,
  'To Do': 1.5,
  Active: 2,
  'In Progress': 2.5,
  'In Design': 2.5,
  'Non-Compliant': 2.9,
  Resolved: 3,
  Deployed: 3.5,
  Closed: 4,
  Done: 4.5,
  Removed: 5,
};

function getStatusWorkflowOrder(status: string): number {
  return STATUS_WORKFLOW_ORDER[status] ?? 3;
}

export function groupWorkItemsByBoardColumns({
  workItems,
  boardColumns,
}: {
  workItems: AzureDevOpsWorkItem[];
  boardColumns: AzureDevOpsBoardColumn[];
}) {
  if (boardColumns.length === 0) {
    const groups = new Map<string, AzureDevOpsWorkItem[]>();
    for (const item of workItems) {
      const group = groups.get(item.fields.state) ?? [];
      group.push(item);
      groups.set(item.fields.state, group);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => getStatusWorkflowOrder(a) - getStatusWorkflowOrder(b))
      .map(([state, items]) => ({ id: `state:${state}`, name: state, items }));
  }

  const groups = new Map(
    boardColumns.map((column) => [column.id, [] as AzureDevOpsWorkItem[]]),
  );
  const unmatched = new Map<string, AzureDevOpsWorkItem[]>();
  for (const item of workItems) {
    const column =
      boardColumns.find((candidate) => candidate.name === item.fields.boardColumn) ??
      boardColumns.find(
        (candidate) =>
          candidate.stateMappings[item.fields.workItemType] === item.fields.state,
      );
    if (column) {
      groups.get(column.id)?.push(item);
    } else {
      const fallback = unmatched.get(item.fields.state) ?? [];
      fallback.push(item);
      unmatched.set(item.fields.state, fallback);
    }
  }

  return [
    ...boardColumns.map((column) => ({
      id: column.id,
      name: column.name,
      items: groups.get(column.id) ?? [],
    })),
    ...[...unmatched.entries()]
      .sort(([a], [b]) => getStatusWorkflowOrder(a) - getStatusWorkflowOrder(b))
      .map(([state, items]) => ({ id: `state:${state}`, name: state, items })),
  ];
}
