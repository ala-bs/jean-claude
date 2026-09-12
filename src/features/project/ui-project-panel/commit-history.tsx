import {
  Check,
  ChevronDown,
  Clipboard,
  GitBranch,
  GitPullRequest,
  Search,
  Tag,
} from 'lucide-react';
import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';

import type { BranchInfo, ProjectGitCommit } from '@shared/types';
import {
  groupCommitsByDay,
  layoutCommitLanes,
  openLanesAt,
  traceBranchLine,
  traceRefLine,
} from './utils-commit-lanes';
import { BranchFilter } from './branch-filter';
import type { CommitLaneRow } from './utils-commit-lanes';
import type { CommitRefGroup } from './utils-commit-refs';
import { CommitSearch } from './commit-search';
import { formatRelativeTime } from '@/lib/time';
import { groupCommitRefs } from './utils-commit-refs';
import { useMessageContextMenu } from '@/features/agent/ui-message-stream/ui-message-context-menu';
import { useToastStore } from '@/stores/toasts';

/** Horizontal distance between lanes, and the left inset of lane 0. */
const LANE_WIDTH = 15;
const LANE_ORIGIN = 10;
const ROW_HEIGHT = 36;
/** Distance from the bottom at which scrolling pulls the next page. */
const LOAD_MORE_THRESHOLD_PX = 320;

/** Stroke weight of the lane art. Thick enough to trace a branch by eye. */
const LANE_STROKE = 2.25;

/** Ref-picker geometry, used to flip the menu above the chip near the bottom. */
const MENU_WIDTH_PX = 260;
const MENU_ITEM_PX = 30;
const MENU_HEADER_PX = 26;
const MENU_PAD_PX = 8;

/**
 * Per-lane colours. Every lane is coloured, including lane 0 (the trunk), so a
 * commit's lane can be matched to its branch at a glance. Ordered so the first
 * few lanes — which cover almost every real row — are maximally spread in hue
 * (295, 75, 155, 25); the near neighbours (235/260/205) sit at the tail.
 */
const LANE_COLORS = [
  'var(--color-acc-ink)',
  'var(--color-status-run)',
  'var(--color-status-done)',
  'var(--color-status-fail)',
  'var(--color-status-review)',
  'var(--color-status-azure)',
  'var(--color-status-pr)',
  'var(--color-ink-2)',
];

function laneX(lane: number): number {
  return LANE_ORIGIN + lane * LANE_WIDTH;
}

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

/** Tooltip text for a badge, naming the refs it stands for. */
function describeGroup(group: CommitRefGroup, isFocused: boolean): string {
  const lines = [group.ref.isHead ? `${group.key} (current branch)` : group.key];
  for (const remote of group.remotes) lines.push(`in sync with ${remote.name}`);
  if (isFocused) lines.push('focused branch');
  return lines.join('\n');
}

/**
 * One ref on a commit.
 *
 * When the commit's badge stands for the focused branch it is tinted with that
 * commit's lane colour, so the badge and the rail it labels are the same hue
 * and the eye can link "this name" to "that line" without counting lanes.
 */
