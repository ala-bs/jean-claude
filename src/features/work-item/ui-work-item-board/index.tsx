import { Bug, ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import clsx from 'clsx';
import type { WorkItemTitleParserSetting } from '@shared/work-item-title-parser-types';


import type { AzureDevOpsBoardColumn, AzureDevOpsWorkItem } from '@/lib/api';
import { getOwnerColor } from '@/features/work-item/utils-owner-color';
import { ParsedWorkItemTitle } from '@/features/work-item/ui-parsed-work-item-title';
import { useCommands } from '@/common/hooks/use-commands';
import { useCurrentAzureUser } from '@/hooks/use-work-items';
import { UserAvatar } from '@/common/ui/user-avatar';


import { groupWorkItemsByBoardColumns, parseAzureWorkItemTags } from './utils';
import {
  HighlightedSearchText,
  SelectionCheckbox,
  WorkItemTypeIcon,
} from '../ui-work-item-shared';
import { WorkItemBoardPrimaryHeading } from './card-primary-heading';

const EMPTY_COLUMN_IDS: string[] = [];

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

function getWorkItemBorderColor(type: string): string {
  switch (type) {
    case 'Bug':
      return 'border-l-status-fail';
    case 'User Story':
      return 'border-l-status-review';
    case 'Feature':
      return 'border-l-acc-ink';
    case 'Task':
      return 'border-l-status-run';
    default:
      return 'border-l-ink-3';
  }
}

export function WorkItemBoard({
  workItems,
  boardColumns,
  highlightedWorkItemId,
  exactMatchWorkItemId,
  selectedWorkItemIds,
  providerId,
  search,
  onToggleSelect,
  onHighlight,
  showSelection = true,
  onModifiedClick,
  collapsedColumnIds,
  onToggleColumn,
  childBugProgressByWorkItemId,
  onOpenChildBugs,
  relatedBugWorkItemIds = [],
  variant = 'default',
  parserSetting = null,
}: {
  workItems: AzureDevOpsWorkItem[];
  boardColumns: AzureDevOpsBoardColumn[];
  highlightedWorkItemId: string | null;
  exactMatchWorkItemId?: string | null;
  selectedWorkItemIds: string[];
  providerId?: string;
  search: string;
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
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const { data: currentUser } = useCurrentAzureUser(providerId ?? null);

  // Group work items by Azure board column when available, then fall back to state.
  const columns = useMemo(
    () => groupWorkItemsByBoardColumns({ boardColumns, workItems }),
    [boardColumns, workItems],
  );
  const canCollapse = collapsedColumnIds !== undefined && !!onToggleColumn;
  const collapsedIds = canCollapse ? collapsedColumnIds : EMPTY_COLUMN_IDS;
  const isEditorial = variant === 'editorial';

  const visibleColumns = useMemo(() => {
    if (isEditorial || !search.trim()) return columns;
    return columns.filter((column) => column.items.length > 0);
  }, [columns, isEditorial, search]);
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
        return (
        <div
          key={id}
          className={clsx(
            'flex h-full shrink-0 flex-col overflow-hidden',
            isEditorial
              ? 'border-line-soft bg-bg-0 w-63 border-r'
              : 'bg-bg-1/50 w-56 rounded',
          )}
        >
          {/* Column header */}
          <button
            type="button"
            disabled={!canCollapse}
            onClick={() => onToggleColumn?.(id)}
            className={clsx(
              'flex w-full items-center text-left disabled:cursor-default',
              isEditorial
                ? 'border-line h-10 border-b px-3'
                : ['border-t-2 px-2 py-1.5', getColumnColor(name)],
            )}
          >
            <span
              className={clsx(
                'text-ink-1 min-w-0 truncate text-xs font-medium',
                isEditorial && 'font-mono uppercase tracking-[0.04em]',
              )}
            >
              {name}
            </span>
            <span className="text-ink-3 ml-1.5 font-mono text-[10px]">{items.length}</span>
            {canCollapse && <ChevronLeft className="text-ink-3 ml-auto h-3.5 w-3.5" />}
          </button>

          {/* Cards */}
          <div
            className={clsx(
              'flex min-h-0 flex-1 flex-col overflow-y-auto',
              isEditorial ? 'gap-[5px] p-2.5' : 'gap-1 p-1.5',
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
              const openWorkItem = (modified: boolean) => {
                if (modified && onModifiedClick) {
                  onModifiedClick(workItem);
                  return;
                }
                onHighlight(workItem);
              };
              const selectionControl = showSelection && onToggleSelect ? <button
                    type="button"
                    aria-label={`${isSelected ? 'Deselect' : 'Select'} work item #${workItem.id}`}
                    aria-checked={isSelected}
                    role="checkbox"
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleSelect(workItem);
                    }}
                    className="rounded"
                  >
                    <SelectionCheckbox checked={isSelected} size="sm" />
                  </button> : undefined;
              const avatar = workItem.fields.assignedTo ? <UserAvatar
                name={workItem.fields.assignedTo}
                color={getOwnerColor(workItem.fields.assignedTo)}
                title={currentUser?.displayName && workItem.fields.assignedTo === currentUser.displayName ? `${workItem.fields.assignedTo} (you)` : workItem.fields.assignedTo}
                highlight={!!currentUser?.displayName && workItem.fields.assignedTo === currentUser.displayName}
              /> : null;
              const metadataContent = <>
                  <WorkItemTypeIcon
                    type={workItem.fields.workItemType}
                    size="sm"
                    variant={variant}
                  />
                  <span className="text-ink-3 font-mono text-[10px]">
                    <HighlightedSearchText text={`#${workItem.id}`} search={search} />
                  </span>
                  {isExactMatch && <span className="bg-acc text-bg-1 rounded px-1.5 py-px text-[9px] font-semibold tracking-wide uppercase">Exact</span>}
                  {!isEditorial && <span className="text-ink-2 max-w-[80px] truncate text-[10px]">{workItem.fields.workItemType}</span>}
                </>;
              const cardMetadata = <span className="flex items-center gap-1.5">
                {selectionControl}
                {metadataContent}
                <span className="ml-auto">{avatar}</span>
              </span>;
              const rawTitle = <span className={clsx(
                'text-ink-0 line-clamp-2 leading-[1.36]',
                isEditorial ? 'text-xs' : 'text-[12.5px]',
              )}>
                <HighlightedSearchText text={workItem.fields.title} search={search} />
              </span>;
              const cardHeading = parserSetting ? <ParsedWorkItemTitle
                  title={workItem.fields.title}
                  parserSetting={parserSetting}
                  compact
                  search={search}
                  renderTitle={(title) => <WorkItemBoardPrimaryHeading
                    selectionControl={selectionControl}
                    trailingControl={avatar}
                    metadata={metadataContent}
                    title={title}
                    onOpen={(event) => {
                      event.stopPropagation();
                      openWorkItem(event.metaKey || event.ctrlKey);
                    }}
                  />}
                  titleClassName={clsx(
                    'text-ink-0 line-clamp-2 leading-[1.36]',
                    isEditorial ? 'text-xs' : 'text-[12.5px]',
                  )}
                /> : <>{cardMetadata}{rawTitle}</>;
              const hasPrimaryButton = isEditorial || parserSetting !== null;

              return (
                <div
                  key={workItem.id}
                  data-work-item-id={workItem.id}
                  onClick={(event) => openWorkItem(event.metaKey || event.ctrlKey)}
                  onKeyDown={hasPrimaryButton ? undefined : (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    openWorkItem(event.metaKey || event.ctrlKey);
                  }}
                  role={hasPrimaryButton ? undefined : 'button'}
                  tabIndex={hasPrimaryButton ? undefined : 0}
                  className={clsx(
                    'flex cursor-pointer flex-col gap-1.5 border p-2 text-left transition-[box-shadow,border-color,background-color]',
                    isEditorial
                      ? ['bg-bg-0 rounded-[6px] border-l-[3px] px-3 py-2.5', getWorkItemBorderColor(workItem.fields.workItemType)]
                      : 'rounded',
                    isExactMatch
                      ? 'border-acc bg-acc/15 shadow-[0_0_0_2px_oklch(0.78_0.18_295_/_0.45),0_0_28px_oklch(0.78_0.18_295_/_0.35)]'
                      : isHighlighted
                        ? 'border-acc bg-acc/10 shadow-[0_0_0_3px_oklch(0.72_0.2_295_/_0.1)]'
                        : isRelatedBug
                          ? 'border-status-fail/60 bg-status-fail/10 shadow-[0_0_0_3px_oklch(0.72_0.18_25_/_0.12)]'
                        : 'hover:bg-bg-2 border-line',
                  )}
                >
                  {isEditorial && !parserSetting ? <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      openWorkItem(event.metaKey || event.ctrlKey);
                    }}
                    className="focus-visible:ring-acc flex w-full flex-col gap-1.5 text-left outline-none focus-visible:ring-1"
                  >
                    {cardHeading}
                  </button> : cardHeading}
                  {bugProgress && (
                    onOpenChildBugs ? <button
                      type="button"
                      title={`${bugProgress.closed} of ${bugProgress.total} related bugs closed`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenChildBugs(workItem);
                      }}
                      className={clsx(
                        'flex items-center gap-1 self-start rounded-sm px-1.5 py-0.5 font-mono text-[10px] underline decoration-current/40 underline-offset-2 transition-colors',
                        bugProgress.closed === bugProgress.total
                          ? 'text-status-done hover:bg-status-done/10'
                          : 'text-status-fail hover:bg-status-fail/10',
                      )}
                    >
                      <Bug className="h-3 w-3" />
                      {bugProgress.closed}/{bugProgress.total} closed
                    </button> : <span className={clsx(
                      'flex items-center gap-1 self-start font-mono text-[10px]',
                      bugProgress.closed === bugProgress.total ? 'text-status-done' : 'text-status-fail',
                    )}>
                      <Bug className="h-3 w-3" />
                      {bugProgress.closed}/{bugProgress.total} closed
                    </span>
                  )}
                  {workItem.fields.tags && (
                    <div className="flex max-h-8 flex-wrap gap-1 overflow-hidden" aria-label="Tags">
                      {parseAzureWorkItemTags(workItem.fields.tags).map((tag) => (
                        <span
                          key={tag}
                          className={clsx(
                            'bg-bg-3 text-ink-3 max-w-full truncate px-1.5 py-0.5 font-mono text-[9px] leading-3',
                            !isEditorial && 'rounded',
                          )}
                          title={tag}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        );
      })}
    </div>
  );
}
