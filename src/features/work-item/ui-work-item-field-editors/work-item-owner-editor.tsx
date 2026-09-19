import { ChevronDown, Loader2 } from 'lucide-react';
import { useCallback, useRef } from 'react';

import { Dropdown, DropdownItem } from '@/common/ui/dropdown';
import { getOwnerColor, normalizeOwnerName } from '@/features/work-item/utils-owner-color';
import { UserAvatar } from '@/common/ui/user-avatar';
import { useUpdateWorkItemField } from '@/hooks/use-work-items';

/**
 * Builds the owner dropdown options: keyed by uniqueName (email) when
 * available, with an explicit "Unassigned" entry first, then "me" and the
 * current owner pinned, then everyone else alphabetically.
 */
export function getOwnerOptions(
  owners: Array<{ displayName: string; value: string }>,
  currentOwner?: string,
  currentOwnerValue?: string,
  currentUser?: { displayName?: string | null; uniqueName?: string | null },
): Array<{ displayName: string; value: string }> {
  const ownersByKey = new Map<string, { displayName: string; value: string }>();
  const currentValue = currentOwnerValue?.trim() || currentOwner?.trim();
  if (currentOwner?.trim() && currentValue) {
    ownersByKey.set(normalizeOwnerName(currentValue), {
      displayName: currentOwner.trim(),
      value: currentValue,
    });
  }
  for (const owner of owners) {
    const displayName = owner.displayName.trim();
    const value = owner.value.trim();
    if (!displayName || !value) continue;
    const normalized = normalizeOwnerName(value);
    if (!ownersByKey.has(normalized)) {
      ownersByKey.set(normalized, { displayName, value });
    }
  }
  const currentKey = currentValue ? normalizeOwnerName(currentValue) : null;
  const meName = currentUser?.displayName?.trim() || '';
  const meValue = currentUser?.uniqueName?.trim() || meName;
  // Owners are keyed by unique name (email) when available, display name otherwise,
  // so also match on display name to avoid listing the same person twice.
  const meNameKey = meName ? normalizeOwnerName(meName) : null;
  let meKey = meValue ? normalizeOwnerName(meValue) : null;
  if (meKey && !ownersByKey.has(meKey) && meNameKey) {
    const byName = [...ownersByKey.entries()].find(
      ([, owner]) => normalizeOwnerName(owner.displayName) === meNameKey,
    );
    if (byName) meKey = byName[0];
  }
  if (meKey && !ownersByKey.has(meKey)) {
    ownersByKey.set(meKey, { displayName: meName || meValue, value: meValue });
  }
  let me = meKey ? ownersByKey.get(meKey) : undefined;
  let current =
    currentKey && currentKey !== meKey ? ownersByKey.get(currentKey) : undefined;
  // Same person reached through both value spaces (email vs display name):
  // keep a single entry, preferring the one the work item is actually set to
  // so the dropdown still shows it as selected.
  if (
    me &&
    current &&
    normalizeOwnerName(current.displayName) === normalizeOwnerName(me.displayName)
  ) {
    me = current;
    current = undefined;
  }
  const pinnedKeys = new Set([meKey, currentKey].filter(Boolean) as string[]);
  const ownersList = [...ownersByKey.entries()]
    .filter(([key]) => !pinnedKeys.has(key))
    .map(([, owner]) => owner);
  ownersList.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return [
    { displayName: 'Unassigned', value: '' },
    ...(me ? [me] : []),
    ...(current ? [current] : []),
    ...ownersList,
  ];
}

/**
 * Borderless owner picker shared by the feed detail modal and the work item
 * preview. Options are injected (both surfaces fetch owners differently); the
 * save mutation lives inside because both surfaces save identically.
 */
export function WorkItemOwnerEditor({
  owner,
  ownerValue,
  options,
  disabled,
  error,
  onRetry,
  providerId,
  workItemId,
}: {
  owner?: string;
  ownerValue?: string;
  options: Array<{ displayName: string; value: string }>;
  disabled: boolean;
  error: string | null;
  onRetry: () => void;
  providerId: string;
  workItemId: number;
}) {
  const updateField = useUpdateWorkItemField();
  const dropdownRef = useRef<{ toggle: () => void } | null>(null);
  const currentOwner = owner ?? '';
  const currentOwnerValue = ownerValue ?? currentOwner;

  const handleSelect = useCallback(
    (nextOwner: { displayName: string; value: string }) => {
      dropdownRef.current?.toggle();
      if (nextOwner.value === currentOwnerValue) return;
      updateField.mutate({
        providerId,
        workItemId,
        field: 'System.AssignedTo',
        value: nextOwner.value,
      });
    },
    [currentOwnerValue, providerId, updateField, workItemId],
  );

  return (
    <div className="flex items-center gap-1.5 text-xs">
      {/* No "Assigned to:" label — the avatar and name speak for themselves,
          and the trigger's aria-label still names the field. */}
      <Dropdown
        dropdownRef={dropdownRef}
        className="min-w-52"
        trigger={
          <button
            type="button"
            disabled={disabled || updateField.isPending || options.length <= 1}
            className="text-ink-1 hover:text-acc-ink flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 transition-colors disabled:cursor-default disabled:opacity-60"
            aria-label={`Edit owner. Current owner: ${currentOwner || 'Unassigned'}`}
          >
            {currentOwner && (
              <UserAvatar name={currentOwner} color={getOwnerColor(currentOwner)} />
            )}
            <span className="max-w-36 truncate">
              {currentOwner || 'Unassigned'}
            </span>
            {updateField.isPending ? (
              <Loader2 className="text-ink-3 h-3 w-3 animate-spin" />
            ) : (
              <ChevronDown className="text-ink-3 h-3 w-3" />
            )}
          </button>
        }
      >
        {options.map((option) => (
          <DropdownItem
            key={option.value || '__unassigned__'}
            checked={option.value === currentOwnerValue}
            onClick={() => handleSelect(option)}
          >
            <span className="flex items-center gap-2">
              {option.value && (
                <UserAvatar
                  name={option.displayName}
                  color={getOwnerColor(option.displayName)}
                />
              )}
              <span>{option.displayName}</span>
              {option.value && option.value !== option.displayName && (
                <span className="text-ink-3">{option.value}</span>
              )}
            </span>
          </DropdownItem>
        ))}
      </Dropdown>
      {error && (
        <button
          type="button"
          className="text-status-fail hover:underline"
          title={error}
          onClick={onRetry}
        >
          Retry owners
        </button>
      )}
    </div>
  );
}
