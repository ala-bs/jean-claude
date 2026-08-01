/* eslint-disable sort-imports */
import { Bug, Sparkles } from 'lucide-react';
import { memo, useCallback } from 'react';
import clsx from 'clsx';
import type { MouseEvent } from 'react';
import type { WorkItemTitleParserSetting } from '@shared/work-item-title-parser-types';

import type { AzureDevOpsWorkItem } from '@/lib/api';
import type { BoardColorSettings } from '@/features/work-item/utils-board-colors';
import { ParsedWorkItemTitle } from '@/features/work-item/ui-parsed-work-item-title';
import { UserAvatar } from '@/common/ui/user-avatar';
import { getOwnerColor } from '@/features/work-item/utils-owner-color';

import { isAzureWorkItemOutOfSprint, parseAzureWorkItemTags } from './utils';
import {
  HighlightedSearchText,
  SelectionCheckbox,
  WorkItemTypeIcon,
} from '../ui-work-item-shared';
import { WorkItemBoardPrimaryHeading } from './card-primary-heading';
import { WorkItemBoardReadableCard } from './card-readable';

// Memoized so selecting/highlighting one card does not re-render every other
// card on the board. All props must stay referentially stable across renders.
export const WorkItemBoardCard = memo(function WorkItemBoardCard({
  workItem,
  search,
  variant,
  parserSetting,
  colorSettings,
  currentIterationPath,
  currentUserDisplayName,
  isHighlighted,
  isExactMatch,
  isSelected,
  isRelatedBug,
  bugClosedCount,
  bugTotalCount,
  summaryExcerpt,
  summaryIsStale,
  showSelection,
  onToggleSelect,
  onHighlight,
  onModifiedClick,
  onOpenChildBugs,
}: {
  workItem: AzureDevOpsWorkItem;
  search: string;
  variant: 'default' | 'editorial';
  parserSetting: WorkItemTitleParserSetting | null;
  colorSettings: BoardColorSettings;
  currentIterationPath?: string;
  currentUserDisplayName?: string;
  isHighlighted: boolean;
  isExactMatch: boolean;
  isSelected: boolean;
  isRelatedBug: boolean;
  bugClosedCount: number | null;
  bugTotalCount: number | null;
  summaryExcerpt: string | null;
  summaryIsStale: boolean;
  showSelection: boolean;
  onToggleSelect?: (workItem: AzureDevOpsWorkItem) => void;
  onHighlight: (workItem: AzureDevOpsWorkItem) => void;
  onModifiedClick?: (workItem: AzureDevOpsWorkItem) => void;
  onOpenChildBugs?: (workItem: AzureDevOpsWorkItem) => void;
}) {
  const isEditorial = variant === 'editorial';
  const isOutOfSprint = isAzureWorkItemOutOfSprint(workItem, currentIterationPath);
  const hasBugProgress = bugClosedCount !== null && bugTotalCount !== null;

  const openWorkItem = useCallback(
    (modified: boolean) => {
      if (modified && onModifiedClick) {
        onModifiedClick(workItem);
        return;
      }
      onHighlight(workItem);
    },
    [onHighlight, onModifiedClick, workItem],
  );
  const handleOpen = useCallback(
    (event: MouseEvent) => {
      event.stopPropagation();
      openWorkItem(event.metaKey || event.ctrlKey);
    },
    [openWorkItem],
  );
  const handleOpenChildBugs = useCallback(() => {
    onOpenChildBugs?.(workItem);
  }, [onOpenChildBugs, workItem]);

  const selectionControl =
    showSelection && onToggleSelect ? (
      <button
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
      </button>
    ) : undefined;
  const avatar = workItem.fields.assignedTo ? (
    <UserAvatar
      name={workItem.fields.assignedTo}
      color={getOwnerColor(workItem.fields.assignedTo)}
      title={
        currentUserDisplayName &&
        workItem.fields.assignedTo === currentUserDisplayName
          ? `${workItem.fields.assignedTo} (you)`
          : workItem.fields.assignedTo
      }
      highlight={
        !!currentUserDisplayName &&
        workItem.fields.assignedTo === currentUserDisplayName
      }
    />
  ) : null;
  const metadataContent = (
    <>
      <WorkItemTypeIcon
        type={workItem.fields.workItemType}
        size="sm"
        variant={variant}
      />
      <span className="text-ink-3 font-mono text-[10px]">
        <HighlightedSearchText text={`#${workItem.id}`} search={search} />
      </span>
      {isExactMatch && (
        <span className="bg-acc text-bg-1 rounded px-1.5 py-px text-[9px] font-semibold tracking-wide uppercase">
          Exact
        </span>
      )}
      {isOutOfSprint && (
        <span
          className="max-w-28 truncate rounded border border-amber-400/20 bg-amber-400/10 px-1.5 py-px text-[9px] font-semibold tracking-wide text-amber-300 uppercase"
          title={`Iteration: ${workItem.fields.iterationPath}`}
        >
          {workItem.fields.iterationPath?.split(/[\\/]/).at(-1)}
        </span>
      )}
      {!isEditorial && (
        <span className="text-ink-2 max-w-[80px] truncate text-[10px]">
          {workItem.fields.workItemType}
        </span>
      )}
    </>
  );
  const cardMetadata = (
    <span className="flex items-center gap-1.5">
      {selectionControl}
      {metadataContent}
      <span className="ml-auto">{avatar}</span>
    </span>
  );
  const rawTitle = (
    <span
      className={clsx(
        'text-ink-0 line-clamp-2 leading-[1.36]',
        isEditorial ? 'text-xs' : 'text-[12.5px]',
      )}
    >
      <HighlightedSearchText text={workItem.fields.title} search={search} />
    </span>
  );
  const cardHeading = parserSetting ? (
    <ParsedWorkItemTitle
      title={workItem.fields.title}
      parserSetting={parserSetting}
      compact
      search={search}
      renderTitle={(title) => (
        <WorkItemBoardPrimaryHeading
          selectionControl={selectionControl}
          trailingControl={avatar}
          metadata={metadataContent}
          title={title}
          onOpen={handleOpen}
        />
      )}
      titleClassName={clsx(
        'text-ink-0 line-clamp-2 leading-[1.36]',
        isEditorial ? 'text-xs' : 'text-[12.5px]',
      )}
    />
  ) : (
    <>
      {cardMetadata}
      {rawTitle}
    </>
  );
  const hasPrimaryButton = isEditorial || parserSetting !== null;

  return (
    <div
      data-work-item-id={workItem.id}
      aria-current={isHighlighted ? 'true' : undefined}
      onClick={(event) => openWorkItem(event.metaKey || event.ctrlKey)}
      onKeyDown={
        hasPrimaryButton
          ? undefined
          : (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              openWorkItem(event.metaKey || event.ctrlKey);
            }
      }
      role={hasPrimaryButton ? undefined : 'button'}
      tabIndex={hasPrimaryButton ? undefined : 0}
      className={clsx(
        'flex cursor-pointer flex-col text-left transition-[box-shadow,border-color,background-color]',
        isEditorial
          ? 'bg-bg-1 relative gap-1.5 rounded-lg border border-transparent px-3 py-2.5'
          : 'gap-1.5 rounded border p-2',
        isExactMatch
          ? 'border border-acc bg-acc/15 shadow-[0_0_0_2px_oklch(0.78_0.18_295_/_0.45),0_0_28px_oklch(0.78_0.18_295_/_0.35)]'
          : isHighlighted
            ? 'border !border-acc'
            : isRelatedBug
              ? 'border border-status-fail/60 bg-status-fail/10 shadow-[0_0_0_3px_oklch(0.72_0.18_25_/_0.12)]'
              : isEditorial
                ? 'hover:bg-bg-2'
                : 'hover:bg-bg-2 border-line',
      )}
    >
      {isEditorial ? (
        <WorkItemBoardReadableCard
          workItem={workItem}
          colorSettings={colorSettings}
          search={search}
          parserSetting={parserSetting}
          avatar={avatar}
          selectionControl={selectionControl}
          summaryExcerpt={summaryExcerpt}
          summaryIsStale={summaryIsStale}
          bugProgress={
            hasBugProgress
              ? { closed: bugClosedCount, total: bugTotalCount }
              : undefined
          }
          outOfSprintLabel={
            isOutOfSprint
              ? (workItem.fields.iterationPath?.split(/[\\/]/).at(-1) ?? null)
              : null
          }
          isExactMatch={isExactMatch}
          onOpen={handleOpen}
          onOpenChildBugs={onOpenChildBugs ? handleOpenChildBugs : undefined}
        />
      ) : (
        <>
          {cardHeading}
          {summaryExcerpt && (
            <div className="text-ink-3 flex min-w-0 items-center gap-1.5 text-[10.5px] leading-snug">
              <Sparkles className="text-acc h-3 w-3 shrink-0" />
              <span className="line-clamp-1 min-w-0">{summaryExcerpt}</span>
              {summaryIsStale && (
                <span
                  className="bg-status-run h-1.5 w-1.5 shrink-0 rounded-full"
                  title="Summary source updated"
                />
              )}
            </div>
          )}
          {hasBugProgress &&
            (onOpenChildBugs ? (
              <button
                type="button"
                title={`${bugClosedCount} of ${bugTotalCount} related bugs closed`}
                onClick={(event) => {
                  event.stopPropagation();
                  handleOpenChildBugs();
                }}
                className={clsx(
                  'flex items-center gap-1 self-start rounded-sm px-1.5 py-0.5 font-mono text-[10px] underline decoration-current/40 underline-offset-2 transition-colors',
                  bugClosedCount === bugTotalCount
                    ? 'text-status-done hover:bg-status-done/10'
                    : 'text-status-fail hover:bg-status-fail/10',
                )}
              >
                <Bug className="h-3 w-3" />
                {bugClosedCount}/{bugTotalCount} closed
              </button>
            ) : (
              <span
                className={clsx(
                  'flex items-center gap-1 self-start font-mono text-[10px]',
                  bugClosedCount === bugTotalCount
                    ? 'text-status-done'
                    : 'text-status-fail',
                )}
              >
                <Bug className="h-3 w-3" />
                {bugClosedCount}/{bugTotalCount} closed
              </span>
            ))}
          {workItem.fields.tags && (
            <div
              className="flex max-h-8 flex-wrap gap-1 overflow-hidden"
              aria-label="Tags"
            >
              {parseAzureWorkItemTags(workItem.fields.tags).map((tag) => (
                <span
                  key={tag}
                  className="bg-bg-3 text-ink-3 max-w-full truncate rounded px-1.5 py-0.5 font-mono text-[9px] leading-3"
                  title={tag}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
});
