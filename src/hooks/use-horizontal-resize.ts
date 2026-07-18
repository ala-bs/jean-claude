import type { MouseEvent as ReactMouseEvent, RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';

import { createRafScheduler } from '@/lib/raf-scheduler';

interface UseHorizontalResizeOptions {
  initialWidth: number;
  minWidth: number;
  maxWidthFraction?: number; // Fraction of container width (e.g., 0.5 for 50%)
  maxWidth?: number; // Absolute max width (takes precedence over maxWidthFraction if smaller)
  direction?: 'left' | 'right'; // Which direction increases width ('right' = drag right to grow, 'left' = drag left to grow)
  onWidthChange: (width: number) => void;
  resizeTargetRef?: RefObject<HTMLDivElement | null>;
}

export function useHorizontalResize({
  initialWidth,
  minWidth,
  maxWidthFraction = 0.5,
  maxWidth: maxWidthAbsolute,
  direction = 'right',
  onWidthChange,
  resizeTargetRef,
}: UseHorizontalResizeOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  const handleMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);

      const startX = e.clientX;
      const containerWidth = containerRef.current
        ? containerRef.current.offsetWidth
        : window.innerWidth;
      const fractionMax = containerWidth * maxWidthFraction;
      const effectiveMax =
        maxWidthAbsolute !== undefined
          ? Math.min(fractionMax, maxWidthAbsolute)
          : fractionMax;
      const startWidth = Math.min(
        Math.max(initialWidth, minWidth),
        effectiveMax,
      );
      const directionMultiplier = direction === 'right' ? 1 : -1;
      const target = resizeTargetRef?.current ?? e.currentTarget.parentElement;
      let latestWidth: number | null = null;
      const updateWidth = createRafScheduler((newWidth: number) => {
        latestWidth = newWidth;
        if (target) target.style.width = `${newWidth}px`;
      });

      const handleMouseMove = (moveEvent: MouseEvent | ReactMouseEvent) => {
        const delta = (moveEvent.clientX - startX) * directionMultiplier;
        const containerWidth = containerRef.current
          ? containerRef.current.offsetWidth
          : window.innerWidth;
        const fractionMax = containerWidth * maxWidthFraction;
        const effectiveMax =
          maxWidthAbsolute !== undefined
            ? Math.min(fractionMax, maxWidthAbsolute)
            : fractionMax;
        const newWidth = Math.min(
          Math.max(startWidth + delta, minWidth),
          effectiveMax,
        );
        updateWidth.schedule(newWidth);
      };

      const handleMouseUp = () => {
        updateWidth.flush();
        if (latestWidth !== null) onWidthChange(latestWidth);
        setIsDragging(false);
        dragCleanupRef.current?.();
      };
      const handleWindowBlur = () => handleMouseUp();

      dragCleanupRef.current = () => {
        updateWidth.cancel();
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        window.removeEventListener('blur', handleWindowBlur);
        dragCleanupRef.current = null;
      };
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      window.addEventListener('blur', handleWindowBlur);
  };

  return {
    containerRef,
    isDragging,
    handleMouseDown,
  };
}
