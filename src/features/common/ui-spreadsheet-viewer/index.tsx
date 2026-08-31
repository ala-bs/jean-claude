import { useMemo, useState } from 'react';
import clsx from 'clsx';
import type { ReactNode } from 'react';

import {
  buildSheetCells,
  columnLabel,
  diffWorkbooks,
  MAX_COLS,
  MAX_ROWS,
  parseSpreadsheet,
} from './parse';
import type { DiffCell, SheetDiff, Workbook } from './parse';

/** Rows rendered per page. Keeps the DOM bounded on large sheets. */
const ROW_PAGE_SIZE = 200;

/**
 * Renders a spreadsheet (.xlsx/.xls/.ods/…) as a cell grid. When both
 * `oldBase64` and `newBase64` are supplied it renders a positional cell diff;
 * with only one side it acts as a plain viewer.
 *
 *   [Sheet1 ·12] [Sheet2]                    [x] Only changed rows
 *   ┌────┬──────────┬───────────────┐
 *   │    │    A     │      B        │
 *   │  1 │ Name     │ Qty           │
 *   │  2 │ Widget   │ 3̶  4          │  <- changed cell
 *   └────┴──────────┴───────────────┘
 */
export function SpreadsheetViewer({
  oldBase64,
  newBase64,
  isTooLarge,
  className,
}: {
  oldBase64?: string | null;
  newBase64?: string | null;
  /** Set when the main process refused to read the file because of its size. */
  isTooLarge?: boolean;
  className?: string;
}) {
  const isDiff = Boolean(oldBase64) && Boolean(newBase64);

  const parsed = useMemo(() => {
    const oldResult = oldBase64 ? parseSpreadsheet(oldBase64) : null;
    const newResult = newBase64 ? parseSpreadsheet(newBase64) : null;
    const error =
      (oldResult && !oldResult.ok ? oldResult.error : null) ??
      (newResult && !newResult.ok ? newResult.error : null);
    const oldWorkbook = oldResult?.ok ? oldResult.workbook : null;
    const newWorkbook = newResult?.ok ? newResult.workbook : null;
    return {
      error,
      oldWorkbook,
      newWorkbook,
      sheets: diffWorkbooks(oldWorkbook, newWorkbook),
    };
  }, [oldBase64, newBase64]);

  const { sheets, error, oldWorkbook, newWorkbook } = parsed;

  // Default to the first sheet that actually changed, so a 40-sheet workbook
  // doesn't open on an untouched tab.
  const defaultSheet = useMemo(
    () =>
      (sheets.find((sheet) => sheet.status !== 'unchanged') ?? sheets[0])
        ?.name ?? null,
    [sheets],
  );
  // Both selections are stored as "user overrides" and resolved during render,
  // so switching to a different workbook falls back to the defaults without an
  // effect-driven state reset.
  const [selectedSheet, setSelectedSheet] = useState<string | null>(null);
  const [onlyChangedRowsOverride, setOnlyChangedRowsOverride] = useState<
    boolean | null
  >(null);

  const onlyChangedRows = (onlyChangedRowsOverride ?? isDiff) && isDiff;
  const sheet =
    sheets.find((candidate) => candidate.name === selectedSheet) ??
    sheets.find((candidate) => candidate.name === defaultSheet) ??
    sheets[0];

  if (isTooLarge) {
    return (
      <div className="text-ink-3 flex h-full flex-col items-center justify-center gap-1 p-6 text-sm">
        <p>Spreadsheet is too large to preview.</p>
        <p className="text-xs">Open it in a spreadsheet application instead.</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-status-fail p-6 text-sm">
        Could not read spreadsheet: {error}
      </div>
    );
  }

  if (!oldBase64 && !newBase64) {
    return (
      <div className="text-ink-3 p-6 text-sm">
        Spreadsheet contents unavailable.
      </div>
    );
  }

  if (!sheet) {
    return (
      <div className="text-ink-3 p-6 text-sm">
        This spreadsheet has no sheets.
      </div>
    );
  }

  return (
    <div className={clsx('flex min-h-0 flex-col', className)}>
      <SheetTabs
        sheets={sheets}
        activeSheet={sheet.name}
        onSelect={setSelectedSheet}
        showChangeCounts={isDiff}
        trailing={
          isDiff ? (
            <label className="text-ink-3 flex shrink-0 cursor-pointer items-center gap-1.5 pr-1 text-xs select-none">
              <input
                type="checkbox"
                checked={onlyChangedRows}
                onChange={(event) =>
                  setOnlyChangedRowsOverride(event.target.checked)
                }
                className="accent-blue-500"
              />
              Only changed rows
            </label>
          ) : null
        }
      />
      {sheet.truncated && (
        <p className="border-status-run/30 bg-status-run/10 text-status-run border-b px-3 py-1.5 text-xs">
          Showing the first {Math.min(sheet.totalRowCount, MAX_ROWS)} of{' '}
          {sheet.totalRowCount} rows and{' '}
          {Math.min(sheet.totalColCount, MAX_COLS)} of {sheet.totalColCount}{' '}
          columns. Changes outside that range are not shown.
        </p>
      )}
      <SheetGrid
        key={sheet.name}
        sheet={sheet}
        oldWorkbook={oldWorkbook}
        newWorkbook={newWorkbook}
        isDiff={isDiff}
        onlyChangedRows={onlyChangedRows}
      />
    </div>
  );
}

