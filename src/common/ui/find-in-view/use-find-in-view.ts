import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';

const HIGHLIGHT_NAME = 'jc-find-match';
const CURRENT_HIGHLIGHT_NAME = 'jc-find-match-current';

/**
 * `CSS.highlights` is a single global registry and `::highlight()` rules must
 * name a static identifier, so highlights cannot be scoped per instance. More
 * than one find bar painting at once is meaningless anyway, so instances
 * arbitrate: opening one closes every other, and only the owner may paint or
 * clear. Without this, a details view opened over a board preview would have
 * both instances writing (and wiping) the same two highlight names.
 */
const instances = new Map<string, () => void>();
let activeOwner: string | null = null;

const EMPTY_RANGES: Range[] = [];

// `Highlight` / `CSS.highlights` are not in the ambient TS DOM lib yet.
type HighlightRegistry = {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
};

function getHighlightRegistry(): HighlightRegistry | null {
  const registry = (CSS as unknown as { highlights?: HighlightRegistry })
    .highlights;
  return registry ?? null;
}

function createHighlight(ranges: Range[]): unknown | null {
  const HighlightCtor = (
    window as unknown as {
      Highlight?: new (...ranges: Range[]) => unknown;
    }
  ).Highlight;
  if (!HighlightCtor) return null;
  return new HighlightCtor(...ranges);
}

function clearHighlights() {
  const registry = getHighlightRegistry();
  if (!registry) return;
  registry.delete(HIGHLIGHT_NAME);
  registry.delete(CURRENT_HIGHLIGHT_NAME);
}

/**
 * Collect every visible text node inside `root`, skipping anything opted out
 * with `data-find-in-view-ignore`.
 */
function collectTextNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('[data-find-in-view-ignore]')) {
        return NodeFilter.FILTER_REJECT;
      }
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA') {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let current = walker.nextNode();
  while (current) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }
  return nodes;
}

function findRanges({
  root,
  query,
}: {
  root: HTMLElement;
  query: string;
}): Range[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const ranges: Range[] = [];
  for (const node of collectTextNodes(root)) {
    const haystack = (node.nodeValue ?? '').toLowerCase();
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + needle.length);
      ranges.push(range);
      index = haystack.indexOf(needle, index + needle.length);
    }
  }
  return ranges;
}

/**
 * Structural equality. Rescans triggered by unrelated DOM churn usually produce
 * an identical result; returning the previous array keeps the paint effect from
 * re-running and, more importantly, keeps the rescan from feeding itself.
 */
