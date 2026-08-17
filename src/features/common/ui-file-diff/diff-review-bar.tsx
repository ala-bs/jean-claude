import { ArrowDown, ArrowUp, Check, RotateCcw } from 'lucide-react';
import clsx from 'clsx';

/** Sticky bar under the diff: file position, prev/next, mark reviewed. */
export function DiffReviewBar({
  index,
  total,
  isReviewed,
  isStale = false,
  nextFileName,
  allReviewed,
  onPrev,
  onNext,
  onToggleReviewed,
}: {
  index: number;
  total: number;
  isReviewed: boolean;
  /** Reviewed before, but the file changed since. */
  isStale?: boolean;
  nextFileName?: string | null;
  allReviewed: boolean;
  onPrev: () => void;
  onNext: () => void;
  onToggleReviewed: () => void;
}) {
  return (
    <div className="border-glass-border bg-bg-1 flex h-[42px] shrink-0 items-center gap-2 border-t px-3">
      <button
        onClick={onPrev}
        disabled={index <= 0}
        title="Previous file — K"
        className="bg-glass-medium text-ink-2 hover:text-ink-0 disabled:opacity-35 flex h-6 w-6 items-center justify-center rounded transition-colors"
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={onNext}
        disabled={index >= total - 1}
        title="Next file — J"
        className="bg-glass-medium text-ink-2 hover:text-ink-0 disabled:opacity-35 flex h-6 w-6 items-center justify-center rounded transition-colors"
      >
        <ArrowDown className="h-3.5 w-3.5" />
      </button>
      <span className="text-ink-3 text-xs tabular-nums">
        file <span className="text-ink-1 font-mono">{index + 1}</span> of {total}
      </span>
      <div className="flex-1" />
      {isStale ? (
        <span className="flex items-center gap-1.5 text-status-run text-xs">
          <RotateCcw className="h-3.5 w-3.5" strokeWidth={2.6} />
          Changed since you reviewed it
        </span>
      ) : allReviewed ? (
        <span className="text-status-done flex items-center gap-1.5 text-xs">
          <Check className="h-3.5 w-3.5" strokeWidth={2.6} />
          All files reviewed
        </span>
      ) : (
        nextFileName && (
          <span className="text-ink-4 max-w-[240px] truncate text-[11px]">
            next: <span className="text-ink-3 font-mono">{nextFileName}</span>
          </span>
        )
      )}
      <button
        onClick={onToggleReviewed}
        className={clsx(
          'flex h-7 items-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors',
          isStale
            ? 'border-status-run/70 bg-status-run/15 text-status-run'
            : isReviewed
              ? 'border-glass-border text-ink-2 hover:text-ink-0'
              : 'border-status-done bg-status-done-soft text-status-done',
        )}
      >
        <Check className="h-3.5 w-3.5" strokeWidth={2.6} />
        {isStale
          ? 'Mark re-reviewed'
          : isReviewed
            ? 'Reviewed — undo'
            : 'Mark reviewed & next'}
        <kbd className="rounded border border-current/50 px-1 font-mono text-[9.5px] opacity-70">
          V
        </kbd>
      </button>
    </div>
  );
}
