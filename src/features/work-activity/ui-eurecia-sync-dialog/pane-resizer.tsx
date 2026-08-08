import { useEffect, useRef } from 'react';
import clsx from 'clsx';

export const PANE_MIN_WIDTH = 180;
export const PANE_MAX_WIDTH = 460;

export function clampPaneWidth(width: number) {
  return Math.min(PANE_MAX_WIDTH, Math.max(PANE_MIN_WIDTH, Math.round(width)));
}

/**
 * Thin drag handle between the grid and a side pane. `edge` is the side of the
 * dialog the resized pane sits on, which decides the drag direction.
 */
export function PaneResizer({
  edge,
  width,
  onWidthChange,
  label,
}: {
  edge: 'left' | 'right';
  width: number;
  onWidthChange: (width: number) => void;
  label: string;
}) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const latest = useRef({ onWidthChange, edge });

  useEffect(() => {
    latest.current = { onWidthChange, edge };
  });

  useEffect(() => {
    const move = (event: MouseEvent) => {
      const active = drag.current;
      if (!active) return;
      event.preventDefault();
      const delta =
        latest.current.edge === 'left'
          ? event.clientX - active.startX
          : active.startX - event.clientX;
      latest.current.onWidthChange(clampPaneWidth(active.startWidth + delta));
    };
    const stop = () => {
      drag.current = null;
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
    };
  }, []);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={PANE_MIN_WIDTH}
      aria-valuemax={PANE_MAX_WIDTH}
      tabIndex={0}
      onMouseDown={(event) => {
        event.preventDefault();
        drag.current = { startX: event.clientX, startWidth: width };
      }}
      onDoubleClick={() => onWidthChange(edge === 'left' ? 224 : 268)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 32 : 8;
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          onWidthChange(clampPaneWidth(width + (edge === 'left' ? -step : step)));
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          onWidthChange(clampPaneWidth(width + (edge === 'left' ? step : -step)));
        }
      }}
      className={clsx(
        'group/resizer relative w-1 shrink-0 cursor-col-resize',
        'focus-visible:outline-none',
      )}
    >
      <span className="bg-line-soft group-hover/resizer:bg-status-azure group-focus-visible/resizer:bg-status-azure absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors" />
    </div>
  );
}
