import { describe, expect, it } from 'vitest';

import type { AzureDevOpsBoardColumn, AzureDevOpsWorkItem } from '@/lib/api';
import {
  calculateLinkedBugProgress,
  getLinkedBugCandidateIds,
  groupWorkItemsByBoardColumns,
  isAzureBacklogItemType,
  matchesAnyAzureWorkItemAssignee,
  matchesAnyAzureWorkItemTag,
  parseAzureWorkItemTags,
  pushWorkItemStack,
} from '@/features/work-item/ui-work-item-board/utils';

const columns: AzureDevOpsBoardColumn[] = [
  { id: 'new', name: 'New', stateMappings: { Bug: 'Proposed' } },
  { id: 'doing', name: 'Doing', stateMappings: { Bug: 'Active' } },
];
const item = (id: number, fields: Partial<AzureDevOpsWorkItem['fields']>) => ({
  id,
  url: '',
  fields: { title: 'Fix', workItemType: 'Bug', state: 'Active', ...fields },
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

describe('groupWorkItemsByBoardColumns', () => {
  it('prefers direct columns, uses type state mappings, and retains unmatched items', () => {
    const groups = groupWorkItemsByBoardColumns({
      boardColumns: columns,
      workItems: [
        item(1, { boardColumn: 'New' }),
        item(2, {}),
        item(3, { state: 'Removed' }),
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
        [item(1, { workItemType: 'Bug', state: 'Closed' })],
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
        item(1, { workItemType: 'Bug', state: 'Closed' }),
        item(2, { workItemType: 'bug', state: 'closed' }),
        item(3, { workItemType: 'Task', state: 'Closed' }),
        item(99, { workItemType: 'Bug', state: 'Closed' }),
      ]),
    ).toEqual({ closed: 2, total: 2 });
  });

  it('excludes non-bug related items and incomplete bug states', () => {
    expect(
      calculateLinkedBugProgress(
        { ...item(100, {}), relatedWorkItemIds: [1, 2, 3] },
        [
          item(1, { workItemType: 'Task', state: 'Closed' }),
          item(2, { workItemType: 'Bug', state: 'Resolved' }),
          item(3, { workItemType: 'Bug', state: 'Done' }),
        ],
      ),
    ).toEqual({ closed: 1, total: 2 });
  });

  it('counts Azure Done bugs as closed', () => {
    const story = {
      ...item(1, { workItemType: 'User Story', title: 'Story', state: 'Active' }),
      childIds: [2],
    };
    const doneBug = item(2, { workItemType: 'Bug', title: 'Bug', state: 'Done' });

    expect(calculateLinkedBugProgress(story, [doneBug])).toEqual({ closed: 1, total: 1 });
  });
});

describe('pushWorkItemStack', () => {
  it('pushes new IDs without duplicating current top', () => {
    expect(pushWorkItemStack([1], 2)).toEqual([1, 2]);
    expect(pushWorkItemStack([1, 2], 2)).toEqual([1, 2]);
  });
});
