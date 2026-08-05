import { normalizeOwnerName } from '@/features/work-item/utils-owner-color';

/**
 * Builds the owner dropdown options for display-name based assignee lists
 * (board/preview). Order: Unassigned, signed-in user, current assignee, rest.
 */
export function getAssigneeDropdownOptions({
  currentUserName,
  assignedTo,
  assigneeOptions,
}: {
  currentUserName?: string | null;
  assignedTo?: string | null;
  assigneeOptions: string[];
}): string[] {
  const pinned = [currentUserName?.trim(), assignedTo?.trim()].filter(
    (name): name is string => !!name,
  );
  const seen = new Set<string>();
  const uniquePinned = pinned.filter((name) => {
    const key = normalizeOwnerName(name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [
    '',
    ...uniquePinned,
    ...assigneeOptions.filter(
      (assignee) => !seen.has(normalizeOwnerName(assignee)),
    ),
  ];
}
