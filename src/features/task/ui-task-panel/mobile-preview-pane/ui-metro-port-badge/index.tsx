import clsx from 'clsx';

/**
 * Always-visible readout of the Metro dev server port. Lives in the inspector
 * header so the port is legible from any tab (previously it was only rendered
 * inside the Metro tab's command subtitle).
 */
export function MetroPortBadge({
  port,
  isRunning,
  isStarting,
  onClick,
}: {
  port: number;
  isRunning: boolean;
  isStarting: boolean;
  onClick: () => void;
}) {
  const state = isRunning ? 'running' : isStarting ? 'starting' : 'stopped';
  const title =
    state === 'running'
      ? `Metro dev server running on http://localhost:${port}`
      : state === 'starting'
        ? `Metro dev server starting on port ${port}`
        : `Metro dev server stopped · configured port ${port}`;

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={clsx(
        'border-line bg-bg-0 hover:text-ink-1 flex shrink-0 items-center gap-1.5 rounded-md border px-1.5 py-0.5 font-mono text-[11px] transition-colors',
        state === 'running' ? 'text-ink-2' : 'text-ink-3',
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          'size-1.5 rounded-full',
          state === 'running'
            ? 'bg-green-500'
            : state === 'starting'
              ? 'bg-amber-500'
              : 'bg-ink-4',
        )}
      />
      :{port}
    </button>
  );
}
