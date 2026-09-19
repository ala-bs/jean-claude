import { ChevronDown, Loader2 } from 'lucide-react';
import { useCallback, useRef } from 'react';
import clsx from 'clsx';

import { Dropdown, DropdownItem } from '@/common/ui/dropdown';
import { Chip } from '@/common/ui/chip';
import { useUpdateWorkItemState } from '@/hooks/use-work-items';

export function getStateColor(state: string): {
  color: 'neutral' | 'blue' | 'yellow' | 'green';
  ringClass: string;
} {
  if (state === 'Active') {
    return { color: 'blue', ringClass: 'ring-1 ring-acc/30' };
  } else if (state === 'New') {
    return { color: 'yellow', ringClass: 'ring-1 ring-status-run/30' };
  } else if (state === 'Resolved' || state === 'Done' || state === 'Closed') {
    return { color: 'green', ringClass: 'ring-1 ring-status-done/30' };
  }
  return { color: 'neutral', ringClass: '' };
}

export function WorkItemStateBadge({ state }: { state: string }) {
  const { color, ringClass } = getStateColor(state);
  return (
    <Chip size="sm" color={color} className={ringClass}>
      {state}
    </Chip>
  );
}

/**
 * Borderless coloured state chip. Saves through the optimistic
 * `useUpdateWorkItemState` mutation (hook lives inside: both surfaces save the
 * same way). Without a `providerId` it degrades to the read-only badge.
 */
export function WorkItemStateEditor({
  state,
  states: availableStates,
  providerId,
  workItemId,
}: {
  state: string;
  states: string[];
  providerId?: string;
  workItemId: number;
}) {
  const updateState = useUpdateWorkItemState();
  const { color, ringClass } = getStateColor(state);
  const dropdownRef = useRef<{ toggle: () => void } | null>(null);
  const states = availableStates.includes(state)
    ? availableStates
    : [state, ...availableStates];

  const handleSelect = useCallback(
    (s: string) => {
      dropdownRef.current?.toggle();
      if (!providerId) return;
      if (s !== state) {
        updateState.mutate({ providerId, workItemId, state: s });
      }
    },
    [state, providerId, workItemId, updateState],
  );

  if (!providerId) return <WorkItemStateBadge state={state} />;

  return (
    <Dropdown
      dropdownRef={dropdownRef}
      trigger={
        <button type="button" className="flex cursor-pointer items-center gap-1">
          <Chip
            size="sm"
            color={color}
            className={clsx(
              ringClass,
              '[&>span]:flex [&>span]:items-center [&>span]:gap-1',
            )}
            icon={
              updateState.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : undefined
            }
          >
            {state}
            <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
          </Chip>
        </button>
      }
    >
      {states.map((s) => (
        <DropdownItem key={s} onClick={() => handleSelect(s)} checked={s === state}>
          {s}
        </DropdownItem>
      ))}
    </Dropdown>
  );
}
