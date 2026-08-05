import { describe, expect, it } from 'vitest';

import { getAssigneeDropdownOptions } from '@/lib/work-item-assignee-options';

describe('getAssigneeDropdownOptions', () => {
  it('pins the signed-in user, then the assignee, then the rest', () => {
    expect(
      getAssigneeDropdownOptions({
        currentUserName: 'Me',
        assignedTo: 'Zoe',
        assigneeOptions: ['Alice', 'Me', 'Zoe'],
      }),
    ).toEqual(['', 'Me', 'Zoe', 'Alice']);
  });

  it('does not duplicate when the signed-in user is the assignee', () => {
    expect(
      getAssigneeDropdownOptions({
        currentUserName: 'Me',
        assignedTo: ' me ',
        assigneeOptions: ['Me', 'Alice'],
      }),
    ).toEqual(['', 'Me', 'Alice']);
  });

  it('handles a missing current user and unassigned item', () => {
    expect(
      getAssigneeDropdownOptions({
        currentUserName: null,
        assignedTo: null,
        assigneeOptions: ['Alice'],
      }),
    ).toEqual(['', 'Alice']);
  });
});
