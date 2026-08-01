import { execFile } from 'child_process';
// Real filesystem: these tests drive an actual git repository.
import * as fs from 'node:fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The global test setup swaps `fs/promises` for memfs; these tests drive a real
// git repository, so restore the real module for this file.
vi.mock('fs/promises', async () =>
  vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'),
);

import {
  createScratchIndexPath,
  diffWorktreeTrees,
  getRepoRoot,
  removeScratchIndex,
  snapshotWorktreeTree,
} from './worktree-tree-snapshot';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf-8' });
  return stdout;
}

describe('worktree tree snapshots', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'jc-snapshot-test-'));
    await git(repo, 'init', '-b', 'main');
    await git(repo, 'config', 'user.email', 'test@example.com');
    await git(repo, 'config', 'user.name', 'Test');
    await fs.writeFile(path.join(repo, 'a.txt'), 'one\ntwo\n');
    await fs.writeFile(path.join(repo, '.gitignore'), 'ignored.txt\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-m', 'init');
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('detects modified, added and deleted files without touching the index', async () => {
    const indexBefore = await fs.readFile(path.join(repo, '.git', 'index'));
    const before = await snapshotWorktreeTree(repo);
    expect(before).toBeTruthy();

    await fs.writeFile(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    await fs.writeFile(path.join(repo, 'b.txt'), 'new\n');
    await fs.writeFile(path.join(repo, 'ignored.txt'), 'noise\n');

    const after = await snapshotWorktreeTree(repo);
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);

    const files = await diffWorktreeTrees({
      worktreePath: repo,
      before: before!,
      after: after!,
    });
    const byPath = new Map(files.map((file) => [file.filePath, file]));
    expect([...byPath.keys()].sort()).toEqual(['a.txt', 'b.txt']);
    expect(byPath.get('a.txt')?.type).toBe('update');
    expect(byPath.get('a.txt')?.additions).toBe(1);
    expect(byPath.get('a.txt')?.before).toBe('one\ntwo\n');
    expect(byPath.get('a.txt')?.after).toBe('one\ntwo\nthree\n');
    expect(byPath.get('b.txt')?.type).toBe('add');
    expect(byPath.get('b.txt')?.before).toBeUndefined();
    expect(byPath.get('b.txt')?.after).toBe('new\n');
    expect(byPath.get('b.txt')?.patch).toContain('+new');

    // The real index and HEAD must be untouched.
    const indexAfter = await fs.readFile(path.join(repo, '.git', 'index'));
    expect(indexAfter.equals(indexBefore)).toBe(true);
    expect((await git(repo, 'status', '--porcelain')).trim()).not.toBe('');
  });

  it('skips content capture for binary files', async () => {
    const before = await snapshotWorktreeTree(repo);
    await fs.writeFile(
      path.join(repo, 'blob.bin'),
      Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]),
    );
    const after = await snapshotWorktreeTree(repo);

    const files = await diffWorktreeTrees({
      worktreePath: repo,
      before: before!,
      after: after!,
    });
    const binary = files.find((file) => file.filePath === 'blob.bin');
    expect(binary).toBeDefined();
    expect(binary?.before).toBeUndefined();
    expect(binary?.after).toBeUndefined();
  });

  it('omits content when the diff exceeds the patch file cap', async () => {
    const before = await snapshotWorktreeTree(repo);
    await fs.writeFile(path.join(repo, 'x.txt'), 'x\n');
    await fs.writeFile(path.join(repo, 'y.txt'), 'y\n');
    const after = await snapshotWorktreeTree(repo);

    const files = await diffWorktreeTrees({
      worktreePath: repo,
      before: before!,
      after: after!,
      maxPatchFiles: 1,
    });
    expect(files).toHaveLength(2);
    expect(files.every((file) => file.after === undefined)).toBe(true);
  });

  it('returns no changes when nothing was modified', async () => {
    const before = await snapshotWorktreeTree(repo);
    const after = await snapshotWorktreeTree(repo);
    expect(after).toBe(before);
    expect(
      await diffWorktreeTrees({
        worktreePath: repo,
        before: before!,
        after: after!,
      }),
    ).toEqual([]);
  });

  it('reuses a scratch index across snapshots and still sees deletions', async () => {
    const indexFile = createScratchIndexPath();
    try {
      const before = await snapshotWorktreeTree(repo, indexFile);
      await fs.rm(path.join(repo, 'a.txt'));
      await fs.writeFile(path.join(repo, 'c.txt'), 'c\n');
      const after = await snapshotWorktreeTree(repo, indexFile);

      const files = await diffWorktreeTrees({
        worktreePath: repo,
        before: before!,
        after: after!,
      });
      expect(
        files.map((file) => [file.filePath, file.type]).sort(),
      ).toEqual([
        ['a.txt', 'delete'],
        ['c.txt', 'add'],
      ]);

      // Reverting to the original content must reproduce the original tree.
      await fs.writeFile(path.join(repo, 'a.txt'), 'one\ntwo\n');
      await fs.rm(path.join(repo, 'c.txt'));
      expect(await snapshotWorktreeTree(repo, indexFile)).toBe(before);
    } finally {
      await removeScratchIndex(indexFile);
    }
  });

  it('reports paths relative to the repository root, not the cwd', async () => {
    const packageDir = path.join(repo, 'packages', 'app');
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, 'x.ts'), 'x\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-m', 'add package');

    const before = await snapshotWorktreeTree(packageDir);
    await fs.writeFile(path.join(packageDir, 'x.ts'), 'x\ny\n');
    const after = await snapshotWorktreeTree(packageDir);

    const files = await diffWorktreeTrees({
      worktreePath: packageDir,
      before: before!,
      after: after!,
    });
    expect(files.map((file) => file.filePath)).toEqual(['packages/app/x.ts']);
    expect(await getRepoRoot(packageDir)).toBe(await fs.realpath(repo));
  });

  it('handles paths that git reports in quoted form', async () => {
    await fs.writeFile(path.join(repo, 'héllo wörld.txt'), 'a\n');
    const before = await snapshotWorktreeTree(repo);
    await fs.writeFile(path.join(repo, 'héllo wörld.txt'), 'a\nb\n');
    const after = await snapshotWorktreeTree(repo);

    const files = await diffWorktreeTrees({
      worktreePath: repo,
      before: before!,
      after: after!,
    });
    expect(files).toHaveLength(1);
    expect(files[0]!.filePath).toBe('héllo wörld.txt');
    expect(files[0]!.patch).toContain('+b');
  });

  it('caps the number of returned files', async () => {
    const before = await snapshotWorktreeTree(repo);
    for (let index = 0; index < 10; index += 1) {
      await fs.writeFile(path.join(repo, `f${index}.txt`), `${index}\n`);
    }
    const after = await snapshotWorktreeTree(repo);
    const files = await diffWorktreeTrees({
      worktreePath: repo,
      before: before!,
      after: after!,
      maxFiles: 4,
    });
    expect(files).toHaveLength(4);
  });

  it('returns null outside a git repository', async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'jc-plain-'));
    try {
      expect(await snapshotWorktreeTree(plain)).toBeNull();
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
  });
});
