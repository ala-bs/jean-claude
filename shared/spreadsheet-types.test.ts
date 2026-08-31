import { describe, expect, it } from 'vitest';

import { getSpreadsheetMimeType, isSpreadsheetPath } from './spreadsheet-types';

describe('isSpreadsheetPath', () => {
  it('accepts spreadsheet extensions regardless of case', () => {
    expect(isSpreadsheetPath('data/report.xlsx')).toBe(true);
    expect(isSpreadsheetPath('REPORT.XLSX')).toBe(true);
    expect(isSpreadsheetPath('legacy.xls')).toBe(true);
    expect(isSpreadsheetPath('macros.xlsm')).toBe(true);
    expect(isSpreadsheetPath('binary.xlsb')).toBe(true);
    expect(isSpreadsheetPath('open.ods')).toBe(true);
  });

  it('rejects non-spreadsheets and extensionless paths', () => {
    expect(isSpreadsheetPath('src/index.ts')).toBe(false);
    expect(isSpreadsheetPath('notes.csv')).toBe(false);
    expect(isSpreadsheetPath('Makefile')).toBe(false);
    expect(isSpreadsheetPath('dir.xlsx/inner')).toBe(false);
  });
});

describe('getSpreadsheetMimeType', () => {
  it('returns the OOXML mime type for xlsx', () => {
    expect(getSpreadsheetMimeType('a.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('returns null for non-spreadsheets', () => {
    expect(getSpreadsheetMimeType('a.png')).toBeNull();
    expect(getSpreadsheetMimeType('a')).toBeNull();
  });
});
