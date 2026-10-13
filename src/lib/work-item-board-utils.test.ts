import { describe, expect, it } from 'vitest';

import type { AzureDevOpsBoardColumn, AzureDevOpsWorkItem } from '@/lib/api';
import {
  calculateLinkedBugProgress,
  getLinkedBugCandidateIds,
  groupWorkItemsByBoardColumns,
  isAzureBacklogItemType,
  isAzureWorkItemOutOfSprint,
  matchesAnyAzureWorkItemAssignee,
  matchesAnyAzureWorkItemTag,
  normalizeAzureWorkItemTags,
  parseAzureWorkItemTags,
  pushWorkItemStack,
  serializeAzureWorkItemTags,
} from '@/features/work-item/ui-work-item-board/utils';

const columns: AzureDevOpsBoardColumn[] = [
  { id: 'new', name: 'New', stateMappings: { Bug: 'Proposed' } },
  { id: 'doing', name: 'Doing', stateMappings: { Bug: 'Active' } },
];
const item = (id: number, fields: Partial<AzureDevOpsWorkItem['fields']>) => ({
  id,
  url: '',
  fields: {
    'System.Title': 'Fix',
    'System.WorkItemType': 'Bug',
    'System.State': 'Active',
    ...fields,
  },
}) satisfies AzureDevOpsWorkItem;

describe('isAzureBacklogItemType', () => {
  it.each([
    'User Story',
    'user story',
    'Product Backlog Item',
    'PRODUCT BACKLOG ITEM',
    'Requirement',
    'requirement',
    'Issue',
    'issue',
  ])('recognizes %s as a backlog item type', (workItemType) => {
    expect(isAzureBacklogItemType(workItemType)).toBe(true);
  });

  it.each(['Bug', 'bug', 'Task', 'task'])('excludes %s', (workItemType) => {
    expect(isAzureBacklogItemType(workItemType)).toBe(false);
  });
});

describe('isAzureWorkItemOutOfSprint', () => {
  it('marks work items from another iteration', () => {
    expect(
      isAzureWorkItemOutOfSprint(
        item(1, { 'System.IterationPath': 'Project\\Sprint 4' }),
        'Project\\Sprint 5',
      ),
    ).toBe(true);
  });

  it('matches iteration paths case-insensitively and ignores missing paths', () => {
    expect(
      isAzureWorkItemOutOfSprint(
        item(1, { 'System.IterationPath': 'project\\sprint 5' }),
        'Project\\Sprint 5',
      ),
    ).toBe(false);
    expect(isAzureWorkItemOutOfSprint(item(1, {}), 'Project\\Sprint 5')).toBe(false);
    expect(isAzureWorkItemOutOfSprint(item(1, { 'System.IterationPath': 'Other' }), undefined)).toBe(false);
  });
});

describe('groupWorkItemsByBoardColumns', () => {
  it('prefers direct columns, uses type state mappings, and retains unmatched items', () => {
    const groups = groupWorkItemsByBoardColumns({
      boardColumns: columns,
      workItems: [
        item(1, { 'System.BoardColumn': 'New' }),
        item(2, {}),
        item(3, { 'System.State': 'Removed' }),
      ],
    });

    expect(groups.map((group) => [group.id, group.name, group.items.map((entry) => entry.id)])).toEqual([
      ['new', 'New', [1]],
      ['doing', 'Doing', [2]],
      ['state:Removed', 'Removed', [3]],
    ]);
  });
});

