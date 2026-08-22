import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';

import {
  buildSheetCells,
  columnLabel,
  diffWorkbooks,
  MAX_COLS,
  MAX_ROWS,
  parseSpreadsheet,
} from './parse';
import type { Workbook } from './parse';

/** Materializes every cell of a sheet, for assertions on the diff grid. */
function cellsOf(
  oldBook: Workbook | null,
  newBook: Workbook | null,
  name: string,
) {
  const sheet = diffWorkbooks(oldBook, newBook).find((s) => s.name === name)!;
  return buildSheetCells({
    oldBook,
    newBook,
    name,
    rowIndexes: Array.from({ length: sheet.rowCount }, (_, i) => i),
    colCount: sheet.colCount,
  });
}

/** Builds a real .xlsx file in memory and returns it as base64. */
function makeXlsx(sheets: Record<string, (string | number)[][]>): string {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(book, { type: 'base64', bookType: 'xlsx' });
}

function workbookOf(base64: string) {
  const result = parseSpreadsheet(base64);
  if (!result.ok) throw new Error(result.error);
  return result.workbook;
}

describe('columnLabel', () => {
  it('maps indexes to spreadsheet column letters', () => {
    expect(columnLabel(0)).toBe('A');
    expect(columnLabel(25)).toBe('Z');
    expect(columnLabel(26)).toBe('AA');
    expect(columnLabel(701)).toBe('ZZ');
    expect(columnLabel(702)).toBe('AAA');
  });
});

describe('parseSpreadsheet', () => {
  it('parses sheets into a dense trimmed grid', () => {
    const workbook = workbookOf(
      makeXlsx({ Sheet1: [['Name', 'Qty'], ['Widget', 3]] }),
    );

    expect(workbook.sheets).toHaveLength(1);
    expect(workbook.sheets[0]!.name).toBe('Sheet1');
    expect(workbook.sheets[0]!.colCount).toBe(2);
    expect(workbook.sheets[0]!.rows).toEqual([
      ['Name', 'Qty'],
      ['Widget', '3'],
    ]);
  });

  it('pads ragged rows so every row has colCount cells', () => {
    const workbook = workbookOf(
      makeXlsx({ Sheet1: [['a', 'b', 'c'], ['d']] }),
    );

    expect(workbook.sheets[0]!.colCount).toBe(3);
    expect(workbook.sheets[0]!.rows[1]).toEqual(['d', '', '']);
  });

  it('keeps multiple sheets in workbook order', () => {
    const workbook = workbookOf(
      makeXlsx({ First: [['1']], Second: [['2']] }),
    );

    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual([
      'First',
      'Second',
    ]);
  });

  it('returns an error instead of throwing on a corrupt workbook', () => {
    // A truncated zip: the xlsx magic bytes are there but the archive is not.
    const corrupt = Buffer.from('PKgarbage', 'binary').toString(
      'base64',
    );
    const result = parseSpreadsheet(corrupt);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeTruthy();
  });
});

