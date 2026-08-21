/**
 * Spreadsheet file detection shared between the main and renderer processes.
 *
 * Spreadsheets are binary (zip/OLE) files, so they can never be rendered by the
 * text diff engine. Instead the main process ships their raw bytes to the
 * renderer as base64 and the renderer parses them into a cell grid.
 */
export const SPREADSHEET_MIME_TYPES: Record<string, string> = {
  '.xlsx':
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xlsb': 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
  '.xls': 'application/vnd.ms-excel',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
};

export const SPREADSHEET_EXTENSIONS = new Set(
  Object.keys(SPREADSHEET_MIME_TYPES),
);

/** Largest spreadsheet we are willing to base64 into the renderer (bytes). */
export const MAX_SPREADSHEET_BYTES = 15 * 1024 * 1024;

function getExtension(filePath: string): string | null {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot === -1) return null;
  return filePath.slice(lastDot).toLowerCase();
}

/** Returns the MIME type for a spreadsheet path, or null if not a spreadsheet. */
export function getSpreadsheetMimeType(filePath: string): string | null {
  const ext = getExtension(filePath);
  if (!ext) return null;
  return SPREADSHEET_MIME_TYPES[ext] ?? null;
}

/** Returns true if the file path has a spreadsheet extension. */
export function isSpreadsheetPath(filePath: string): boolean {
  const ext = getExtension(filePath);
  return ext !== null && SPREADSHEET_EXTENSIONS.has(ext);
}
