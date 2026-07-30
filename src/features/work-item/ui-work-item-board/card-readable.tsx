/* eslint-disable sort-imports */
import { Bug, Sparkles } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import clsx from 'clsx';

import type { AzureDevOpsWorkItem } from '@/lib/api';
import type { WorkItemTitleParserSetting } from '@shared/work-item-title-parser-types';
import { HighlightedSearchText, WorkItemTypeIcon } from '../ui-work-item-shared';
import { parseWorkItemTitle } from '@/lib/work-item-title-parser';
import { Tooltip } from '@/common/ui/tooltip';

import { parseAzureWorkItemTags } from './utils';

const VISIBLE_SCOPE_LIMIT = 3;

// Tags that change what you do next keep a coloured chip; everything else is
// provenance and collapses into a single "+n".
const STATE_TAG_TONES: Record<string, { label: string; tone: string }> = {
  'us ready': { label: 'US ready', tone: 'text-status-done bg-status-done/12' },
  'change request': { label: 'change request', tone: 'text-status-run bg-status-run/12' },
  'true-bug': { label: 'true bug', tone: 'text-status-fail bg-status-fail/12' },
  'not-a-true-bug': { label: 'not a bug', tone: 'text-ink-2 bg-bg-3' },
  duplicate: { label: 'duplicate', tone: 'text-ink-2 bg-bg-3' },
  blocked: { label: 'blocked', tone: 'text-status-fail bg-status-fail/12' },
  ready: { label: 'ready', tone: 'text-status-done bg-status-done/12' },
};

function iterationLeaf(iterationPath?: string) {
  const leaf = iterationPath?.split(/[\\/]/).at(-1);
  return leaf ? leaf.replace(/^Sprint /, 'S') : null;
}

export function WorkItemBoardReadableCard({
  workItem,
  search,
  parserSetting,
  avatar,
  selectionControl,
  summaryExcerpt,
  summaryIsStale,
  bugProgress,
  outOfSprintLabel,
  isExactMatch,
  onOpen,
  onOpenChildBugs,
}: {
  workItem: AzureDevOpsWorkItem;
  search: string;
  parserSetting: WorkItemTitleParserSetting | null;
  avatar: ReactNode;
  selectionControl?: ReactNode;
  summaryExcerpt: string | null;
  summaryIsStale: boolean;
  bugProgress?: { closed: number; total: number };
  outOfSprintLabel: string | null;
  isExactMatch: boolean;
  onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
  onOpenChildBugs?: () => void;
}) {
  const parsed = parseWorkItemTitle({ title: workItem.fields.title, setting: parserSetting });
  const scopes = parsed.labels.slice(0, VISIBLE_SCOPE_LIMIT);
  const hiddenScopeCount = parsed.labels.length - scopes.length;
  const isBug = workItem.fields.workItemType === 'Bug';
  const tags = parseAzureWorkItemTags(workItem.fields.tags ?? '');
  const stateTags = tags.filter((tag) => STATE_TAG_TONES[tag.toLowerCase()]);
  const otherTags = tags.filter((tag) => !STATE_TAG_TONES[tag.toLowerCase()]);
  const sprint = iterationLeaf(workItem.fields.iterationPath);

  return (
    <>
      {isBug && (
        <span
          aria-hidden="true"
          className="bg-status-fail/85 absolute top-2.5 bottom-2.5 left-0 w-0.5 rounded-full"
        />
      )}

      {/* 1 — the thing you read */}
      <button
        type="button"
        onClick={onOpen}
        className="focus-visible:ring-acc text-ink-0 line-clamp-2 w-full text-left text-[12.5px] leading-[1.42] font-medium tracking-[-0.008em] outline-none focus-visible:ring-1"
      >
        <HighlightedSearchText text={parsed.displayTitle} search={search} />
      </button>

      {/* 2 — one quiet identity line */}
      <div className="flex min-w-0 items-center gap-1.5">
        {selectionControl}
        <WorkItemTypeIcon type={workItem.fields.workItemType} size="sm" variant="editorial" />
        <span className="text-ink-3 min-w-0 truncate font-mono text-[10.5px]">
          <HighlightedSearchText text={`${workItem.id}`} search={search} />
          {sprint ? ` · ${sprint}` : ''}
        </span>
        {isExactMatch && (
          <span className="bg-acc text-bg-1 rounded px-1.5 py-px text-[9px] font-semibold tracking-wide uppercase">
            Exact
          </span>
        )}
        {outOfSprintLabel && (
          <span
            className="max-w-24 truncate rounded border border-amber-400/20 bg-amber-400/10 px-1.5 py-px text-[9px] font-semibold tracking-wide text-amber-300 uppercase"
            title={`Iteration: ${workItem.fields.iterationPath}`}
          >
            {outOfSprintLabel}
          </span>
        )}
        <span className="ml-auto shrink-0">{avatar}</span>
      </div>

      {/* 3 — scope, as text not confetti */}
      {scopes.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" aria-label="Extracted labels">
          {scopes.map((label) => (
            <span
              key={label.toLocaleLowerCase()}
              title={label}
              className="bg-bg-3 text-ink-3 max-w-full truncate rounded px-1.5 py-px font-mono text-[10px] leading-4"
            >
              {label}
            </span>
          ))}
          {hiddenScopeCount > 0 && (
            <Tooltip content={parsed.labels.join(', ')}>
              <span
                tabIndex={0}
                aria-label={`Show all extracted labels: ${parsed.labels.join(', ')}`}
                onClick={(event) => event.stopPropagation()}
                className="text-ink-3 cursor-default font-mono text-[10.5px] outline-none"
              >
                +{hiddenScopeCount}
              </span>
            </Tooltip>
          )}
        </div>
      )}

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

      {/* 4 — only tags that change what you do next */}
      {(stateTags.length > 0 || otherTags.length > 0 || bugProgress) && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Tags">
          {bugProgress &&
            (onOpenChildBugs ? (
              <button
                type="button"
                title={`${bugProgress.closed} of ${bugProgress.total} related bugs closed`}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenChildBugs();
                }}
                className={clsx(
                  'flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] underline decoration-current/40 underline-offset-2 transition-colors',
                  bugProgress.closed === bugProgress.total
                    ? 'text-status-done hover:bg-status-done/10'
                    : 'text-status-fail hover:bg-status-fail/10',
                )}
              >
                <Bug className="h-3 w-3" />
                {bugProgress.closed}/{bugProgress.total} closed
              </button>
            ) : (
              <span
                className={clsx(
                  'flex items-center gap-1 font-mono text-[10px]',
                  bugProgress.closed === bugProgress.total
                    ? 'text-status-done'
                    : 'text-status-fail',
                )}
              >
                <Bug className="h-3 w-3" />
                {bugProgress.closed}/{bugProgress.total} closed
              </span>
            ))}
          {stateTags.map((tag) => {
            const state = STATE_TAG_TONES[tag.toLowerCase()];
            return (
              <span
                key={tag}
                title={tag}
                className={clsx(
                  'inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10.5px] whitespace-nowrap',
                  state.tone,
                )}
              >
                <span className="h-1 w-1 rounded-full bg-current" />
                {state.label}
              </span>
            );
          })}
          {otherTags.length > 0 && (
            <span className="text-ink-3 font-mono text-[10.5px]" title={otherTags.join(', ')}>
              +{otherTags.length}
            </span>
          )}
        </div>
      )}
    </>
  );
}
