import { useCallback, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import type { LineRange } from './index';

const SELECTED_ROW_CLASS = 'diff-line-range-selected';
type SelectableLineSide = 'old' | 'new';

export interface LineRangeSelectionPosition {
  clientX: number;
  clientY: number;
}

function getLineAnchorFromEvent(event: ReactMouseEvent<HTMLElement>) {
  const row = (event.target as Element | null)?.closest<HTMLElement>(
    'tr[data-new-line],tr[data-old-line]',
  );
  const clickedSide = (event.target as Element | null)?.closest<HTMLElement>(
    '[data-line-side]',
  )?.dataset.lineSide;
  const preferOld = clickedSide === 'old' && row?.dataset.oldLine;
  const rawLineNumber = preferOld
    ? row?.dataset.oldLine
    : (row?.dataset.newLine ?? row?.dataset.oldLine);
  if (!rawLineNumber) return null;

  const lineNumber = Number(rawLineNumber);
  if (!Number.isFinite(lineNumber)) return null;

  return {
    lineNumber,
    side: (preferOld
      ? 'old'
      : row?.dataset.newLine
        ? 'new'
        : 'old') as SelectableLineSide,
  };
}

export function useLineRangeSelection({
  onAddCommentClick,
}: {
  onAddCommentClick?: (
    lineRange: LineRange,
    position: LineRangeSelectionPosition,
  ) => void;
}) {
  const tableRef = useRef<HTMLElement | null>(null);
  const selectionStartRef = useRef<number | null>(null);
  const selectionEndRef = useRef<number | null>(null);
  const selectionSideRef = useRef<SelectableLineSide>('new');
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
      const side = selectionSideRef.current;
      const selector = side === 'new' ? 'tr[data-new-line]' : 'tr[data-old-line]';
      const datasetKey = side === 'new' ? 'newLine' : 'oldLine';

      for (const row of table.querySelectorAll<HTMLElement>(selector)) {
        const lineNumber = Number(row.dataset[datasetKey]);
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
      if (event.button !== 0) return;

      const lineAnchor = getLineAnchorFromEvent(event);
      if (lineAnchor === null) return;

      tableRef.current = event.currentTarget;
      selectionStartRef.current = lineAnchor.lineNumber;
      selectionEndRef.current = lineAnchor.lineNumber;
      selectionSideRef.current = lineAnchor.side;
      paintSelection(lineAnchor.lineNumber, lineAnchor.lineNumber);
    },
    [onAddCommentClick, paintSelection],
  );

  const onMouseOver = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const startLine = selectionStartRef.current;
      if (startLine === null) return;

      const lineAnchor = getLineAnchorFromEvent(event);
      if (
        lineAnchor === null ||
        lineAnchor.side !== selectionSideRef.current ||
        lineAnchor.lineNumber === selectionEndRef.current
      ) {
        return;
      }

      selectionEndRef.current = lineAnchor.lineNumber;
      paintSelection(startLine, lineAnchor.lineNumber);
    },
    [paintSelection],
  );

  const onMouseUp = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (event.button !== 0) {
        clearSelection();
        return;
      }

      const startLine = selectionStartRef.current;
      if (!onAddCommentClick || startLine === null) {
        clearSelection();
        return;
      }

      const endAnchor = getLineAnchorFromEvent(event);
      if (endAnchor === null || endAnchor.side !== selectionSideRef.current) {
        clearSelection();
        return;
      }

      onAddCommentClick({
        start: Math.min(startLine, endAnchor.lineNumber),
        end: Math.max(startLine, endAnchor.lineNumber),
        side: selectionSideRef.current,
      }, {
        clientX: event.clientX,
        clientY: event.clientY,
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