function RefBadge({
  group,
  tint,
  isFocused,
}: {
  group: CommitRefGroup;
  /** Lane colour of the commit, applied only while focused. */
  tint: string;
  isFocused: boolean;
}) {
  const { ref: gitRef } = group;
  const isBranchKind = gitRef.kind === 'branch' || gitRef.kind === 'remote';

  return (
    <span
      className={clsx(
        'inline-flex min-w-0 max-w-[180px] items-center gap-1 rounded px-1 py-px font-mono text-[10px] leading-4 whitespace-nowrap',
        // Weight and the filled node marker carry "focused" on their own. Lane
        // 0 is the accent colour and lane 7 is near-grey, so a hue swap alone
        // would be invisible on the trunk and meaningless on the last lane —
        // exactly the two lanes most commits sit in.
        isFocused && 'font-semibold',
        !isFocused && gitRef.kind === 'tag' && 'bg-amber-400/10 text-amber-300',
        !isFocused &&
          gitRef.kind === 'remote' &&
          'bg-status-review-soft text-status-review',
        !isFocused && gitRef.kind === 'branch' && 'bg-acc/15 text-acc-ink',
        !isFocused && gitRef.kind === 'other' && 'bg-glass-medium text-ink-3',
        !isFocused && gitRef.isHead && 'ring-acc/40 ring-1',
      )}
      style={
        isFocused
          ? {
              color: tint,
              backgroundColor: `color-mix(in oklab, ${tint} 26%, transparent)`,
              boxShadow: `0 0 0 1px color-mix(in oklab, ${tint} 85%, transparent)`,
            }
          : undefined
      }
      title={describeGroup(group, isFocused)}
    >
      {isFocused ? (
        // Same filled disc the graph draws for this commit's node, in the same
        // hue — the badge and the rail it labels read as one object.
        <span
          aria-hidden
          className="h-[5px] w-[5px] shrink-0 rounded-full"
          style={{ backgroundColor: tint }}
        />
      ) : isBranchKind ? (
        <GitBranch size={9} className="shrink-0 opacity-70" />
      ) : gitRef.kind === 'tag' ? (
        <Tag size={9} className="shrink-0 opacity-70" />
      ) : null}
      <span className="truncate">{gitRef.name}</span>
      {group.remotes.length > 0 && (
        <span aria-hidden className="shrink-0 opacity-60" title="in sync with its remote">
          ●
        </span>
      )}
    </span>
  );
}

/**
 * Badge strip for a commit, plus the picker that resolves "which branch".
 *
 * A commit carrying several refs used to render the first one and a dead `+N`
 * tooltip, so selecting it left no way to say which branch was meant. The chip
 * is now a menu: the chosen ref becomes the primary badge, and everything that
 * reads the selection (the branch-line trace, the diff pane header) follows it.
 */
