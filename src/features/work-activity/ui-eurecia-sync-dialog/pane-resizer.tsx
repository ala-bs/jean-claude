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
/**
 * While dragging, the live width is written straight to a CSS custom property
 * on the editor container, so resizing never re-renders the dialog. React state
 * (and localStorage) is only updated once, on mouse up.
 */
export function PaneResizer({
  edge,
  width,
  onWidthChange,
  label,
  cssVar,
  containerRef,
}: {
  edge: 'left' | 'right';
  width: number;
  onWidthChange: (width: number) => void;
  label: string;
  cssVar: string;
  containerRef: React.RefObject<HTMLElement | null>;
}) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  // Last width shown on screen, which a drag ending outside the window may not
  // have committed yet. Later interactions must start from it, not from props.
  const liveWidth = useRef<number | null>(null);
  const latest = useRef({ onWidthChange, edge, cssVar, containerRef });

  useEffect(() => {
    latest.current = { onWidthChange, edge, cssVar, containerRef };
  });

  useEffect(() => {
    const stop = () => {
      const wasDragging = drag.current !== null;
      drag.current = null;
      if (wasDragging && liveWidth.current !== null) {
        latest.current.onWidthChange(liveWidth.current);
      }
    };
    const move = (event: MouseEvent) => {
      const active = drag.current;
      if (!active) return;
      // A mouseup swallowed by another window (or the app losing focus) leaves
      // the drag armed; the next buttonless move ends it instead of resizing.
      if (event.buttons === 0) {
        stop();
        return;
      }
      event.preventDefault();
      const delta =
        latest.current.edge === 'left'
          ? event.clientX - active.startX
          : active.startX - event.clientX;
      liveWidth.current = clampPaneWidth(active.startWidth + delta);
      latest.current.containerRef.current?.style.setProperty(
        latest.current.cssVar,
        `${liveWidth.current}px`,
      );
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
      window.removeEventListener('blur', stop);
    };
  }, []);

  // Event-handler only: reading a ref during render is unsound (and would not
  // re-render on change), so `aria-valuenow` uses the committed `width` prop.
  const currentWidth = () => liveWidth.current ?? width;

  const setWidth = (next: number) => {
    liveWidth.current = next;
    latest.current.containerRef.current?.style.setProperty(cssVar, `${next}px`);
    onWidthChange(next);
  };

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
        drag.current = { startX: event.clientX, startWidth: currentWidth() };
      }}
      onDoubleClick={() => setWidth(edge === 'left' ? 224 : 268)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 32 : 8;
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          setWidth(
            clampPaneWidth(currentWidth() + (edge === 'left' ? -step : step)),
          );
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          setWidth(
            clampPaneWidth(currentWidth() + (edge === 'left' ? step : -step)),
          );
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
