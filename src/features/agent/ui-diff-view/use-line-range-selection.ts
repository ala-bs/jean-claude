import { useCallback, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import type { LineRange } from './index';

const SELECTED_ROW_CLASS = 'diff-line-range-selected';

function getLineNumberFromEvent(event: ReactMouseEvent<HTMLElement>) {
  const row = (event.target as Element | null)?.closest<HTMLElement>(
    'tr[data-new-line]',
  );
  const rawLineNumber = row?.dataset.newLine;
  if (!rawLineNumber) return null;

  const lineNumber = Number(rawLineNumber);
  return Number.isFinite(lineNumber) ? lineNumber : null;
}

export function useLineRangeSelection({
  onAddCommentClick,
}: {
  onAddCommentClick?: (lineRange: LineRange) => void;
}) {
  const tableRef = useRef<HTMLElement | null>(null);
  const selectionStartRef = useRef<number | null>(null);
  const selectionEndRef = useRef<number | null>(null);
  const selectedRowsRef = useRef<Set<HTMLElement>>(new Set());

  const clearSelectedRows = useCallback(() => {
    for (const row of selectedRowsRef.current) {
      row.classList.remove(SELECTED_ROW_CLASS);
    }
    selectedRowsRef.current.clear();
  }, []);

  const clearSelection = useCallback(() => {
    selectionStartRef.current = null;
    selectionEndRef.current = null;
    clearSelectedRows();
  }, [clearSelectedRows]);

  const paintSelection = useCallback(
    (startLine: number, endLine: number) => {
      const table = tableRef.current;
      if (!table) return;

      clearSelectedRows();

      const start = Math.min(startLine, endLine);
      const end = Math.max(startLine, endLine);

      for (const row of table.querySelectorAll<HTMLElement>('tr[data-new-line]')) {
        const lineNumber = Number(row.dataset.newLine);
        if (lineNumber >= start && lineNumber <= end) {
          row.classList.add(SELECTED_ROW_CLASS);
          selectedRowsRef.current.add(row);
        }
      }
    },
    [clearSelectedRows],
  );

  const onMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (!onAddCommentClick) return;

      const lineNumber = getLineNumberFromEvent(event);
      if (lineNumber === null) return;

      tableRef.current = event.currentTarget;
      selectionStartRef.current = lineNumber;
      selectionEndRef.current = lineNumber;
      paintSelection(lineNumber, lineNumber);
    },
    [onAddCommentClick, paintSelection],
  );

  const onMouseOver = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const startLine = selectionStartRef.current;
      if (startLine === null) return;

      const lineNumber = getLineNumberFromEvent(event);
      if (lineNumber === null || lineNumber === selectionEndRef.current) return;

      selectionEndRef.current = lineNumber;
      paintSelection(startLine, lineNumber);
    },
    [paintSelection],
  );

  const onMouseUp = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const startLine = selectionStartRef.current;
      if (!onAddCommentClick || startLine === null) {
        clearSelection();
        return;
      }

      const endLine = getLineNumberFromEvent(event);
      if (endLine === null) {
        clearSelection();
        return;
      }

      onAddCommentClick({
        start: Math.min(startLine, endLine),
        end: Math.max(startLine, endLine),
      });

      clearSelection();
    },
    [clearSelection, onAddCommentClick],
  );

  return {
    onMouseDown,
    onMouseOver,
    onMouseUp,
    onMouseLeave: clearSelection,
  };
}
