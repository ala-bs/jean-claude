import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import * as XLSX from 'xlsx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', async () =>
  vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'),
);

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('../database/repositories/projects', () => ({
  ProjectRepository: vi.fn(),
}));

vi.mock('./mcp-template-service', () => ({
  installMcpForWorktree: vi.fn(),
}));

const execFileAsync = promisify(execFile);
const fs =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const { getWorktreeFileContent, getWorktreeLocalFileContent } = await import(
  './worktree-service'
);

/** Reads a base64 xlsx back into a plain grid so assertions stay readable. */
function gridOf(base64: string | null | undefined, sheet = 'Sheet1') {
  if (!base64) return null;
  const book = XLSX.read(base64, { type: 'base64' });
  return XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[sheet]!, {
    header: 1,
    raw: false,
  });
}

describe('worktree spreadsheet content', () => {
  let dir: string;

  const git = (args: string[]) => execFileAsync('git', args, { cwd: dir });

  const writeXlsx = async (relPath: string, rows: (string | number)[][]) => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
    const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
    const full = path.join(dir, relPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buffer);
  };

  const commit = async (message: string) => {
    await git(['add', '-A']);
    await git(['commit', '-m', message]);
    const { stdout } = await git(['rev-parse', 'HEAD']);
    return stdout.trim();
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jc-xlsx-'));
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test']);
  });

  afterEach(async () => {
    if (dir) await fs.rm(dir, { force: true, recursive: true });
  });

  it('returns both sides of a modified spreadsheet as base64', async () => {
    await writeXlsx('report.xlsx', [['Name', 'Qty'], ['Widget', 3]]);
    const base = await commit('add report');
    await writeXlsx('report.xlsx', [['Name', 'Qty'], ['Widget', 4]]);
    await commit('bump qty');

    const content = await getWorktreeFileContent(
      dir,
      base,
      'report.xlsx',
      'modified',
    );

    expect(content.isBinary).toBe(true);
    expect(content.oldContent).toBeNull();
    expect(gridOf(content.oldSpreadsheetBase64)).toEqual([
      ['Name', 'Qty'],
      ['Widget', '3'],
    ]);
    expect(gridOf(content.newSpreadsheetBase64)).toEqual([
      ['Name', 'Qty'],
      ['Widget', '4'],
    ]);
  });

  it('keeps the old side of a renamed spreadsheet via originalPath', async () => {
    await writeXlsx('data.xlsx', [['a', 1]]);
    const base = await commit('add data');
    await git(['mv', 'data.xlsx', 'data-2026.xlsx']);
    await writeXlsx('data-2026.xlsx', [['a', 2]]);
    await commit('rename and edit');

    const content = await getWorktreeFileContent(
      dir,
      base,
      'data-2026.xlsx',
      'modified',
      null,
      'data.xlsx',
    );

    // Without originalPath threading, git show would miss and this would be null,
    // silently degrading the diff to a plain single-side viewer.
    expect(gridOf(content.oldSpreadsheetBase64)).toEqual([['a', '1']]);
    expect(gridOf(content.newSpreadsheetBase64)).toEqual([['a', '2']]);
  });

  it('has no new side for a deleted spreadsheet', async () => {
    await writeXlsx('gone.xlsx', [['bye']]);
    const base = await commit('add gone');
    await fs.rm(path.join(dir, 'gone.xlsx'));
    await commit('delete gone');

    const content = await getWorktreeFileContent(
      dir,
      base,
      'gone.xlsx',
      'deleted',
    );

    expect(gridOf(content.oldSpreadsheetBase64)).toEqual([['bye']]);
    expect(content.newSpreadsheetBase64).toBeNull();
  });

  it('has no old side for an added spreadsheet', async () => {
    await writeXlsx('seed.txt.xlsx', [['seed']]);
    const base = await commit('seed');
    await writeXlsx('fresh.xlsx', [['new']]);
    await commit('add fresh');

    const content = await getWorktreeFileContent(
      dir,
      base,
      'fresh.xlsx',
      'added',
    );

    expect(content.oldSpreadsheetBase64).toBeNull();
    expect(gridOf(content.newSpreadsheetBase64)).toEqual([['new']]);
  });

  it('reads unstaged local changes from the working tree', async () => {
    await writeXlsx('local.xlsx', [['v', 1]]);
    await commit('add local');
    await writeXlsx('local.xlsx', [['v', 2]]);

    const content = await getWorktreeLocalFileContent(
      dir,
      'local.xlsx',
      'modified',
      'unstaged',
    );

    expect(content.isBinary).toBe(true);
    expect(gridOf(content.oldSpreadsheetBase64)).toEqual([['v', '1']]);
    expect(gridOf(content.newSpreadsheetBase64)).toEqual([['v', '2']]);
    expect(content.spreadsheetTooLarge).toBe(false);
  });

  it('reads staged local changes from the index', async () => {
    await writeXlsx('staged.xlsx', [['s', 1]]);
    await commit('add staged');
    await writeXlsx('staged.xlsx', [['s', 2]]);
    await git(['add', 'staged.xlsx']);

    const content = await getWorktreeLocalFileContent(
      dir,
      'staged.xlsx',
      'modified',
      'staged',
    );

    expect(gridOf(content.oldSpreadsheetBase64)).toEqual([['s', '1']]);
    expect(gridOf(content.newSpreadsheetBase64)).toEqual([['s', '2']]);
  });

  it('refuses a symlink whose target escapes the worktree', async () => {
    // Without the realpath guard this would leak the outside file's bytes.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'jc-outside-'));
    try {
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        book,
        XLSX.utils.aoa_to_sheet([['secret']]),
        'Sheet1',
      );
      await fs.writeFile(
        path.join(outside, 'private.xlsx'),
        XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }),
      );
      await fs.symlink(
        path.join(outside, 'private.xlsx'),
        path.join(dir, 'leak.xlsx'),
      );

      const content = await getWorktreeLocalFileContent(
        dir,
        'leak.xlsx',
        'added',
        'unstaged',
      );

      expect(content.newSpreadsheetBase64).toBeNull();
    } finally {
      await fs.rm(outside, { force: true, recursive: true });
    }
  });

  it('rejects a path that escapes the worktree', async () => {
    await expect(
      getWorktreeLocalFileContent(
        dir,
        '../outside.xlsx',
        'modified',
        'unstaged',
      ),
    ).rejects.toThrow(/Invalid worktree file path/);
  });
});