function SheetTabs({
  sheets,
  activeSheet,
  onSelect,
  showChangeCounts,
  trailing,
}: {
  sheets: SheetDiff[];
  activeSheet: string;
  onSelect: (name: string) => void;
  showChangeCounts: boolean;
  trailing?: ReactNode;
}) {
  return (
    <div className="border-line flex items-center gap-1 border-b px-2 py-1">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {sheets.map((sheet) => {
          const isActive = sheet.name === activeSheet;
          return (
            <button
              key={sheet.name}
              type="button"
              onClick={() => onSelect(sheet.name)}
              className={clsx(
                'flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors',
                isActive
                  ? 'bg-bg-2 text-ink-1'
                  : 'text-ink-3 hover:bg-bg-1 hover:text-ink-2',
              )}
            >
              <span className="max-w-40 truncate">{sheet.name}</span>
              {showChangeCounts && sheet.status === 'added' && (
                <span className="text-status-done">new</span>
              )}
              {showChangeCounts && sheet.status === 'removed' && (
                <span className="text-status-fail">removed</span>
              )}
              {showChangeCounts && sheet.status === 'modified' && (
                <span className="text-status-run">
                  {sheet.changedCellCount}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {trailing}
    </div>
  );
}

const CELL_STATUS_CLASS: Record<DiffCell['status'], string> = {
  unchanged: '',
  added: 'bg-status-done/15 text-status-done',
  removed: 'bg-status-fail/15 text-status-fail',
  changed: 'bg-status-run/15 text-status-run',
};

function SheetGrid({
  sheet,
  oldWorkbook,
  newWorkbook,
  isDiff,
  onlyChangedRows,
}: {
  sheet: SheetDiff;
  oldWorkbook: Workbook | null;
  newWorkbook: Workbook | null;
  isDiff: boolean;
  onlyChangedRows: boolean;
}) {
  const [visibleRowCount, setVisibleRowCount] = useState(ROW_PAGE_SIZE);

  const allRowIndexes = useMemo(() => {
    if (onlyChangedRows) return sheet.changedRowIndexes;
    return Array.from({ length: sheet.rowCount }, (_, index) => index);
  }, [sheet, onlyChangedRows]);

  const rowIndexes = useMemo(
    () => allRowIndexes.slice(0, visibleRowCount),
    [allRowIndexes, visibleRowCount],
  );

  // Cells are materialized only for the rows actually rendered.
  const cells = useMemo(
    () =>
      buildSheetCells({
        oldBook: oldWorkbook,
        newBook: newWorkbook,
        name: sheet.name,
        rowIndexes,
        colCount: sheet.colCount,
      }),
    [oldWorkbook, newWorkbook, sheet.name, sheet.colCount, rowIndexes],
  );

  if (sheet.rowCount === 0) {
    return <div className="text-ink-3 p-6 text-sm">This sheet is empty.</div>;
  }

  if (rowIndexes.length === 0) {
    return (
      <div className="text-ink-3 p-6 text-sm">No cell changes in this sheet.</div>
    );
  }

  const remaining = allRowIndexes.length - rowIndexes.length;

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="border-collapse font-mono text-xs">
        <thead>
          <tr>
            <th className="border-line bg-bg-0 text-ink-4 sticky top-0 left-0 z-20 min-w-12 border px-2 py-1" />
            {Array.from({ length: sheet.colCount }, (_, col) => (
              <th
                key={col}
                className="border-line bg-bg-0 text-ink-4 sticky top-0 z-10 min-w-24 border px-2 py-1 font-normal"
              >
                {columnLabel(col)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowIndexes.map((rowIndex, renderIndex) => (
            <tr key={rowIndex}>
              <td className="border-line bg-bg-0 text-ink-4 sticky left-0 z-10 border px-2 py-1 text-right tabular-nums">
                {rowIndex + 1}
              </td>
              {cells[renderIndex]!.map((cell, colIndex) => (
                <td
                  key={colIndex}
                  className={clsx(
                    'border-line text-ink-2 max-w-80 truncate border px-2 py-1 align-top',
                    isDiff && CELL_STATUS_CLASS[cell.status],
                  )}
                  title={
                    cell.status === 'changed'
                      ? `${cell.oldText} → ${cell.newText}`
                      : cell.newText || cell.oldText
                  }
                >
                  {isDiff && cell.status === 'changed' ? (
                    <span className="flex items-baseline gap-1.5">
                      <span className="text-status-fail/70 line-through">
                        {cell.oldText}
                      </span>
                      <span>{cell.newText}</span>
                    </span>
                  ) : (
                    cell.newText || cell.oldText
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {remaining > 0 && (
        <div className="border-line flex items-center gap-3 border-t px-3 py-2">
          <button
            type="button"
            onClick={() =>
              setVisibleRowCount((count) => count + ROW_PAGE_SIZE)
            }
            className="bg-bg-2 text-ink-2 hover:bg-bg-1 rounded px-2 py-1 text-xs"
          >
            Show {Math.min(remaining, ROW_PAGE_SIZE)} more rows
          </button>
          <span className="text-ink-4 text-xs">{remaining} rows hidden</span>
        </div>
      )}
    </div>
  );
}
