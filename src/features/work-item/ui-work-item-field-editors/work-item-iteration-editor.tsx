import { ChevronDown, Loader2 } from 'lucide-react';
import { useCallback, useRef } from 'react';
import clsx from 'clsx';

import { Dropdown, DropdownItem } from '@/common/ui/dropdown';
import { useUpdateWorkItemField } from '@/hooks/use-work-items';

/**
 * Borderless iteration picker with two-line option rows (name over full path)
 * and a "Current" accent. Renders even when the work item has no iteration
 * (decision 30) — the trigger then reads "No iteration".
 */
export function WorkItemIterationEditor({
  iterationPath,
  options,
  disabled,
  providerId,
  workItemId,
}: {
  iterationPath?: string;
  options: Array<{ name: string; path: string; isCurrent: boolean }>;
  disabled: boolean;
  providerId: string;
  workItemId: number;
}) {
  const updateField = useUpdateWorkItemField();
  const dropdownRef = useRef<{ toggle: () => void } | null>(null);
  const currentPath = iterationPath ?? '';
  const currentName = currentPath
    ? (options.find((option) => option.path === currentPath)?.name ??
      // Both separators: every other path consumer in the app splits on
      // /[\\/]/, and Azure returns forward slashes on some configurations.
      currentPath.split(/[\\/]/).at(-1) ??
      'Unknown')
    : 'No iteration';

  const handleSelect = useCallback(
    (nextPath: string) => {
      dropdownRef.current?.toggle();
      if (nextPath === currentPath) return;
      updateField.mutate({
        providerId,
        workItemId,
        field: 'System.IterationPath',
        value: nextPath,
      });
    },
    [currentPath, providerId, updateField, workItemId],
  );

  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className="text-ink-3">Iteration:</span>
      <Dropdown
        dropdownRef={dropdownRef}
        className="min-w-52"
        trigger={
          <button
            type="button"
            disabled={disabled || updateField.isPending || options.length === 0}
            className="text-ink-1 hover:text-acc-ink flex min-w-0 max-w-56 items-center gap-1 rounded px-1 py-0.5 transition-colors disabled:cursor-default disabled:opacity-60"
            aria-label={`Edit iteration. Current iteration: ${currentName}`}
          >
            <span className="truncate">{currentName}</span>
            {updateField.isPending ? (
              <Loader2 className="text-ink-3 h-3 w-3 shrink-0 animate-spin" />
            ) : (
              <ChevronDown className="text-ink-3 h-3 w-3 shrink-0" />
            )}
          </button>
        }
      >
        {options.map((option) => (
          <DropdownItem
            key={option.path}
            checked={option.path === currentPath}
            onClick={() => handleSelect(option.path)}
          >
            <span
              className={clsx(
                'flex min-w-0 flex-col',
                option.isCurrent && 'text-acc-ink',
              )}
            >
              <span>{option.name}</span>
              {option.name !== option.path && (
                <span className="text-ink-3 truncate text-xs">{option.path}</span>
              )}
              {option.isCurrent && (
                <span className="text-acc-ink/70 text-[10px]">Current</span>
              )}
            </span>
          </DropdownItem>
        ))}
      </Dropdown>
    </div>
  );
}
