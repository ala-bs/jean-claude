// Design §5 banner: "Claude limit reached — switched to Codex fallback · revert".
//
// Purely informational: per design §4 running steps keep their model, so the
// banner never restarts anything. For an `enforce` project (design §8) the
// fallback is refused by the main process and we show the blocking error
// instead, with no revert affordance since nothing was switched.

import { useRateLimitFallback } from '@/hooks/use-rate-limit-fallback';

export function RateLimitBanner({ projectId }: { projectId?: string | null }) {
  const { state, sourceLabel, targetLabel, revert, dismiss } =
    useRateLimitFallback({ projectId });

  if (state.kind === 'idle') return null;

  if (state.kind === 'blocked') {
    return (
      <div
        role="alert"
        className="flex items-center gap-2 border-b border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-200"
      >
        <span className="font-medium">{sourceLabel} limit reached</span>
        <span className="text-red-200/80">— {state.message}</span>
        <button
          type="button"
          data-testid="rate-limit-banner-dismiss"
          onClick={dismiss}
          className="ml-auto underline underline-offset-2 hover:text-red-100"
        >
          dismiss
        </button>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200"
    >
      <span>
        {sourceLabel} limit reached — switched to {targetLabel}
      </span>
      <span aria-hidden className="text-amber-200/50">
        ·
      </span>
      <button
        type="button"
        data-testid="rate-limit-banner-revert"
        onClick={() => void revert()}
        className="underline underline-offset-2 hover:text-amber-100"
      >
        revert
      </button>
    </div>
  );
}
