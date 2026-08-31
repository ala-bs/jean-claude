import * as XLSX from 'xlsx';

export type SheetSnapshot = {
  name: string;
  /** Dense grid of formatted cell strings. Ragged rows are padded to colCount. */
  rows: string[][];
  colCount: number;
  /** Row/column counts before truncation, so the UI can say what it dropped. */
  totalRowCount: number;
  totalColCount: number;
};

export type Workbook = {
  sheets: SheetSnapshot[];
};

export type ParseResult =
  | { ok: true; workbook: Workbook }
  | { ok: false; error: string };

/** Hard caps so a runaway sheet cannot lock up the renderer. */
export const MAX_ROWS = 5000;
export const MAX_COLS = 200;

/** Converts a 0-based column index to a spreadsheet column label (A, B, ... AA). */
export function columnLabel(index: number): string {
  let label = '';
  let n = index;
  while (n >= 0) {
    label = String.fromCharCode((n % 26) + 65) + label;
    n = Math.floor(n / 26) - 1;
  }
  return label;
}

/** Trims trailing rows/columns that are entirely empty. */
function trim(rows: string[][]): { rows: string[][]; colCount: number } {
  let lastRow = -1;
  let lastCol = -1;
  rows.forEach((row, rowIndex) => {
    row.forEach((cell, colIndex) => {
      if (cell !== '') {
        lastRow = Math.max(lastRow, rowIndex);
        lastCol = Math.max(lastCol, colIndex);
      }
    });
  });
  if (lastRow === -1) return { rows: [], colCount: 0 };
  const colCount = lastCol + 1;
  const trimmed = rows.slice(0, lastRow + 1).map((row) => {
    const next = row.slice(0, colCount);
    while (next.length < colCount) next.push('');
    return next;
  });
  return { rows: trimmed, colCount };
}

function readSheet(name: string, sheet: XLSX.WorkSheet): SheetSnapshot {
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: true,
  });

  const totalRowCount = raw.length;
  const totalColCount = raw.reduce(
    (max, row) => Math.max(max, Array.isArray(row) ? row.length : 0),
    0,
  );

  const capped = raw
    .slice(0, MAX_ROWS)
    .map((row) =>
      (Array.isArray(row) ? row : [])
        .slice(0, MAX_COLS)
        .map((cell) =>
          cell === null || cell === undefined ? '' : String(cell),
        ),
    );

  const { rows, colCount } = trim(capped);
  return { name, rows, colCount, totalRowCount, totalColCount };
}

/** Parses a base64-encoded spreadsheet into a plain, serializable snapshot. */
export function parseSpreadsheet(base64: string): ParseResult {
  try {
    const book = XLSX.read(base64, { type: 'base64', cellDates: false });
    const sheets = book.SheetNames.map((name) => {
      const sheet = book.Sheets[name];
      if (!sheet) {
        return {
          name,
          rows: [],
          colCount: 0,
          totalRowCount: 0,
          totalColCount: 0,
        };
      }
      return readSheet(name, sheet);
    });
    return { ok: true, workbook: { sheets } };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to parse file',
    };
  }
}

export type CellStatus = 'unchanged' | 'added' | 'removed' | 'changed';

export type DiffCell = {
  oldText: string;
  newText: string;
  status: CellStatus;
};

/**
 * Per-sheet metadata. Deliberately holds no cell objects: a 20-sheet workbook
 * at the row/column caps would otherwise allocate millions of objects before
 * anything is painted. Cells for the *visible* sheet are built on demand by
 * buildSheetCells.
 */
export type SheetDiff = {
  name: string;
  status: 'unchanged' | 'added' | 'removed' | 'modified';
  rowCount: number;
  colCount: number;
  changedCellCount: number;
  /** Indexes of rows containing at least one change, ascending. */
  changedRowIndexes: number[];
  /** True when either side hit MAX_ROWS/MAX_COLS, so the diff may be partial. */
  truncated: boolean;
  totalRowCount: number;
  totalColCount: number;
};