function CommitRefs({
  groups,
  tint,
  focusedKey,
  onFocusRef,
}: {
  groups: CommitRefGroup[];
  tint: string;
  /** Null when this commit is not the selected one — nothing is focused then. */
  focusedKey: string | null;
  onFocusRef: (key: string) => void;
}) {
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
    null,
  );
  const container = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!anchor) return;
    const close = () => setAnchor(null);
    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    // The menu is position:fixed, so any scroll would leave it floating over
    // unrelated rows — capture phase catches the history list's own scroller.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [anchor]);

  if (groups.length === 0) return null;

  /**
   * Places the fixed-position menu, flipping above the chip when it would run
   * off the bottom and clamping to the right edge. Without this the last rows
   * of a full-height history open a menu partly below the viewport, and since
   * a fixed element does not scroll — and any scroll closes it — those items
   * would be unreachable.
   */
  const placeMenu = (rect: DOMRect) => {
    const height = MENU_HEADER_PX + groups.length * MENU_ITEM_PX + MENU_PAD_PX;
    const fitsBelow = rect.bottom + 4 + height <= window.innerHeight - 8;
    return {
      top: fitsBelow
        ? rect.bottom + 4
        : Math.max(8, rect.top - 4 - height),
      left: Math.max(
        8,
        Math.min(rect.left, window.innerWidth - MENU_WIDTH_PX - 8),
      ),
    };
  };

  const focused = groups.find((group) => group.key === focusedKey);
  // Promote the focused ref to the visible badge; otherwise show the
  // highest-ranked one, which is what the row looked like before selection.
  const primary = focused ?? groups[0];
  const rest = groups.filter((group) => group !== primary);

  return (
    <span
      ref={container}
      className="flex min-w-0 items-center gap-1.5"
      // Escape closes the menu without touching the row's own Escape binding
      // (which closes the whole diff pane) — the nearer intent wins.
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !anchor) return;
        event.stopPropagation();
        setAnchor(null);
        trigger.current?.focus();
      }}
    >
      <RefBadge
        group={primary}
        tint={tint}
        isFocused={focusedKey === primary.key}
      />

      {rest.length > 0 && (
        <button
          ref={trigger}
          type="button"
          aria-haspopup="menu"
          aria-expanded={anchor !== null}
          title={`Also at:\n${rest.map((group) => group.key).join('\n')}\n\nClick to choose which branch to focus`}
          aria-label="Choose which branch to focus"
          onClick={(event) => {
            event.stopPropagation();
            if (anchor) {
              setAnchor(null);
              return;
            }
            setAnchor(placeMenu(event.currentTarget.getBoundingClientRect()));
          }}
          className={clsx(
            'border-line bg-bg-2 text-ink-3 hover:text-ink-0 hover:border-acc-line inline-flex shrink-0 items-center gap-0.5 rounded border px-1 font-mono text-[10px] leading-4 transition-colors',
            anchor && 'text-ink-0 border-acc-line',
          )}
        >
          +{rest.length}
          {/* The old `+N` was a dead tooltip chip that looked exactly like
              this. The caret is what says it became a menu. */}
          <ChevronDown size={9} className="shrink-0 opacity-70" />
        </button>
      )}

      {anchor && (
        <div
          role="menu"
          onClick={(event) => event.stopPropagation()}
          style={{ top: anchor.top, left: anchor.left }}
          className="border-line bg-bg-1 fixed z-50 w-[260px] overflow-hidden rounded-lg border p-1 shadow-[0_18px_44px_-12px_rgba(0,0,0,0.6)]"
        >
          <div className="text-ink-4 px-2 pt-1 pb-1.5 text-[10px] font-semibold tracking-[0.08em] uppercase">
            Focus branch
          </div>
          {groups.map((group) => (
            <button
              key={group.key}
              type="button"
              role="menuitem"
              onClick={() => {
                onFocusRef(group.key);
                setAnchor(null);
              }}
              className={clsx(
                'hover:bg-glass-light grid w-full grid-cols-[13px_minmax(0,1fr)_auto] items-center gap-2 rounded px-2 py-1.5 text-left transition-colors',
                group.key === focusedKey && 'bg-bg-2',
              )}
            >
              <span
                className={clsx(
                  'flex',
                  group.key === focusedKey ? 'text-acc-ink' : 'text-transparent',
                )}
              >
                <Check size={12} />
              </span>
              <span
                title={group.key}
                className="text-ink-1 truncate font-mono text-[11.5px]"
              >
                {group.key}
              </span>
              <span className="text-ink-4 font-mono text-[10px] whitespace-nowrap">
                {group.ref.kind === 'branch' && group.ref.isHead
                  ? 'HEAD'
                  : group.remotes.length > 0
                    ? 'synced'
                    : group.ref.kind === 'branch'
                      ? 'local'
                      : group.ref.kind}
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/**
 * One row of lane art.
 *
 * Lanes passing through are straight rails; a merge's extra parents leave the
 * node as curves heading down into their lane, and lanes closing at this
 * commit arrive as curves from above. `overflow-visible` matters: the curves
 * intentionally reach the row edges to meet their neighbours.
 */
function GraphCell({
  row,
  width,
  isFirst,
  isLast,
}: {
  row: CommitLaneRow;
  width: number;
  isFirst: boolean;
  isLast: boolean;
}) {
  const x = laneX(row.lane);
  const mid = ROW_HEIGHT / 2;
  const color = laneColor(row.lane);

  return (
    <svg
      width={width}
      height={ROW_HEIGHT}
      className="block shrink-0 overflow-visible"
      aria-hidden
    >
      {row.through.map((lane) => (
        <line
          key={`through-${lane}`}
          x1={laneX(lane)}
          y1={0}
          x2={laneX(lane)}
          y2={ROW_HEIGHT}
          stroke={laneColor(lane)}
          strokeOpacity={0.75}
          strokeWidth={LANE_STROKE}
          strokeLinecap="round"
        />
      ))}

      <line
        x1={x}
        y1={isFirst ? mid : 0}
        x2={x}
        y2={isLast ? mid : ROW_HEIGHT}
        stroke={color}
        strokeOpacity={0.95}
        strokeWidth={LANE_STROKE}
        strokeLinecap="round"
      />

      {row.forks.map((lane) => (
        <path
          key={`fork-${lane}`}
          d={`M ${x} ${mid} C ${x} ${mid + 10}, ${laneX(lane)} ${mid + 4}, ${laneX(lane)} ${ROW_HEIGHT}`}
          fill="none"
          stroke={laneColor(lane)}
          strokeOpacity={0.9}
          strokeWidth={LANE_STROKE}
          strokeLinecap="round"
        />
      ))}

      {row.joins.map((lane) => (
        <path
          key={`join-${lane}`}
          d={`M ${laneX(lane)} 0 C ${laneX(lane)} ${mid - 4}, ${x} ${mid - 10}, ${x} ${mid}`}
          fill="none"
          stroke={laneColor(lane)}
          strokeOpacity={0.9}
          strokeWidth={LANE_STROKE}
          strokeLinecap="round"
        />
      ))}

      {row.isMerge ? (
        <circle
          cx={x}
          cy={mid}
          r={4.8}
          fill="var(--color-bg-0)"
          stroke={color}
          strokeWidth={2.75}
        />
      ) : (
        <circle
          cx={x}
          cy={mid}
          r={row.commit.refs.length > 0 ? 4.4 : 3.4}
          fill={color}
          stroke="var(--color-bg-0)"
          strokeWidth={2.5}
        />
      )}
    </svg>
  );
}

const GRID = 'grid items-center gap-3 pr-4 pl-3';

/** Wraps query matches in the subject so it is obvious why a row matched. */
function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return <>{text}</>;

  const parts: React.ReactNode[] = [];
  const haystack = text.toLowerCase();
  const lowered = needle.toLowerCase();
  let cursor = 0;
  let index = haystack.indexOf(lowered);

  while (index !== -1) {
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(
      <mark
        key={index}
        className="bg-acc-soft text-acc-ink rounded-[2px] px-px"
      >
        {text.slice(index, index + needle.length)}
      </mark>,
    );
    cursor = index + needle.length;
    index = haystack.indexOf(lowered, cursor);
  }
  if (cursor === 0) return <>{text}</>;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/**
 * A commit in the filtered list.
 *
 * Filtering selects commits out of the middle of the history, so there is no
 * meaningful lane art to draw between them — the graph column is replaced by
 * the branch the commit sits on, which is the thing the user actually loses.
 */
function ResultRow({
  commit,
  query,
  isSelected,
  focusedRef,
  onFocusRef,
  onSelect,
  onContextMenu,
}: {
  commit: ProjectGitCommit;
  query: string;
  isSelected: boolean;
  focusedRef: string | null;
  onFocusRef: (key: string) => void;
  onSelect: () => void;
  onContextMenu: (event: MouseEvent) => void;
}) {
  const groups = useMemo(() => groupCommitRefs(commit.refs), [commit.refs]);

  return (
    // See CommitRow: the row hosts the ref picker, so it cannot be a button.
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event: KeyboardEvent) => {
        // Only the row itself. Keydown from the nested ref picker bubbles here,
        // and a button's click *is* the default action of its Enter keydown —
        // calling preventDefault() on the way past would cancel it, leaving the
        // menu unopenable by keyboard and selecting the row instead.
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelect();
      }}
      onContextMenu={onContextMenu}
      className={clsx(
        GRID,
        'hover:bg-glass-light w-full cursor-pointer text-left transition-colors',
        isSelected && 'bg-bg-2 shadow-[inset_2px_0_0_var(--color-acc-ink)]',
      )}
      style={{
        height: ROW_HEIGHT,
        gridTemplateColumns: '170px 66px minmax(0,1fr) auto',
      }}
    >
      {/* overflow-hidden: the cell is a fixed track, and the badge strip is
          content-sized — without it a long branch name paints over the hash. */}
      <span className="inline-flex min-w-0 items-center gap-1.5 overflow-hidden">
        {groups.length > 0 ? (
          <CommitRefs
            groups={groups}
            // No lane art while filtering, so there is no rail to match a hue
            // to — the accent keeps "focused" legible without inventing one.
            tint="var(--color-acc-ink)"
            focusedKey={isSelected ? focusedRef : null}
            onFocusRef={onFocusRef}
          />
        ) : (
          <GitBranch size={10} className="text-ink-4 shrink-0 opacity-40" />
        )}
      </span>

      <span className="text-ink-3 font-mono text-[11.5px]">
        <Highlight text={commit.shortHash} query={query} />
      </span>

      <span className="text-ink-1 min-w-0 truncate text-[13px]">
        <Highlight text={commit.subject} query={query} />
      </span>

      <span className="flex shrink-0 items-center gap-2">
        <span className="text-ink-3 text-[11px]">{commit.author}</span>
        <span className="text-ink-4 font-mono text-[11px]">
          {formatRelativeTime(commit.date)}
        </span>
      </span>
    </div>
  );
}

function CommitRow({
  row,
  width,
  isFirst,
  isLast,
  isSelected,
  isOnBranchLine,
  isDimmed,
  focusedRef,
  onFocusRef,
  onSelect,
  onContextMenu,
}: {
  row: CommitLaneRow;
  width: number;
  isFirst: boolean;
  isLast: boolean;
  isSelected: boolean;
  /** On the selected commit's branch line. False for every row when nothing is selected. */
  isOnBranchLine: boolean;
  /** Off that line while some line is active — never true without a selection. */
  isDimmed: boolean;
  /** Focused ref name, only meaningful on the selected row. */
  focusedRef: string | null;
  onFocusRef: (key: string) => void;
  onSelect: () => void;
  onContextMenu: (event: MouseEvent) => void;
}) {
  const commit: ProjectGitCommit = row.commit;
  const groups = useMemo(() => groupCommitRefs(commit.refs), [commit.refs]);

  return (
    // A div rather than a button: the ref picker is an interactive control
    // inside the row, and a button may not contain a button.
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event: KeyboardEvent) => {
        // Only the row itself. Keydown from the nested ref picker bubbles here,
        // and a button's click *is* the default action of its Enter keydown —
        // calling preventDefault() on the way past would cancel it, leaving the
        // menu unopenable by keyboard and selecting the row instead.
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelect();
      }}
      onContextMenu={onContextMenu}
      className={clsx(
        GRID,
        'hover:bg-glass-light w-full cursor-pointer text-left transition-[color,background-color,opacity]',
        isSelected && 'bg-bg-2 shadow-[inset_2px_0_0_var(--color-acc-ink)]',
        // The branch line stays lit while everything else recedes. Hover and
        // keyboard focus both restore a dimmed row, so the list stays
        // browsable and Tab never lands on something at 40% with no cue.
        isDimmed && 'opacity-40 hover:opacity-100 focus-visible:opacity-100',
        isOnBranchLine && !isSelected && 'bg-glass-light',
      )}
      style={{
        height: ROW_HEIGHT,
        gridTemplateColumns: `${width}px 66px minmax(0,1fr) auto`,
      }}
    >
      <GraphCell row={row} width={width} isFirst={isFirst} isLast={isLast} />

      <span className="text-ink-3 font-mono text-[11.5px]">
        {commit.shortHash}
      </span>

      <span className="flex min-w-0 items-center gap-2">
        <CommitRefs
          groups={groups}
          tint={laneColor(row.lane)}
          focusedKey={isSelected ? focusedRef : null}
          onFocusRef={onFocusRef}
        />
        {row.isMerge && (
          <span className="border-line bg-bg-2 text-ink-3 inline-flex shrink-0 items-center gap-1 rounded border px-1 font-mono text-[10px] leading-4">
            <GitPullRequest size={9} />
            merge
          </span>
        )}
        <span className="text-ink-1 min-w-0 flex-1 truncate text-[13px]">
          {commit.subject}
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-2">
        <span className="text-ink-3 text-[11px]">{commit.author}</span>
        <span className="text-ink-4 font-mono text-[11px]">
          {formatRelativeTime(commit.date)}
        </span>
      </span>
    </div>
  );
}

/** Rails continue through the separator so the graph reads as unbroken. */
function DaySeparator({
  label,
  lanes,
  width,
}: {
  label: string;
  lanes: number[];
  width: number;
}) {
  return (
    <div
      className={clsx(GRID, 'h-[30px]')}
      style={{ gridTemplateColumns: `${width}px auto 1fr` }}
    >
      <svg
        width={width}
        height={30}
        className="block shrink-0 overflow-visible"
        aria-hidden
      >
        {lanes.map((lane) => (
          <line
            key={lane}
            x1={laneX(lane)}
            y1={0}
            x2={laneX(lane)}
            y2={30}
            stroke={laneColor(lane)}
            strokeOpacity={0.55}
            strokeWidth={LANE_STROKE}
            strokeLinecap="round"
          />
        ))}
      </svg>
      <span className="text-ink-4 text-[10.5px] font-semibold tracking-[0.08em] whitespace-nowrap uppercase">
        {label}
      </span>
      <span className="bg-line-soft h-px" />
    </div>
  );
}

function SkeletonRow({ width }: { width: number }) {
  return (
    <div
      className={clsx(GRID, 'animate-pulse')}
      style={{
        height: ROW_HEIGHT,
        gridTemplateColumns: `${width}px 66px minmax(0,1fr) auto`,
      }}
    >
      <svg width={width} height={ROW_HEIGHT} className="block" aria-hidden>
        <line
          x1={laneX(0)}
          y1={0}
          x2={laneX(0)}
          y2={ROW_HEIGHT}
          stroke="var(--color-ink-3)"
          strokeOpacity={0.4}
          strokeWidth={LANE_STROKE}
          strokeLinecap="round"
        />
      </svg>
      <span className="bg-bg-3 h-[7px] rounded" />
      <span className="bg-bg-3 h-[7px] w-[38%] rounded" />
      <span className="bg-bg-2 h-[7px] w-[46px] rounded" />
    </div>
  );
}

/** Restates the active filters above the results, with one click to drop them. */
function FilterSummary({
  query,
  branches,
  matchCount,
  isCounting,
  onClear,
}: {
  query: string;
  branches: string[];
  matchCount: number | undefined;
  isCounting: boolean;
  onClear: () => void;
}) {
  return (
    <div className="border-line-soft bg-bg-1 text-ink-4 flex items-center gap-2 border-b px-3 py-1.5 text-[11.5px]">
      <span className="text-ink-2 font-mono tabular-nums">
        {isCounting ? '…' : (matchCount?.toLocaleString() ?? '0')}
      </span>
      <span>{matchCount === 1 ? 'commit' : 'commits'} matching</span>
      {branches.length > 0 && (
        <span
          title={branches.join('\n')}
          className="text-acc-ink max-w-[220px] truncate font-mono"
        >
          {branches.length === 1
            ? branches[0].replace(/^jean-claude\//, '')
            : `${branches.length} branches`}
        </span>
      )}
      {branches.length > 0 && query && <span>·</span>}
      {query && <span className="text-ink-1 truncate">“{query}”</span>}
      <div className="flex-1" />
      <button
        type="button"
        onClick={onClear}
        className="border-line bg-bg-2 text-ink-2 hover:text-ink-0 shrink-0 rounded border px-2 py-0.5 transition-colors"
      >
        Clear filters
      </button>
    </div>
  );
}

export function CommitHistory({
  commits,
  branch,
  totalCommits,
  isLoading,
  isLoadingMore,
  hasMore,
  onLoadMore,
  query,
  onQueryChange,
  selectedBranches,
  onSelectedBranchesChange,
  branches,
  matchCount,
  isCountingMatches,
  searchInputRef,
  selectedHash,
  focusedRef,
  onFocusRef,
  onSelectCommit,
}: {
  commits: ProjectGitCommit[];
  branch: string;
  totalCommits: number | undefined;
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  query: string;
  onQueryChange: (query: string) => void;
  selectedBranches: string[];
  onSelectedBranchesChange: (branches: string[]) => void;
  branches: BranchInfo[];
  /** Matches across the repository, from git — not a count of loaded rows. */
  matchCount: number | undefined;
  isCountingMatches: boolean;
  searchInputRef: React.Ref<HTMLInputElement>;
  selectedHash: string | null;
  /** Ref on the selected commit the user is focusing, null when it has none. */
  focusedRef: string | null;
  onFocusRef: (args: { hash: string; refKey: string }) => void;
  onSelectCommit: (commit: ProjectGitCommit) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const isFiltering =
    query.trim().length > 0 || selectedBranches.length > 0;

  const { rows, maxLane } = useMemo(
    () => layoutCommitLanes(commits),
    [commits],
  );
  const groups = useMemo(() => groupCommitsByDay(rows), [rows]);
  const width = LANE_ORIGIN + (maxLane + 1) * LANE_WIDTH;

  // Empty while nothing is selected, so no row is dimmed in the default view.
  //
  // With a ref focused the selection names an actual branch, so the line is
  // that branch's own history (`traceRefLine`) rather than the lane-shaped
  // guess. Commits in the middle of history carry no refs and keep the guess.
  const branchLine = useMemo(
    () =>
      focusedRef
        ? traceRefLine({ rows, hash: selectedHash, refKey: focusedRef })
        : traceBranchLine({ rows, hash: selectedHash }),
    [focusedRef, rows, selectedHash],
  );
  // Only trace when the line is a *proper subset* of what is on screen. On a
  // linear stretch of history every loaded row is one first-parent chain, so
  // the line covers everything: dimming nothing while tinting every row would
  // just leave the whole list looking permanently hovered. "All of it" is not
  // an answer to "which commits share this branch".
  //
  // Size 1 still traces — a single-commit topic branch is the case where
  // pointing it out is most useful, and squash-merge repos are full of them.
  const isTracing = branchLine.size > 0 && branchLine.size < rows.length;

  const addToast = useToastStore((state) => state.addToast);
  const { openMenu, closeMenu, portal } = useMessageContextMenu({
    overlayId: 'commit-history-context-menu',
  });

  const loadMore = useCallback(() => {
    if (isLoadingMore || !hasMore) return;
    onLoadMore();
  }, [hasMore, isLoadingMore, onLoadMore]);

  const handleScroll = useCallback(() => {
    // The menu is position:fixed and scrolling fires no mousedown, so without
    // this it stays pinned to the viewport while the rows slide underneath.
    closeMenu();
    const element = scroller.current;
    if (!element) return;
    const remaining =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    if (remaining < LOAD_MORE_THRESHOLD_PX) loadMore();
  }, [closeMenu, loadMore]);

  // A page shorter than the viewport never fires a scroll event, so infinite
  // scrolling would stall on tall panes until the user resized the window.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (element.scrollHeight <= element.clientHeight + 40) loadMore();
  }, [loadMore, rows.length]);

  // A new filter produces a different result set, so the old scroll offset is
  // meaningless — without this the pane opens somewhere in the middle of it.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [query, selectedBranches]);

  const loadedLabel = rows.length.toLocaleString();
  const totalLabel = totalCommits?.toLocaleString();

  // Copying is silent by nature — without a toast a denied clipboard
  // permission is indistinguishable from a successful copy.
  const copyWithFeedback = useCallback(
    (label: string, text: string) => {
      navigator.clipboard.writeText(text).then(
        () => addToast({ message: `Copied ${label}`, type: 'success' }),
        () => addToast({ message: `Could not copy ${label}`, type: 'error' }),
      );
    },
    [addToast],
  );

  const openCommitMenu = useCallback(
    (event: MouseEvent, commit: ProjectGitCommit) => {
      // Right-clicking a row that isn't the selected one leaves the menu with
      // no visual anchor in a dense uniform grid, so select the target first.
      onSelectCommit(commit);
      openMenu(event, [
        {
          label: 'Copy commit hash',
          icon: <Clipboard />,
          onClick: () => copyWithFeedback('commit hash', commit.hash),
        },
        {
          label: 'Copy short hash',
          icon: <Clipboard />,
          onClick: () => copyWithFeedback('short hash', commit.shortHash),
        },
        {
          // `subject` is git's %s — the first line only, so the label must not
          // promise the full message body.
          label: 'Copy commit subject',
          icon: <Clipboard />,
          onClick: () => copyWithFeedback('commit subject', commit.subject),
        },
      ]);
    },
    [copyWithFeedback, onSelectCommit, openMenu],
  );

  const clearFilters = () => {
    onQueryChange('');
    onSelectedBranchesChange([]);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2.5 px-3 pt-3.5 pb-1">
        <h3 className="text-ink-2 text-[11px] font-semibold tracking-wide uppercase">
          History
        </h3>
        <span className="text-ink-4 font-mono text-[11px] whitespace-nowrap">
          {branch}
          {totalLabel ? ` · ${totalLabel} commits` : ''}
        </span>
        <div className="flex-1" />
        <CommitSearch
          ref={searchInputRef}
          value={query}
          onChange={onQueryChange}
          count={matchCount}
          isCounting={isCountingMatches}
        />
        <BranchFilter
          branches={branches}
          selected={selectedBranches}
          onChange={onSelectedBranchesChange}
          currentBranch={branch}
        />
      </div>

      {isFiltering && (
        <FilterSummary
          query={query}
          branches={selectedBranches}
          matchCount={matchCount}
          isCounting={isCountingMatches}
          onClear={clearFilters}
        />
      )}

      <div
        ref={scroller}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto pb-2"
      >
        {isLoading && rows.length === 0 && (
          <>
            {[0, 1, 2, 3, 4].map((index) => (
              <SkeletonRow key={index} width={width} />
            ))}
          </>
        )}

        {!isLoading && rows.length === 0 && !isFiltering && (
          <p className="text-ink-3 px-3 py-2 text-xs">No commits yet.</p>
        )}

        {!isLoading && rows.length === 0 && isFiltering && (
          <div className="text-ink-4 flex flex-col items-center gap-1.5 px-6 py-16">
            <Search size={18} />
            <p className="text-ink-2 text-[13px]">No commits match</p>
            <p className="text-[11.5px]">
              Search covers commit messages and hashes.
            </p>
          </div>
        )}

        {groups.map((group, groupIndex) => (
          <div key={`${group.key}-${groupIndex}`}>
            <DaySeparator
              label={group.label}
              // The very first separator has nothing above it to connect to,
              // and a filtered list has no lane art to carry through at all.
              lanes={
                isFiltering || groupIndex === 0 ? [] : openLanesAt(group.rows[0])
              }
              width={isFiltering ? 0 : width}
            />
            {group.rows.map((row, rowIndex) =>
              isFiltering ? (
                <ResultRow
                  key={row.commit.hash}
                  commit={row.commit}
                  query={query}
                  isSelected={selectedHash === row.commit.hash}
                  focusedRef={focusedRef}
                  onFocusRef={(refKey) =>
                    onFocusRef({ hash: row.commit.hash, refKey })
                  }
                  onSelect={() => onSelectCommit(row.commit)}
                  onContextMenu={(event) => openCommitMenu(event, row.commit)}
                />
              ) : (
                <CommitRow
                  key={row.commit.hash}
                  row={row}
                  width={width}
                  isFirst={groupIndex === 0 && rowIndex === 0}
                  isLast={
                    !hasMore &&
                    groupIndex === groups.length - 1 &&
                    rowIndex === group.rows.length - 1
                  }
                  isSelected={selectedHash === row.commit.hash}
                  isOnBranchLine={
                    isTracing && branchLine.has(row.commit.hash)
                  }
                  isDimmed={isTracing && !branchLine.has(row.commit.hash)}
                  focusedRef={focusedRef}
                  onFocusRef={(refKey) =>
                    onFocusRef({ hash: row.commit.hash, refKey })
                  }
                  onSelect={() => onSelectCommit(row.commit)}
                  onContextMenu={(event) => openCommitMenu(event, row.commit)}
                />
              ),
            )}
          </div>
        ))}

        {isLoadingMore &&
          [0, 1, 2].map((index) => (
            <SkeletonRow key={`more-${index}`} width={width} />
          ))}

        {rows.length > 0 && (
          <div className="text-ink-4 flex items-center justify-center gap-2 px-3 pt-3.5 pb-5 text-[11.5px]">
            {hasMore ? (
              isLoadingMore ? (
                <span className="font-mono">loading older commits…</span>
              ) : (
                <button
                  type="button"
                  onClick={loadMore}
                  className="border-line bg-bg-2 text-ink-2 hover:text-ink-0 rounded-md border px-3 py-1 text-xs transition-colors"
                >
                  Load older commits
                </button>
              )
            ) : (
              <span className="font-mono">end of history</span>
            )}
          </div>
        )}
      </div>

      {rows.length > 0 &&
        (() => {
          // While filtering, progress is measured against the number of
          // matches; showing it against the repository total would read as
          // "12 / 4,128 loaded" for a search that only has 12 results.
          const denominator = isFiltering ? matchCount : totalCommits;
          const denominatorLabel = denominator?.toLocaleString();
          return (
            <div className="border-line-soft bg-bg-1 flex shrink-0 items-center gap-2 border-t px-3 py-[7px]">
              <span className="text-ink-4 font-mono text-[11px]">
                {denominatorLabel
                  ? `${loadedLabel} / ${denominatorLabel} loaded`
                  : `${loadedLabel} loaded`}
              </span>
              {denominator ? (
                <span className="bg-bg-3 h-[3px] max-w-[200px] flex-1 overflow-hidden rounded-sm">
                  <span
                    className="bg-acc-line block h-full"
                    style={{
                      width: `${Math.min(100, (rows.length / denominator) * 100)}%`,
                    }}
                  />
                </span>
              ) : null}
            </div>
          );
        })()}

      {portal}
    </div>
  );
}
