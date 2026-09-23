import type { KeyboardEvent, ReactNode, PointerEvent as ReactPointerEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import { createRafScheduler } from '@/lib/raf-scheduler';

import {
  clampBoardWidth,
  createBoardResize,
  getKeyboardBoardWidth,
  MAX_BOARD_WIDTH,
  MIN_BOARD_WIDTH,
} from './board-split-pane-utils';

export function BoardSplitPane({
  initialBoardWidth,
  board,
  details,
  onBoardWidthCommit,
}: {
  initialBoardWidth: number;
  board: ReactNode;
  details?: ReactNode;
  onBoardWidthCommit: (width: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const boardPaneRef = useRef<HTMLDivElement>(null);
  const separatorRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    resize: ReturnType<typeof createBoardResize>;
    resizeScheduler: ReturnType<typeof createRafScheduler>;
  } | null>(null);
  const commitRef = useRef(onBoardWidthCommit);
  const [boardWidth, setBoardWidth] = useState(() => clampBoardWidth(initialBoardWidth));
  const hasDetails = details !== null && details !== undefined;

  const finishActiveResize = () => {
    const drag = dragRef.current;
    if (!drag) return;
    drag.resizeScheduler.flush();
    const width = drag.resize.finish();
    dragRef.current = null;
    const separator = separatorRef.current;
    if (separator?.hasPointerCapture(drag.pointerId)) {
      separator.releasePointerCapture(drag.pointerId);
    }
    if (width !== null) {
      setBoardWidth(width);
      commitRef.current(width);
    }
  };

  useEffect(() => {
    commitRef.current = onBoardWidthCommit;
  }, [onBoardWidthCommit]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled && !dragRef.current) {
        setBoardWidth(clampBoardWidth(initialBoardWidth));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [initialBoardWidth]);

  useEffect(() => {
    window.addEventListener('blur', finishActiveResize);
    return () => {
      window.removeEventListener('blur', finishActiveResize);
      finishActiveResize();
    };
  }, []);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || dragRef.current) return;
    event.preventDefault();
    const resizeScheduler = createRafScheduler(
      ({ clientX, containerLeft, containerWidth }: {
        clientX: number;
        containerLeft: number;
        containerWidth: number;
      }) => {
        const activeDrag = dragRef.current;
        if (!activeDrag) return;
        const width = activeDrag.resize.move({
          clientX,
          containerLeft,
          containerWidth,
        });
        if (boardPaneRef.current) {
          boardPaneRef.current.style.width = `${width}%`;
        }
        separatorRef.current?.setAttribute('aria-valuenow', `${width}`);
      },
    );
    dragRef.current = {
      pointerId: event.pointerId,
      resize: createBoardResize(boardWidth),
      resizeScheduler,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!drag || drag.pointerId !== event.pointerId || !rect || rect.width === 0) return;
    drag.resizeScheduler.schedule({
      clientX: event.clientX,
      containerLeft: rect.left,
      containerWidth: rect.width,
    });
  };

  const finishResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    finishActiveResize();
  };

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const nextWidth = getKeyboardBoardWidth(boardWidth, event.key);
    if (nextWidth === null) return;
    event.preventDefault();
    setBoardWidth(nextWidth);
    onBoardWidthCommit(nextWidth);
  };

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 overflow-hidden">
      <div
        ref={boardPaneRef}
        className={`h-full min-h-0 min-w-0 ${hasDetails ? 'shrink-0' : 'flex-1'}`}
        style={hasDetails ? { width: `${boardWidth}%` } : undefined}
      >
        {board}
      </div>
      {hasDetails && (
        <>
          <div
            ref={separatorRef}
            role="separator"
            aria-label="Resize board pane"
            aria-orientation="vertical"
            aria-valuemin={MIN_BOARD_WIDTH}
            aria-valuemax={MAX_BOARD_WIDTH}
            aria-valuenow={boardWidth}
            tabIndex={0}
            onPointerDown={startResize}
            onPointerMove={resize}
            onPointerUp={finishResize}
            onPointerCancel={finishResize}
            onLostPointerCapture={finishResize}
            onKeyDown={resizeWithKeyboard}
            className="group relative z-10 w-0 shrink-0 touch-none cursor-col-resize outline-none after:absolute after:inset-y-0 after:-inset-x-[6px] after:content-['']"
          >
            <div className="bg-line group-hover:bg-acc/50 group-focus-visible:bg-acc/50 absolute inset-y-0 left-0 w-px transition-colors" />
          </div>
          {details}
        </>
      )}
    </div>
  );
}
