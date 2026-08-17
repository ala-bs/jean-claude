import { ChevronDown, Loader2 } from 'lucide-react';
import { useRef, useState } from 'react';

import type { AzureDevOpsBoardColumn, AzureDevOpsWorkItem } from '@/lib/api';
import { Dropdown, DropdownItem } from '@/common/ui/dropdown';
import { useUpdateWorkItemBoardColumn } from '@/hooks/use-work-items';

import { getEditableBoardColumns } from './utils';

export function WorkItemBoardColumnEditor({
  workItem,
  providerId,
  projectId,
  projectName,
  columns,
  variant = 'metadata',
}: {
  workItem: AzureDevOpsWorkItem;
  providerId: string;
  projectId: string;
  projectName: string;
  columns: AzureDevOpsBoardColumn[];
  variant?: 'metadata' | 'details';
}) {
  const dropdownRef = useRef<{ toggle: () => void } | null>(null);
  const currentColumn = workItem.fields.boardColumn ?? '';
  const [optimisticColumn, setOptimisticColumn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const updateColumn = useUpdateWorkItemBoardColumn();
  const displayColumn = optimisticColumn ?? currentColumn;
  const workItemType = workItem.fields.workItemType;
  const options = getEditableBoardColumns({
    columns,
    workItemType,
    currentColumn,
  });
  const hasEditableColumns = options.some(
    (column) => !!column.stateMappings[workItemType],
  );

  const select = async (column: AzureDevOpsBoardColumn) => {
    dropdownRef.current?.toggle();
    if (column.name === displayColumn) return;
    const state = column.stateMappings[workItemType];
    if (!state) return;
    if (!column.teamId || !column.boardId) {
      setError('Board metadata is unavailable');
      return;
    }

    setOptimisticColumn(column.name);
    setError(null);
    try {
      await updateColumn.mutateAsync({
        providerId,
        projectId,
        projectName,
        workItemId: workItem.id,
        column: column.name,
        teamId: column.teamId,
        boardId: column.boardId,
        state,
        isDone: false,
      });
      setOptimisticColumn(null);
    } catch (saveError) {
      setOptimisticColumn(null);
      setError(saveError instanceof Error ? saveError.message : 'Save failed');
    }
  };

  const triggerClassName = variant === 'metadata'
    ? 'border-glass-border bg-glass-light hover:bg-glass-medium focus:border-acc-line text-ink-1 flex h-8 min-w-0 items-center gap-2 rounded-md border px-3 text-xs transition-colors focus:outline-none disabled:cursor-default disabled:opacity-50'
    : 'border-glass-border bg-glass-light hover:bg-glass-medium text-ink-1 flex h-7 min-w-0 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors disabled:cursor-default disabled:opacity-50';

  return (
    <div className="relative min-w-0">
      <Dropdown
        dropdownRef={dropdownRef}
        className="min-w-48"
        trigger={
          <button
            type="button"
            disabled={updateColumn.isPending || !hasEditableColumns}
            className={triggerClassName}
            aria-label={`Edit board column, current value ${displayColumn || 'not assigned'}`}
          >
            <span className="text-ink-3">Column</span>
            <span className="max-w-32 truncate">
              {displayColumn || 'Not assigned'}
            </span>
            {updateColumn.isPending ? (
              <Loader2 className="text-ink-3 ml-auto h-3 w-3 animate-spin" />
            ) : (
              <ChevronDown className="text-ink-3 ml-auto h-3 w-3" />
            )}
          </button>
        }
      >
        {options.map((column) =>
          column.stateMappings[workItemType] ? (
            <DropdownItem
              key={column.id}
              checked={column.name === displayColumn}
              onClick={() => void select(column)}
            >
              {column.name}
            </DropdownItem>
          ) : (
            <div
              key={column.id}
              role="menuitem"
              aria-disabled="true"
              className="text-ink-3 flex w-full items-center px-3 py-1.5 text-sm"
            >
              <span className="flex-1">{column.name}</span>
              <span className="text-[10px]">Current</span>
            </div>
          ),
        )}
      </Dropdown>
      {error && (
        <span
          role="alert"
          className="text-status-fail absolute top-full left-0 z-10 mt-1 text-[10px]"
        >
          {error}
        </span>
      )}
    </div>
  );
}
