import { Check, RotateCcw } from 'lucide-react';
import clsx from 'clsx';

/**
 * Tri-state "reviewed" checkbox used by the diff file tree and review bar.
 * `partial` renders a dash (some files under a folder are reviewed),
 * `stale` means it was reviewed but the file changed since.
 */
export function ReviewCheck({
  checked,
  partial = false,
  stale = false,
  onToggle,
  title,
  size = 15,
}: {
  checked: boolean;
  partial?: boolean;
  stale?: boolean;
  onToggle: (next: boolean) => void;
  title?: string;
  size?: number;
}) {
  if (stale) {
    return (
      <span
        role="checkbox"
        tabIndex={0}
        aria-checked="mixed"
        title={title ?? 'Changed since you reviewed it — review again'}
        onClick={(event) => {
          event.stopPropagation();
          event.preventDefault();
          onToggle(true);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.stopPropagation();
          event.preventDefault();
          onToggle(true);
        }}
        className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded-[3px] border border-amber-500/70 bg-amber-500/15 text-amber-400"
        style={{ width: size, height: size }}
      >
        <RotateCcw
          style={{ width: size - 6, height: size - 6 }}
          strokeWidth={2.6}
        />
      </span>
    );
  }

  return (
    <span
      role="checkbox"
      tabIndex={0}
      aria-checked={partial && !checked ? 'mixed' : checked}
      title={title ?? (checked ? 'Mark as not reviewed' : 'Mark as reviewed')}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        onToggle(!checked);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.stopPropagation();
        event.preventDefault();
        onToggle(!checked);
      }}
      className={clsx(
        'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-[3px] border transition-colors',
        checked
          ? 'border-status-done bg-status-done-soft text-status-done'
          : partial
            ? 'border-status-done bg-glass-medium text-status-done'
            : 'border-glass-border text-transparent hover:border-ink-3',
      )}
      style={{ width: size, height: size }}
    >
      {partial && !checked ? (
        <span
          className="bg-status-done rounded-full"
          style={{ width: size - 7, height: 1.5 }}
        />
      ) : (
        <Check style={{ width: size - 5, height: size - 5 }} strokeWidth={3} />
      )}
    </span>
  );
}
