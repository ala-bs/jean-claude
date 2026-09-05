import { useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';

import {
  buildLineToRowMapping,
  computeHunks,
  getHunkDataLineIndex,
} from './use-change-navigator';
import type { DiffLine } from './diff-utils';

/**
 * Distance from the top of the pane to leave above the first change.
 *
 * The scroll container has `pt-12` (48px) to clear the floating change-navigator
 * and search overlays, plus 8px of breathing room. Because the scroll container
 * is the first in-flow child of the positioned wrapper, `row.offsetTop` already
 * includes that 48px of padding, so subtracting this value lands the row just
 * below the overlays. (`useChangeNavigator` relies on the same layout invariant.)
 */
const OVERLAY_OFFSET_PX = 56;

/**
 * On first render of a file's diff, scroll the container to the first change so
 * the user doesn't land on unrelated leading context lines.
 *
 * Fires once per (file, view mode). Not every call site keys `DiffView` by file
 * path — and React Query cache hits can skip the loading state that would
 * otherwise unmount it — so the guard is reset on `filePath` change rather than
 * relying on remounts.
 *
 * Skipped entirely when an explicit `scrollToLine` target was provided, to avoid
 * fighting that scroll.
 */
export function useScrollToFirstChange({
  enabled,
  filePath,
  lines,
  scrollContainerRef,
  viewMode,
  oldString,
  newString,
  hiddenLines,
}: {
  enabled: boolean;
  filePath: string;
  lines: DiffLine[] | undefined;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  viewMode: 'inline' | 'side-by-side' | 'current-state';
  oldString: string;
  newString: string;
  /** New-file line numbers currently hidden by collapsed folds. */
  hiddenLines: Set<number>;
}) {
  const targetKey = `${filePath}::${viewMode}`;
  const scrolledForRef = useRef<string | null>(null);
  const foldsHydratedRef = useRef(false);

  // Side-by-side needs a DiffLine -> row index mapping, which re-diffs the whole
  // file. Memoize so it doesn't run on every render (and never inside the rAF).
  const lineToRowMap = useMemo(
    () =>
      viewMode === 'side-by-side'
        ? buildLineToRowMapping(oldString, newString)
        : null,
    [viewMode, oldString, newString],
  );

  const firstHunk = useMemo(
    () => (lines ? computeHunks(lines)[0] : undefined),
    [lines],
  );

  useEffect(() => {
    if (!enabled || !lines || !firstHunk) return;

    const container = scrollContainerRef.current;
    if (!container) return;

    // Fold ranges arrive asynchronously over IPC, so persisted collapsed folds
    // only take effect after the first paint. When that happens, rows above the
    // first change disappear and the offset we computed is stale — allow exactly
    // one corrective re-scroll on that initial hydration, but not on subsequent
    // (user-driven) fold toggles.
    const foldsHydrated = hiddenLines.size > 0;
    const isFoldHydration = foldsHydrated && !foldsHydratedRef.current;
    if (foldsHydrated) foldsHydratedRef.current = true;

    if (scrolledForRef.current === targetKey && !isFoldHydration) return;

    const frame = window.requestAnimationFrame(() => {
      const dataIndex = getHunkDataLineIndex({
        hunkStartLineIndex: firstHunk.startLineIndex,
        lines,
        viewMode,
        lineToRowMap,
      });
      if (dataIndex === null) return;

      const row = container.querySelector<HTMLElement>(
        `[data-line-index="${dataIndex}"]`,
      );
      // Row can be absent when the first change sits inside a collapsed fold.
      // Leave the guard unset so a later fold change retries.
      if (!row) return;

      scrolledForRef.current = targetKey;
      container.scrollTop = Math.max(0, row.offsetTop - OVERLAY_OFFSET_PX);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    enabled,
    targetKey,
    lines,
    firstHunk,
    scrollContainerRef,
    viewMode,
    lineToRowMap,
    hiddenLines,
  ]);
}