describe('parseAzureWorkItemTags', () => {
  it('parses semicolon-delimited tags and skips empty values', () => {
    expect(parseAzureWorkItemTags(' frontend ; urgent;; accessibility ')).toEqual([
      'frontend',
      'urgent',
      'accessibility',
    ]);
  });

  it('returns no tags for missing values', () => {
    expect(parseAzureWorkItemTags(undefined)).toEqual([]);
  });

  it('normalizes tags while preserving first-seen casing', () => {
    expect(normalizeAzureWorkItemTags([' Frontend ', 'frontend', '', 'Urgent'])).toEqual([
      'Frontend',
      'Urgent',
    ]);
  });

  it('serializes normalized tags for Azure', () => {
    expect(serializeAzureWorkItemTags([' Frontend ', 'frontend', 'Urgent'])).toBe(
      'Frontend; Urgent',
    );
    expect(serializeAzureWorkItemTags([])).toBe('');
  });

  it('matches any selected tag case-insensitively', () => {
    expect(matchesAnyAzureWorkItemTag('Frontend; Urgent', ['urgent'])).toBe(true);
    expect(matchesAnyAzureWorkItemTag('Frontend; Urgent', ['backend'])).toBe(false);
    expect(matchesAnyAzureWorkItemTag(undefined, [])).toBe(true);
  });
});

describe('matchesAnyAzureWorkItemAssignee', () => {
  it('matches any selected assignee case-insensitively', () => {
    expect(matchesAnyAzureWorkItemAssignee('Patrick Lin', ['someone', 'patrick lin'])).toBe(true);
    expect(matchesAnyAzureWorkItemAssignee('Patrick Lin', ['someone'])).toBe(false);
    expect(matchesAnyAzureWorkItemAssignee(undefined, [])).toBe(true);
  });
});

describe('calculateLinkedBugProgress', () => {
  it('counts related-only bugs', () => {
    expect(
      calculateLinkedBugProgress(
        { ...item(100, {}), relatedWorkItemIds: [1] },
        [item(1, { 'System.WorkItemType': 'Bug', 'System.State': 'Closed' })],
      ),
    ).toEqual({ closed: 1, total: 1 });
  });

  it('unions and deduplicates hierarchy and related IDs', () => {
    const story = {
      ...item(100, {}),
      childIds: [1, 2],
      relatedWorkItemIds: [2, 3],
    };
    expect(getLinkedBugCandidateIds(story)).toEqual([1, 2, 3]);
    expect(
      calculateLinkedBugProgress(story, [
        item(1, { 'System.WorkItemType': 'Bug', 'System.State': 'Closed' }),
        item(2, { 'System.WorkItemType': 'bug', 'System.State': 'closed' }),
        item(3, { 'System.WorkItemType': 'Task', 'System.State': 'Closed' }),
        item(99, { 'System.WorkItemType': 'Bug', 'System.State': 'Closed' }),
      ]),
    ).toEqual({ closed: 2, total: 2 });
  });

  it('excludes non-bug related items and incomplete bug states', () => {
    expect(
      calculateLinkedBugProgress(
        { ...item(100, {}), relatedWorkItemIds: [1, 2, 3] },
        [
          item(1, { 'System.WorkItemType': 'Task', 'System.State': 'Closed' }),
          item(2, { 'System.WorkItemType': 'Bug', 'System.State': 'Resolved' }),
          item(3, { 'System.WorkItemType': 'Bug', 'System.State': 'Done' }),
        ],
      ),
    ).toEqual({ closed: 1, total: 2 });
  });

  it('counts Azure Done bugs as closed', () => {
    const story = {
      ...item(1, {
        'System.WorkItemType': 'User Story',
        'System.Title': 'Story',
        'System.State': 'Active',
      }),
      childIds: [2],
    };
    const doneBug = item(2, {
      'System.WorkItemType': 'Bug',
      'System.Title': 'Bug',
      'System.State': 'Done',
    });

    expect(calculateLinkedBugProgress(story, [doneBug])).toEqual({ closed: 1, total: 1 });
  });
});

describe('pushWorkItemStack', () => {
  it('pushes new IDs without duplicating current top', () => {
    expect(pushWorkItemStack([1], 2)).toEqual([1, 2]);
    expect(pushWorkItemStack([1, 2], 2)).toEqual([1, 2]);
  });
});