function rangesEqual(a: Range[], b: Range[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((range, index) => {
    const other = b[index];
    return (
      range.startContainer === other.startContainer &&
      range.startOffset === other.startOffset &&
      range.endContainer === other.endContainer &&
      range.endOffset === other.endOffset
    );
  });
}

/**
 * Scroll the match into view *within its own scroll container only*.
 * `Element.scrollIntoView()` would walk every scrollable ancestor and can shift
 * the whole app shell, so adjust `scrollTop` directly instead.
 */
function scrollRangeIntoView({
  range,
  container,
}: {
  range: Range;
  container: HTMLElement;
}) {
  const rect = range.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  // happy-dom and detached nodes report an empty rect; nothing to scroll to.
  if (rect.height === 0 && rect.width === 0) return;
  if (rect.top >= containerRect.top && rect.bottom <= containerRect.bottom) {
    return;
  }
  container.scrollTop +=
    rect.top - containerRect.top - container.clientHeight / 2 + rect.height / 2;
}

/**
 * Find-in-view over arbitrary rendered content (markdown, rich HTML, ...).
 *
 * Matches are painted with the CSS Custom Highlight API, so the React-owned DOM
 * is never mutated — that is what makes it safe on top of react-markdown output.
 *
 * Render the search bar OUTSIDE the element `containerRef` points at: the
 * container is watched by a MutationObserver, and a bar inside it would observe
 * its own "N of M" updates.
 */
export function useFindInView({
  containerRef,
  inputRef,
  enabled = true,
  /** Changing this re-runs the search (e.g. when the work item or tab changes). */
  contentKey,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  /** Ref to the search bar, focused when the bar opens. Owned by the caller. */
  inputRef: React.RefObject<{ focus: () => void } | null>;
  enabled?: boolean;
  contentKey?: string;
}) {
  const id = useId();
  const [isOpenRequested, setIsOpenRequested] = useState(false);
  const [query, setQuery] = useState('');
  // Derived, not an effect: losing `enabled` (e.g. the full details modal opens
  // over this preview pane) must close immediately, or the bar keeps its Escape
  // listener and swallows Escape for whatever took over.
  const isOpen = enabled && isOpenRequested;
  const [scanned, setScanned] = useState<Range[]>([]);
  const [rawMatchIndex, setRawMatchIndex] = useState(0);

  // Derived rather than cleared from an effect, so closing the bar or emptying
  // the query never leaves a stale count behind for a render.
  const ranges = isOpen && query ? scanned : EMPTY_RANGES;
  const matchCount = ranges.length;
  // A rescan can shrink the result set under the cursor; clamp on read.
  const currentMatchIndex =
    matchCount === 0 ? 0 : Math.min(rawMatchIndex, matchCount - 1);

  const close = useCallback(() => {
    setIsOpenRequested(false);
    setQuery('');
    setScanned([]);
    setRawMatchIndex(0);
    if (activeOwner === id) {
      activeOwner = null;
      clearHighlights();
    }
  }, [id]);

  const open = useCallback(() => {
    for (const [otherId, forceClose] of instances) {
      if (otherId !== id) forceClose();
    }
    activeOwner = id;
    flushSync(() => setIsOpenRequested(true));
    inputRef.current?.focus();
  }, [id, inputRef]);

  // Publish this instance so a newly opened one can close it.
  useEffect(() => {
    instances.set(id, close);
    return () => {
      instances.delete(id);
      if (activeOwner === id) {
        activeOwner = null;
        clearHighlights();
      }
    };
  }, [id, close]);

  // Recompute matches whenever the query or the underlying content changes.
  useEffect(() => {
    const root = containerRef.current;
    if (!isOpen || !root || !query) return;

    let frame = 0;
    const scan = () => {
      frame = 0;
      const next = findRanges({ root, query });
      // Structural equality keeps an unchanged rescan from re-rendering — which
      // is also what stops the observer below from feeding itself.
      setScanned((previous) => (rangesEqual(previous, next) ? previous : next));
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(scan);
    };

    schedule();

    // Images and lazily rendered markdown reflow after the first pass; coalesce
    // bursts of mutations into one rescan per frame.
    const observer = new MutationObserver(schedule);
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [containerRef, isOpen, query, contentKey]);

  // Paint highlights and scroll the active match into view. Depends on `ranges`
  // itself (not just the count) so a rescan that yields the same number of
  // different matches still repaints instead of leaving detached Ranges up.
  useEffect(() => {
    if (activeOwner !== id) return;
    if (!isOpen) {
      // Disabled or closed: give up ownership so another instance can paint.
      activeOwner = null;
      clearHighlights();
      return;
    }
    const registry = getHighlightRegistry();
    if (!registry) return;
    if (ranges.length === 0) {
      clearHighlights();
      return;
    }

    const current = ranges[currentMatchIndex];
    const others = ranges.filter((_, index) => index !== currentMatchIndex);

    const allHighlight = createHighlight(others);
    if (allHighlight) registry.set(HIGHLIGHT_NAME, allHighlight);
    else registry.delete(HIGHLIGHT_NAME);

    if (current) {
      const currentHighlight = createHighlight([current]);
      if (currentHighlight) {
        registry.set(CURRENT_HIGHLIGHT_NAME, currentHighlight);
      }
      const container = containerRef.current;
      if (container) scrollRangeIntoView({ range: current, container });
    }
  }, [id, containerRef, isOpen, ranges, currentMatchIndex]);

  const goToNextMatch = useCallback(() => {
    setRawMatchIndex((previous) =>
      matchCount === 0 ? 0 : (previous + 1) % matchCount,
    );
  }, [matchCount]);

  const goToPreviousMatch = useCallback(() => {
    setRawMatchIndex((previous) =>
      matchCount === 0 ? 0 : (previous - 1 + matchCount) % matchCount,
    );
  }, [matchCount]);

  // While the bar is open, Escape closes the search *first* — it must never
  // reach the modal / details view underneath and close the whole thing.
  //
  // This listener is on `window`, not `document`, on purpose. `Modal` and the
  // keyboard-bindings context both listen on `document` in the capture phase,
  // and among listeners on the same target in the same phase the winner is
  // whoever registered first — which is the modal, since it opens before the
  // search bar does. `window` is the first node in the capture path, so it is
  // strictly earlier than anything on `document` regardless of registration
  // order. preventDefault() additionally trips Modal's `defaultPrevented` guard.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [isOpen, close]);

  // Cmd/Ctrl+F opens the bar while this view is mounted.
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        event.stopPropagation();
        open();
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [enabled, open]);

  return useMemo(
    () => ({
      isOpen,
      query,
      setQuery,
      matchCount,
      /** 1-based, for display. */
      currentMatch: matchCount === 0 ? 0 : currentMatchIndex + 1,
      open,
      close,
      goToNextMatch,
      goToPreviousMatch,
    }),
    [
      isOpen,
      query,
      matchCount,
      currentMatchIndex,
      open,
      close,
      goToNextMatch,
      goToPreviousMatch,
    ],
  );
}
