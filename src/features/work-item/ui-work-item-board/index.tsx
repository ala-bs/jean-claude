import { ChevronLeft, ChevronRight } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import clsx from 'clsx';
import { getWorkItemSummaryExcerpt } from '@shared/work-item-summary';
import type { WorkItemTitleParserSetting } from '@shared/work-item-title-parser-types';


import type { AzureDevOpsBoardColumn, AzureDevOpsWorkItem } from '@/lib/api';
import {
  type BoardColorSettings,
  DEFAULT_BOARD_COLOR_SETTINGS,
  getBoardColumnApplyMode,
  getBoardColumnTone,
} from '@/features/work-item/utils-board-colors';
import { useCachedWorkItemSummaries } from '@/hooks/use-work-item-summary';
import { useCommands } from '@/common/hooks/use-commands';
import { useCurrentAzureUser } from '@/hooks/use-work-items';


import { groupWorkItemsByBoardColumns } from './utils';
import { WorkItemBoardCard } from './card-board-item';

const EMPTY_COLUMN_IDS: string[] = [];
const EMPTY_RELATED_BUG_IDS: number[] = [];
// Shared stable fallback so callers don't pass a fresh [] and defeat the memo.
export const EMPTY_BOARD_COLUMNS: AzureDevOpsBoardColumn[] = [];

// Column header color
function getColumnColor(status: string): string {
  switch (status.toLowerCase()) {
    case 'new':
    case 'to do':
      return 'border-glass-border-strong';
    case 'active':
    case 'in progress':
    case 'in design':
      return 'border-acc';
    case 'resolved':
    case 'done':
    case 'closed':
    case 'deployed':
      return 'border-status-done';
    case 'removed':
      return 'border-status-fail';
    default:
      return 'border-glass-border-strong';
  }
}

