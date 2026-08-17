import { Eye, EyeOff, Layers } from 'lucide-react';
import clsx from 'clsx';

import type { ReviewedTreatment } from '@/stores/diff-review';

const TREATMENT_LABEL: Record<ReviewedTreatment, string> = {
  dim: 'Reviewed files are dimmed',
  hide: 'Reviewed files are hidden',
  bottom: 'Reviewed files are grouped at the bottom',
};

/** Review progress bar + reviewed-file treatment toggle for the diff sidebar. */
export function ReviewProgress({
  reviewedCount,
  staleCount = 0,
  totalCount,
  treatment,
  onCycleTreatment,
}: {
  reviewedCount: number;
  /** Reviewed earlier, changed since — needs another pass. */
  staleCount?: number;
  totalCount: number;
  treatment: ReviewedTreatment;
  onCycleTreatment: () => void;
}) {
  const percent = totalCount
    ? Math.round((reviewedCount / totalCount) * 100)
    : 0;
  const allDone = totalCount > 0 && reviewedCount === totalCount;
  const Icon = treatment === 'hide' ? EyeOff : treatment === 'bottom' ? Layers : Eye;

  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <div className="bg-glass-medium h-[3px] min-w-0 flex-1 overflow-hidden rounded-full">
        <div
          className="bg-status-done h-full transition-[width] duration-200"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span
        className={clsx(
          'shrink-0 font-mono text-[10.5px] tabular-nums',
          allDone ? 'text-status-done' : 'text-ink-3',
        )}
      >
        {reviewedCount}/{totalCount} reviewed
      </span>
      {staleCount > 0 && (
        <span
          className="shrink-0 bg-status-run/15 text-status-run rounded-full px-1.5 font-mono text-[9.5px]"
          title={`${staleCount} file${staleCount > 1 ? 's' : ''} changed since you reviewed ${staleCount > 1 ? 'them' : 'it'}`}
        >
          {staleCount} changed
        </span>
      )}
      <button
        onClick={onCycleTreatment}
        title={TREATMENT_LABEL[treatment]}
        aria-label={TREATMENT_LABEL[treatment]}
        className={clsx(
          'shrink-0 rounded p-1 transition-colors',
          treatment === 'dim'
            ? 'text-ink-3 hover:bg-glass-medium hover:text-ink-1'
            : 'bg-acc-soft text-acc-ink',
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
