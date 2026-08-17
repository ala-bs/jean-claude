import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import { createRafScheduler } from '@/lib/raf-scheduler';


/** Fixed-width columns: 2 × line-number (32px each) + divider (8px) */
const FIXED_WIDTH_PX = 32 + 32 + 8;
const MIN_FRACTION = 0.15;
const MAX_FRACTION = 0.85;

export function useDividerResize() {
  const [leftFraction, setLeftFraction] = useState(0.5);
  const [isDragging, setIsDragging] = useState(false);
  const tableRef = useRef<HTMLTableElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  const handleDividerMouseDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    let latestFraction: number | null = null;
    const updateFraction = createRafScheduler((fraction: number) => {
      latestFraction = fraction;
      const columns = tableRef.current?.querySelectorAll('col');
      if (columns && columns.length >= 6) {
        columns[2].style.width = `${fraction * 100}%`;
        columns[5].style.width = `${(1 - fraction) * 100}%`;
      }
    });

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!tableRef.current) return;
      const tableRect = tableRef.current.getBoundingClientRect();
      // Subtract fixed columns so fraction maps only to the content area
      const contentWidth = tableRect.width - FIXED_WIDTH_PX;
      if (contentWidth <= 0) return;
      const contentX = moveEvent.clientX - tableRect.left - 32; // offset past left line-number col
      const fraction = Math.min(
        MAX_FRACTION,
        Math.max(MIN_FRACTION, contentX / contentWidth),
      );
      updateFraction.schedule(fraction);
    };

    const handleMouseUp = () => {
      updateFraction.flush();
      if (latestFraction !== null) setLeftFraction(latestFraction);
      setIsDragging(false);
      dragCleanupRef.current?.();
    };
    const handleWindowBlur = () => handleMouseUp();

    dragCleanupRef.current = () => {
      updateFraction.cancel();
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('blur', handleWindowBlur);
      dragCleanupRef.current = null;
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('blur', handleWindowBlur);
  };

  return { tableRef, leftFraction, isDragging, handleDividerMouseDown };
}