export const WorkItemBoard = memo(function WorkItemBoard({
  workItems,
  boardColumns,
  highlightedWorkItemId,
  exactMatchWorkItemId,
  selectedWorkItemIds,
  providerId,
  search,
  currentIterationPath,
  onToggleSelect,
  onHighlight,
  showSelection = true,
  onModifiedClick,
  collapsedColumnIds,
  onToggleColumn,
  childBugProgressByWorkItemId,
  onOpenChildBugs,
  relatedBugWorkItemIds = EMPTY_RELATED_BUG_IDS,
  variant = 'default',
  parserSetting = null,
  colorSettings = DEFAULT_BOARD_COLOR_SETTINGS,
}: {
  workItems: AzureDevOpsWorkItem[];
  boardColumns: AzureDevOpsBoardColumn[];
  highlightedWorkItemId: string | null;
  exactMatchWorkItemId?: string | null;
  selectedWorkItemIds: string[];
  providerId?: string;
  search: string;
  currentIterationPath?: string;
  onToggleSelect?: (workItem: AzureDevOpsWorkItem) => void;
  onHighlight: (workItem: AzureDevOpsWorkItem) => void;
  showSelection?: boolean;
  onModifiedClick?: (workItem: AzureDevOpsWorkItem) => void;
  collapsedColumnIds?: string[];
  onToggleColumn?: (columnId: string) => void;
  childBugProgressByWorkItemId?: Record<
    number,
    { closed: number; total: number }
  >;
  onOpenChildBugs?: (workItem: AzureDevOpsWorkItem) => void;
  relatedBugWorkItemIds?: number[];
  variant?: 'default' | 'editorial';
  parserSetting?: WorkItemTitleParserSetting | null;
  colorSettings?: BoardColorSettings;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const { data: currentUser } = useCurrentAzureUser(providerId ?? null);
  const workItemIds = useMemo(
    () => workItems.map((workItem) => workItem.id),
    [workItems],
  );
  const { data: cachedSummaries = [] } = useCachedWorkItemSummaries({
    providerId: providerId ?? null,
    workItemIds,
  });
  const summariesByWorkItemId = useMemo(
    () =>
      new Map(
        cachedSummaries.map((summary) => [summary.workItemId, summary] as const),
      ),
    [cachedSummaries],
  );

  // Group work items by Azure board column when available, then fall back to state.
  const columns = useMemo(
    () => groupWorkItemsByBoardColumns({ boardColumns, workItems }),
    [boardColumns, workItems],
  );
  const canCollapse = collapsedColumnIds !== undefined && !!onToggleColumn;
  const collapsedIds = canCollapse ? collapsedColumnIds : EMPTY_COLUMN_IDS;
  const isEditorial = variant === 'editorial';

  const visibleColumns = useMemo(() => {
    if (!search.trim()) return columns;
    return columns.filter((column) => column.items.length > 0);
  }, [columns, search]);
  const navigableColumns = useMemo(
    () => visibleColumns.filter((column) => !collapsedIds.includes(column.id)),
    [collapsedIds, visibleColumns],
  );

  // Board navigation: up/down within column, left/right across columns
  const navigate = useCallback(
    (direction: 'up' | 'down' | 'left' | 'right') => {
      if (navigableColumns.length === 0) return;

      // Find current position [col, row]
      let curCol = -1;
      let curRow = -1;
      if (highlightedWorkItemId) {
        for (let c = 0; c < navigableColumns.length; c++) {
          const r = navigableColumns[c].items.findIndex(
            (wi) => wi.id.toString() === highlightedWorkItemId,
          );
          if (r !== -1) {
            curCol = c;
            curRow = r;
            break;
          }
        }
      }

      // Find first/last non-empty column
      const firstCol = navigableColumns.findIndex((c) => c.items.length > 0);
      if (firstCol === -1) return; // all empty

      // No current highlight — start at first item
      if (curCol === -1) {
        onHighlight(navigableColumns[firstCol].items[0]);
        return;
      }

      const col = navigableColumns[curCol].items;

      if (direction === 'up') {
        onHighlight(col[(curRow - 1 + col.length) % col.length]);
      } else if (direction === 'down') {
        onHighlight(col[(curRow + 1) % col.length]);
      } else {
        // left or right — find next non-empty column
        const step = direction === 'left' ? -1 : 1;
        let nextCol = curCol + step;
        while (
          nextCol >= 0 &&
          nextCol < navigableColumns.length &&
          navigableColumns[nextCol].items.length === 0
        ) {
          nextCol += step;
        }
        if (nextCol < 0 || nextCol >= navigableColumns.length) return; // stay put
        onHighlight(
          navigableColumns[nextCol].items[
            Math.min(curRow, navigableColumns[nextCol].items.length - 1)
          ],
        );
      }
    },
    [navigableColumns, highlightedWorkItemId, onHighlight],
  );

  // Register keyboard bindings for board navigation
  useCommands('work-item-board-nav', [
    {
      label: 'Navigate Up',
      shortcut: 'up',
      handler: () => navigate('up'),
      hideInCommandPalette: true,
    },
    {
      label: 'Navigate Down',
      shortcut: 'down',
      handler: () => navigate('down'),
      hideInCommandPalette: true,
    },
    {
      label: 'Navigate Left',
      shortcut: 'left',
      handler: () => navigate('left'),
      hideInCommandPalette: true,
    },
    {
      label: 'Navigate Right',
      shortcut: 'right',
      handler: () => navigate('right'),
      hideInCommandPalette: true,
    },
  ]);

  // Exact ID searches can land in horizontally scrolled board columns.
  useEffect(() => {
    if (!exactMatchWorkItemId) return;
    const el = listRef.current?.querySelector(
      `[data-work-item-id="${exactMatchWorkItemId}"]`,
    );
    el?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [exactMatchWorkItemId, visibleColumns]);

  if (workItems.length === 0) {
    return (
      <div className="flex h-full min-h-[100px] items-center justify-center">
        <p className="text-ink-2 text-sm">No work items available</p>
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className={clsx(
        'flex h-full overflow-x-auto overflow-y-hidden',
        isEditorial ? 'gap-0' : 'gap-2 pb-2',
      )}
      data-work-item-list
    >
      {visibleColumns.map(({ id, name, items }) => {
        const isCollapsed = canCollapse && collapsedIds.includes(id);
        if (isCollapsed) {
          return (
            <button
              key={id}
              type="button"
              onClick={() => onToggleColumn(id)}
              title={`Expand ${name} column`}
              aria-label={`Expand ${name} column, ${items.length} items`}
              className={clsx(
                'text-ink-2 hover:bg-glass-light flex h-full shrink-0 flex-col items-center py-2 transition-colors',
                isEditorial
                  ? 'border-line-soft bg-bg-0 w-8 border-r'
                  : 'bg-bg-1/50 border-glass-border w-10 rounded border',
              )}
            >
              <ChevronRight className="h-3.5 w-3.5 shrink-0" />
              <span className="text-ink-3 mt-2 text-[10px] tabular-nums">{items.length}</span>
              <span className="mt-2 min-h-0 flex-1 overflow-hidden text-xs font-medium [writing-mode:vertical-rl]">
                {name}
              </span>
            </button>
          );
        }
        const columnTone = getBoardColumnTone(name, colorSettings);
        const applyMode = getBoardColumnApplyMode(name, colorSettings);
        const showColumnRule = applyMode === 'rule' || applyMode === 'both';
        const showColumnTint = applyMode === 'tint' || applyMode === 'both';
        return (
        <div
          key={id}
          className={clsx(
            'flex h-full shrink-0 flex-col overflow-hidden',
            isEditorial
              ? 'border-line-soft w-67 border-r'
              : 'bg-bg-1/50 w-56 rounded',
            isEditorial && !showColumnTint && 'bg-bg-0/60',
          )}
          style={
            isEditorial && showColumnTint
              ? {
                  background: `linear-gradient(color-mix(in oklch, ${columnTone} 13%, var(--color-bg-0)), color-mix(in oklch, ${columnTone} 5%, var(--color-bg-0)) 260px)`,
                }
              : undefined
          }
        >
          {/* Column header */}
          <button
            type="button"
            disabled={!canCollapse}
            onClick={() => onToggleColumn?.(id)}
            className={clsx(
              'flex w-full items-center text-left disabled:cursor-default',
              isEditorial
                ? 'border-line-soft border-t-transparent h-10 border-t-2 border-b px-3.5'
                : ['border-t-2 px-2 py-1.5', getColumnColor(name)],
            )}
            style={
              isEditorial && showColumnRule
                ? {
                    borderTopColor: `color-mix(in oklch, ${columnTone} 70%, transparent)`,
                  }
                : undefined
            }
          >
            <span
              className={clsx(
                'text-ink-1 min-w-0 truncate',
                isEditorial
                  ? 'text-[12.5px] font-semibold tracking-[-0.005em]'
                  : 'text-xs font-medium',
              )}
            >
              {name}
            </span>
            <span
              className={clsx(
                'text-ink-3 ml-1.5 font-mono text-[10px]',
                isEditorial && 'bg-bg-2 rounded-full px-1.5 py-px',
              )}
            >
              {items.length}
            </span>
            {canCollapse && <ChevronLeft className="text-ink-3 ml-auto h-3.5 w-3.5" />}
          </button>

          {/* Cards */}
          <div
            className={clsx(
              'flex min-h-0 flex-1 flex-col overflow-y-auto',
              isEditorial ? 'gap-[7px] px-3 pt-2.5 pb-4' : 'gap-1 p-1.5',
            )}
          >
            {items.map((workItem) => {
              const isHighlighted =
                workItem.id.toString() === highlightedWorkItemId;
              const isExactMatch =
                workItem.id.toString() === exactMatchWorkItemId;
              const isSelected = selectedWorkItemIds.includes(
                workItem.id.toString(),
              );
              const isRelatedBug = relatedBugWorkItemIds.includes(workItem.id);
              const bugProgress = childBugProgressByWorkItemId?.[workItem.id];
              const cachedSummary = summariesByWorkItemId.get(workItem.id);
              const summaryExcerpt = cachedSummary
                ? getWorkItemSummaryExcerpt(cachedSummary.content)
                : null;
              const summaryIsStale =
                !!cachedSummary &&
                cachedSummary.sourceChangedDate !==
                  (workItem.fields.changedDate ?? null);
              return (
                <WorkItemBoardCard
                  key={workItem.id}
                  workItem={workItem}
                  search={search}
                  variant={variant}
                  parserSetting={parserSetting}
                  colorSettings={colorSettings}
                  currentIterationPath={currentIterationPath}
                  currentUserDisplayName={currentUser?.displayName}
                  isHighlighted={isHighlighted}
                  isExactMatch={isExactMatch}
                  isSelected={isSelected}
                  isRelatedBug={isRelatedBug}
                  bugClosedCount={bugProgress?.closed ?? null}
                  bugTotalCount={bugProgress?.total ?? null}
                  summaryExcerpt={summaryExcerpt}
                  summaryIsStale={summaryIsStale}
                  showSelection={showSelection}
                  onToggleSelect={onToggleSelect}
                  onHighlight={onHighlight}
                  onModifiedClick={onModifiedClick}
                  onOpenChildBugs={onOpenChildBugs}
                />
              );
            })}
          </div>
        </div>
        );
      })}
    </div>
  );
});
