import { BookOpen, Bug, Check, CheckSquare, FileText, Sparkles } from 'lucide-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';

import { BOARD_PRIORITY_TONES } from '@/features/work-item/utils-board-colors';

/** Azure DevOps priority chip (P1–P4); renders nothing when priority is unset. */
export function WorkItemPriorityBadge({ priority }: { priority?: number }) {
  if (typeof priority !== 'number') return null;
  const tone = BOARD_PRIORITY_TONES[priority] ?? 'var(--color-ink-2)';
  return (
    <span
      aria-label={`Priority ${priority}`}
      title={`Priority ${priority}`}
      className="shrink-0 rounded px-1.5 py-px font-mono text-[9.5px] font-semibold"
      style={{
        color: tone,
        background: `color-mix(in oklch, ${tone} 14%, transparent)`,
      }}
    >
      P{priority}
    </span>
  );
}



const ICON_SIZE = {
  sm: 'h-3 w-3',
  md: 'h-3.5 w-3.5',
} as const;

const CHECKBOX_SIZE = {
  sm: { box: 'h-3.5 w-3.5', check: 'h-2.5 w-2.5' },
  md: { box: 'h-4 w-4', check: 'h-3 w-3' },
} as const;

export function WorkItemTypeIcon({
  type,
  size = 'md',
  variant = 'default',
}: {
  type: string;
  size?: 'sm' | 'md';
  variant?: 'default' | 'editorial';
}) {
  const s = ICON_SIZE[size];
  switch (type) {
    case 'Bug':
      return <Bug className={clsx(s, 'text-status-fail shrink-0')} />;
    case 'User Story':
      return <BookOpen className={clsx(s, variant === 'editorial' ? 'text-status-review' : 'text-acc-ink', 'shrink-0')} />;
    case 'Feature':
      return <Sparkles className={clsx(s, 'text-acc-ink shrink-0')} />;
    case 'Task':
      return <CheckSquare className={clsx(s, variant === 'editorial' ? 'text-status-run' : 'text-status-done', 'shrink-0')} />;
    default:
      return <FileText className={clsx(s, 'text-ink-2 shrink-0')} />;
  }
}

export function SelectionCheckbox({
  checked,
  size = 'md',
}: {
  checked: boolean;
  size?: 'sm' | 'md';
}) {
  const s = CHECKBOX_SIZE[size];
  return (
    <div
      className={clsx(
        'flex shrink-0 items-center justify-center rounded border',
        s.box,
        checked
          ? 'border-acc bg-acc text-ink-0'
          : 'border-glass-border-strong bg-transparent',
      )}
    >
      {checked ? <Check className={s.check} /> : null}
    </div>
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getSearchTerms(search: string): string[] {
  const terms = new Set<string>();

  for (const rawTerm of search.trim().split(/\s+/)) {
    const term = rawTerm.trim();
    if (!term) continue;

    terms.add(term);

    if (term.startsWith('#') && term.length > 1) {
      terms.add(term.slice(1));
    } else if (/^\d+$/.test(term)) {
      terms.add(`#${term}`);
    }
  }

  return [...terms].sort((a, b) => b.length - a.length);
}

/**
 * `HighlightedSearchText` is rendered several times per row/card, so building
 * the term list and compiling the regex inline meant O(rows x fields) regex
 * compilations per keystroke. The search string is the same for every instance
 * in a pass, so cache the compiled pattern for the last one.
 */
const HIGHLIGHT_REGEX_CACHE_SIZE = 4;
const highlightRegexCache = new Map<string, RegExp | null>();

function getHighlightRegex(search: string): RegExp | null {
  const cached = highlightRegexCache.get(search);
  if (cached !== undefined) {
    // Re-insert so this key becomes the most recently used; without it the
    // Map's insertion order makes eviction FIFO and a still-live search string
    // gets dropped by four newer ones.
    highlightRegexCache.delete(search);
    highlightRegexCache.set(search, cached);
    return cached;
  }

  const terms = getSearchTerms(search);
  const regex =
    terms.length === 0
      ? null
      : new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');

  // A few entries rather than one: two pickers can be mounted at once (the new
  // task overlay over the task panel) with different search strings, which
  // would thrash a single slot into a permanent miss.
  if (highlightRegexCache.size >= HIGHLIGHT_REGEX_CACHE_SIZE) {
    const oldest = highlightRegexCache.keys().next().value;
    if (oldest !== undefined) highlightRegexCache.delete(oldest);
  }
  highlightRegexCache.set(search, regex);
  return regex;
}

export function HighlightedSearchText({
  text,
  search,
}: {
  text: string;
  search: string;
}) {
  const regex = getHighlightRegex(search);
  if (!regex) return text;

  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(regex)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      nodes.push(text.slice(lastIndex, index));
    }
    nodes.push(
      <mark
        key={`${index}-${match[0]}`}
        className="bg-acc/75 text-ink-0 ring-acc rounded-sm px-0.5 font-medium ring-1"
      >
        {match[0]}
      </mark>,
    );
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes.length > 0 ? nodes : text;
}