describe('diffWorkbooks', () => {
  it('classifies changed, added and removed cells', () => {
    const oldBook = workbookOf(
      makeXlsx({ Sheet1: [['Name', 'Qty'], ['Widget', 3], ['Gone', 1]] }),
    );
    const newBook = workbookOf(
      makeXlsx({ Sheet1: [['Name', 'Qty'], ['Widget', 4], ['', 1]] }),
    );

    const [sheet] = diffWorkbooks(oldBook, newBook);
    expect(sheet!.status).toBe('modified');
    expect(sheet!.changedCellCount).toBe(2);
    expect(sheet!.changedRowIndexes).toEqual([1, 2]);

    const cells = cellsOf(oldBook, newBook, 'Sheet1');
    expect(cells[0]!.map((cell) => cell.status)).toEqual([
      'unchanged',
      'unchanged',
    ]);
    expect(cells[1]![1]).toMatchObject({
      oldText: '3',
      newText: '4',
      status: 'changed',
    });
    expect(cells[2]![0]).toMatchObject({
      oldText: 'Gone',
      newText: '',
      status: 'removed',
    });
  });

  it('marks a cell added when the old side was empty', () => {
    const oldBook = workbookOf(makeXlsx({ Sheet1: [['a']] }));
    const newBook = workbookOf(makeXlsx({ Sheet1: [['a', 'b']] }));

    const [sheet] = diffWorkbooks(oldBook, newBook);
    expect(sheet!.colCount).toBe(2);
    expect(cellsOf(oldBook, newBook, 'Sheet1')[0]![1]).toMatchObject({
      oldText: '',
      newText: 'b',
      status: 'added',
    });
  });

  it('pads the grid to the larger side when rows are appended', () => {
    const oldBook = workbookOf(makeXlsx({ Sheet1: [['a']] }));
    const newBook = workbookOf(makeXlsx({ Sheet1: [['a'], ['b']] }));

    const [sheet] = diffWorkbooks(oldBook, newBook);
    expect(sheet!.rowCount).toBe(2);
    expect(sheet!.changedRowIndexes).toEqual([1]);
    expect(cellsOf(oldBook, newBook, 'Sheet1')[1]![0]!.status).toBe('added');
  });

  it('reports unchanged when both sides are identical', () => {
    const base64 = makeXlsx({ Sheet1: [['a', 'b']] });
    const [sheet] = diffWorkbooks(workbookOf(base64), workbookOf(base64));

    expect(sheet!.status).toBe('unchanged');
    expect(sheet!.changedCellCount).toBe(0);
    expect(sheet!.changedRowIndexes).toEqual([]);
  });

  it('matches sheets by name and flags added/removed sheets', () => {
    const oldBook = workbookOf(makeXlsx({ Keep: [['a']], Dropped: [['x']] }));
    const newBook = workbookOf(makeXlsx({ Keep: [['a']], Fresh: [['y']] }));

    const sheets = diffWorkbooks(oldBook, newBook);
    expect(sheets.map((sheet) => [sheet.name, sheet.status])).toEqual([
      ['Keep', 'unchanged'],
      ['Dropped', 'removed'],
      ['Fresh', 'added'],
    ]);
  });

  it('surfaces a deleted spreadsheet content via the old side', () => {
    // A deleted file has no new side, so the grid falls back to oldText.
    const oldBook = workbookOf(makeXlsx({ Sheet1: [['keep', 'me']] }));

    const [sheet] = diffWorkbooks(oldBook, null);
    expect(sheet!.status).toBe('removed');
    expect(
      cellsOf(oldBook, null, 'Sheet1')[0]!.map((cell) => cell.oldText),
    ).toEqual(['keep', 'me']);
  });

  it('renders a single side as a viewer with no changes', () => {
    const newBook = workbookOf(makeXlsx({ Sheet1: [['a', 'b']] }));

    const [sheet] = diffWorkbooks(null, newBook);
    expect(sheet!.status).toBe('added');
    expect(
      cellsOf(null, newBook, 'Sheet1')[0]!.map((cell) => cell.newText),
    ).toEqual(['a', 'b']);
  });

  it('returns no sheets when both sides are missing', () => {
    expect(diffWorkbooks(null, null)).toEqual([]);
  });

  it('does not flag truncation for a small sheet', () => {
    const book = workbookOf(makeXlsx({ Sheet1: [['a']] }));
    expect(diffWorkbooks(book, book)[0]!.truncated).toBe(false);
  });
});

describe('truncation', () => {
  it('caps rows at MAX_ROWS and reports the true total', () => {
    const rows = Array.from({ length: MAX_ROWS + 250 }, (_, i) => [`r${i}`]);
    const book = workbookOf(makeXlsx({ Sheet1: rows }));

    expect(book.sheets[0]!.rows.length).toBe(MAX_ROWS);
    expect(book.sheets[0]!.totalRowCount).toBe(MAX_ROWS + 250);
    expect(diffWorkbooks(book, book)[0]!.truncated).toBe(true);
  });

  it('caps columns at MAX_COLS and reports the true total', () => {
    const wide = [Array.from({ length: MAX_COLS + 10 }, (_, i) => `c${i}`)];
    const book = workbookOf(makeXlsx({ Sheet1: wide }));

    expect(book.sheets[0]!.colCount).toBe(MAX_COLS);
    expect(book.sheets[0]!.totalColCount).toBe(MAX_COLS + 10);
    expect(diffWorkbooks(book, book)[0]!.truncated).toBe(true);
  });
});

describe('buildSheetCells', () => {
  it('only materializes the requested rows', () => {
    const book = workbookOf(
      makeXlsx({ Sheet1: [['a'], ['b'], ['c'], ['d']] }),
    );

    const cells = buildSheetCells({
      oldBook: null,
      newBook: book,
      name: 'Sheet1',
      rowIndexes: [1, 3],
      colCount: 1,
    });

    expect(cells).toHaveLength(2);
    expect(cells.map((row) => row[0]!.newText)).toEqual(['b', 'd']);
  });

  it('returns empty rows for an unknown sheet name', () => {
    const book = workbookOf(makeXlsx({ Sheet1: [['a']] }));
    const cells = buildSheetCells({
      oldBook: null,
      newBook: book,
      name: 'Nope',
      rowIndexes: [0],
      colCount: 1,
    });
    expect(cells[0]![0]).toMatchObject({ oldText: '', newText: '' });
  });
});
