import { ChevronUp, Pencil } from 'lucide-react';
import clsx from 'clsx';

/**
 * One-line stand-in for the composer while reviewing a diff.
 * Clicking (or ⌘/) expands the full composer back.
 */
export function ComposerCollapsedBar({
  draft,
  queuedCount = 0,
  isRunning = false,
  modeLabel,
  modelLabel,
  onExpand,
}: {
  draft: string;
  queuedCount?: number;
  isRunning?: boolean;
  modeLabel?: string;
  modelLabel?: string;
  onExpand: () => void;
}) {
  const hasDraft = draft.trim().length > 0;
  return (
    <button
      type="button"
      onClick={onExpand}
      title="Expand composer — ⌘/"
      className={clsx(
        'bg-bg-1 hover:bg-bg-2 flex h-8 w-full cursor-text items-center gap-2 rounded-lg border pr-2 pl-3 text-left transition-colors',
        hasDraft ? 'border-acc-line' : 'border-glass-border',
      )}
    >
      <Pencil
        className={clsx(
          'h-3 w-3 shrink-0',
          hasDraft ? 'text-acc-ink' : 'text-ink-4',
        )}
      />
      <span
        className={clsx(
          'min-w-0 flex-1 truncate text-xs',
          hasDraft ? 'text-ink-1' : 'text-ink-4',
        )}
      >
        {hasDraft ? draft.trim() : 'Type to queue a follow-up…'}
      </span>
      {hasDraft && (
        <span className="text-acc-ink shrink-0 font-mono text-[10px]">draft</span>
      )}
      {queuedCount > 0 && (
        <span className="text-ink-3 shrink-0 font-mono text-[10px]">
          {queuedCount} queued
        </span>
      )}
      {(modeLabel || modelLabel) && (
        <span className="text-ink-4 hidden shrink-0 font-mono text-[10.5px] sm:inline">
          {[modeLabel, modelLabel].filter(Boolean).join(' · ')}
        </span>
      )}
      {isRunning && (
        <span className="bg-status-run h-1.5 w-1.5 shrink-0 rounded-full" />
      )}
      <kbd className="border-glass-border text-ink-4 shrink-0 rounded border px-1 font-mono text-[9.5px]">
        ⌘/
      </kbd>
      <ChevronUp className="text-ink-3 h-3 w-3 shrink-0" />
    </button>
  );
}