function cellAt(sheet: SheetSnapshot | undefined, row: number, col: number) {
  return sheet?.rows[row]?.[col] ?? '';
}

function classify(oldText: string, newText: string): CellStatus {
  if (oldText === newText) return 'unchanged';
  if (oldText === '') return 'added';
  if (newText === '') return 'removed';
  return 'changed';
}

function sheetNames(oldBook: Workbook | null, newBook: Workbook | null) {
  const names: string[] = [];
  for (const sheet of oldBook?.sheets ?? []) names.push(sheet.name);
  for (const sheet of newBook?.sheets ?? []) {
    if (!names.includes(sheet.name)) names.push(sheet.name);
  }
  return names;
}

/**
 * Positional cell-by-cell diff between two workbooks. Sheets are matched by
 * name; cells are matched by (row, column) coordinate, which is how spreadsheet
 * tooling conventionally compares revisions of the same document.
 *
 * Returns summaries only — call buildSheetCells for the grid of a given sheet.
 */
export function diffWorkbooks(
  oldBook: Workbook | null,
  newBook: Workbook | null,
): SheetDiff[] {
  return sheetNames(oldBook, newBook).map((name) => {
    const oldSheet = oldBook?.sheets.find((sheet) => sheet.name === name);
    const newSheet = newBook?.sheets.find((sheet) => sheet.name === name);
    const rowCount = Math.max(
      oldSheet?.rows.length ?? 0,
      newSheet?.rows.length ?? 0,
    );
    const colCount = Math.max(oldSheet?.colCount ?? 0, newSheet?.colCount ?? 0);

    // String comparisons only: no per-cell object allocation on this pass.
    let changedCellCount = 0;
    const changedRowIndexes: number[] = [];
    for (let row = 0; row < rowCount; row++) {
      let rowChanged = false;
      for (let col = 0; col < colCount; col++) {
        if (cellAt(oldSheet, row, col) !== cellAt(newSheet, row, col)) {
          changedCellCount++;
          rowChanged = true;
        }
      }
      if (rowChanged) changedRowIndexes.push(row);
    }

    let status: SheetDiff['status'] = 'unchanged';
    if (!oldSheet && newSheet) status = 'added';
    else if (oldSheet && !newSheet) status = 'removed';
    else if (changedCellCount > 0) status = 'modified';

    const totalRowCount = Math.max(
      oldSheet?.totalRowCount ?? 0,
      newSheet?.totalRowCount ?? 0,
    );
    const totalColCount = Math.max(
      oldSheet?.totalColCount ?? 0,
      newSheet?.totalColCount ?? 0,
    );

    return {
      name,
      status,
      rowCount,
      colCount,
      changedCellCount,
      changedRowIndexes,
      truncated: totalRowCount > MAX_ROWS || totalColCount > MAX_COLS,
      totalRowCount,
      totalColCount,
    };
  });
}

/**
 * Builds the diff cells for the given rows of one sheet. Restricting to the
 * visible rows keeps allocation proportional to what is actually painted.
 */
export function buildSheetCells({
  oldBook,
  newBook,
  name,
  rowIndexes,
  colCount,
}: {
  oldBook: Workbook | null;
  newBook: Workbook | null;
  name: string;
  rowIndexes: number[];
  colCount: number;
}): DiffCell[][] {
  const oldSheet = oldBook?.sheets.find((sheet) => sheet.name === name);
  const newSheet = newBook?.sheets.find((sheet) => sheet.name === name);

  return rowIndexes.map((row) => {
    const line: DiffCell[] = [];
    for (let col = 0; col < colCount; col++) {
      const oldText = cellAt(oldSheet, row, col);
      const newText = cellAt(newSheet, row, col);
      line.push({ oldText, newText, status: classify(oldText, newText) });
    }
    return line;
  });
}
