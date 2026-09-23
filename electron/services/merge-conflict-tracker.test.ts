/**
 * Integration tests against real git repositories.
 *
 * The behaviour under test is entirely about which git hooks fire and what state
 * is observable when they do, so mocking git would test nothing worth testing.
 */

import * as fs from 'node:fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { afterAll, describe, expect, it, vi } from 'vitest';

// The global setup swaps `fs/promises` for memfs, and vitest applies that to the
// `node:`-prefixed specifier too. These tests drive real `git` subprocesses, which
// only see the real filesystem, so the mock has to be undone for this file.
vi.mock('fs/promises', async () => await vi.importActual('node:fs/promises'));
vi.mock(
  'node:fs/promises',
  async () => await vi.importActual('node:fs/promises'),
);

const { captureMergeResolutions, getHeadSha, installMergeHook } = await import(
  './merge-conflict-tracker'
);

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

/** Creates a temp dir whose path is already symlink-resolved. */
async function makeTempDir(prefix: string): Promise<string> {
  // Resolved eagerly: on macOS `/var` is a symlink to `/private/var`, and git
  // reports the real path, so an unresolved temp dir would never compare equal.
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), prefix)),
  );
  tempDirs.push(dir);
  return dir;
}

/**
 * Builds a repo where `main` and `feature` both changed the same line of
 * `conflict.txt`, plus a file only `main` touched so we can assert that clean
 * incoming changes are excluded from the resolution.
 *
 * Returns a **linked worktree** with `feature` checked out, not the primary
 * checkout. The tracker deliberately refuses to install hooks outside a linked
 * worktree — running these against a plain `git init` repo would make every
 * hook assertion pass vacuously, since no hook would ever be installed.
 */
async function makeConflictingRepo(): Promise<{ repo: string; worktree: string }> {
  const repo = await makeTempDir('jc-merge-repo-');
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.email', 'test@example.com');
  await git(repo, 'config', 'user.name', 'Test');
  await git(repo, 'config', 'commit.gpgsign', 'false');

  await fs.writeFile(path.join(repo, 'conflict.txt'), 'one\ntwo\nthree\n');
  await fs.writeFile(path.join(repo, 'clean.txt'), 'untouched\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-qm', 'init');

  await git(repo, 'checkout', '-qb', 'feature');
  await fs.writeFile(path.join(repo, 'conflict.txt'), 'one\nFEATURE\nthree\n');
  await git(repo, 'commit', '-qam', 'feature change');

  await git(repo, 'checkout', '-q', 'main');
  await fs.writeFile(path.join(repo, 'conflict.txt'), 'one\nMAIN\nthree\n');
  await fs.writeFile(path.join(repo, 'clean.txt'), 'changed only on main\n');
  await git(repo, 'commit', '-qam', 'main change');

  const worktree = path.join(await makeTempDir('jc-merge-wt-'), 'wt');
  await git(repo, 'worktree', 'add', '-q', worktree, 'feature');
  return { repo, worktree };
}

/** Merges main into feature, resolves the conflict, and concludes the merge. */
async function mergeAndResolve(
  dir: string,
  { noVerify }: { noVerify: boolean },
): Promise<void> {
  await git(dir, 'merge', 'main').catch(() => {
    // Expected: the merge stops on the conflict.
  });
  await fs.writeFile(path.join(dir, 'conflict.txt'), 'one\nRESOLVED\nthree\n');
  await git(dir, 'add', 'conflict.txt');
  const args = ['commit', '-qm', 'merge main'];
  if (noVerify) args.push('--no-verify');
  await git(dir, ...args);
}

describe('captureMergeResolutions', () => {
  it('reports all four sides of a resolved conflict', async () => {
    const { worktree: dir } = await makeConflictingRepo();
    await installMergeHook(dir);
    const sinceHead = await getHeadSha(dir);

    await mergeAndResolve(dir, { noVerify: false });

    const resolutions = await captureMergeResolutions({
      worktreePath: dir,
      sinceHead,
    });

    expect(resolutions).toHaveLength(1);
    const [resolution] = resolutions;
    expect(resolution!.files).toHaveLength(1);
    const [file] = resolution!.files;
    expect(file!.filePath).toBe(path.join(dir, 'conflict.txt'));
    expect(file!.base).toBe('one\ntwo\nthree\n');
    expect(file!.ours).toBe('one\nFEATURE\nthree\n');
    expect(file!.theirs).toBe('one\nMAIN\nthree\n');
    expect(file!.resolved).toBe('one\nRESOLVED\nthree\n');
  });

  it('excludes files that merged cleanly', async () => {
    const { worktree: dir } = await makeConflictingRepo();
    await installMergeHook(dir);
    const sinceHead = await getHeadSha(dir);

    await mergeAndResolve(dir, { noVerify: false });

    const [resolution] = await captureMergeResolutions({
      worktreePath: dir,
      sinceHead,
    });
    const paths = resolution!.files.map((file) => path.basename(file.filePath));
    expect(paths).toEqual(['conflict.txt']);
  });

  it('still reports the resolution when the hook is bypassed with --no-verify', async () => {
    const { worktree: dir } = await makeConflictingRepo();
    await installMergeHook(dir);
    const sinceHead = await getHeadSha(dir);

    await mergeAndResolve(dir, { noVerify: true });

    // No hook record can exist here, so this exercises the merge-commit backfill.
    const resolutions = await captureMergeResolutions({
      worktreePath: dir,
      sinceHead,
    });
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]!.files[0]!.resolved).toBe('one\nRESOLVED\nthree\n');
  });

  it('reports the resolution from the hook record alone, with no backfill', async () => {
    const { worktree: dir } = await makeConflictingRepo();
    expect(await installMergeHook(dir)).toBe(true);

    await mergeAndResolve(dir, { noVerify: false });

    // `sinceHead: null` disables the merge-commit backfill entirely, so only the
    // hook's record can produce a result. Without this the whole hook path is
    // untested: every other case also produces a merge commit the backfill
    // finds, so the suite stays green even if the hook records nothing at all.
    const resolutions = await captureMergeResolutions({
      worktreePath: dir,
      sinceHead: null,
    });
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]!.files[0]!.resolved).toBe('one\nRESOLVED\nthree\n');
  });

  it('reports a merge only once, even though hook and backfill both see it', async () => {
    const { worktree: dir } = await makeConflictingRepo();
    await installMergeHook(dir);
    const sinceHead = await getHeadSha(dir);

    await mergeAndResolve(dir, { noVerify: false });

    const resolutions = await captureMergeResolutions({
      worktreePath: dir,
      sinceHead,
    });
    expect(resolutions).toHaveLength(1);
  });

  it('returns nothing for a turn with no merge', async () => {
    const { worktree: dir } = await makeConflictingRepo();
    await installMergeHook(dir);
    const sinceHead = await getHeadSha(dir);

    await fs.writeFile(path.join(dir, 'clean.txt'), 'ordinary edit\n');
    await git(dir, 'commit', '-qam', 'ordinary commit');

    const resolutions = await captureMergeResolutions({
      worktreePath: dir,
      sinceHead,
    });
    expect(resolutions).toEqual([]);
  });

  it('returns nothing for a merge that had no conflicts', async () => {
    const { worktree: dir } = await makeConflictingRepo();
    // Drop the conflicting commit so main fast-forwards in cleanly.
    await git(dir, 'reset', '-q', '--hard', 'HEAD~1');
    await installMergeHook(dir);
    const sinceHead = await getHeadSha(dir);

    await git(dir, 'merge', '--no-ff', '-q', '-m', 'clean merge', 'main');

    const resolutions = await captureMergeResolutions({
      worktreePath: dir,
      sinceHead,
    });
    expect(resolutions).toEqual([]);
  });
});

describe('captureMergeResolutions content', () => {
  it('reports a deleted resolution as deleted, not as unavailable', async () => {
    // Built from scratch rather than reusing the shared fixture, so md.txt is
    // the only conflict and the assertions cannot be satisfied by another file.
    const repo = await makeTempDir('jc-merge-del-');
    await git(repo, 'init', '-q', '-b', 'main');
    await git(repo, 'config', 'user.email', 'test@example.com');
    await git(repo, 'config', 'user.name', 'Test');
    await fs.writeFile(path.join(repo, 'md.txt'), 'original\nsecond line\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-qm', 'add md.txt');

    // feature modifies it; main deletes it → modify/delete conflict.
    await git(repo, 'branch', 'feature');
    await git(repo, 'rm', '-q', 'md.txt');
    await git(repo, 'commit', '-qm', 'delete md.txt');

    const dir = path.join(await makeTempDir('jc-merge-del-wt-'), 'wt');
    await git(repo, 'worktree', 'add', '-q', dir, 'feature');
    await fs.writeFile(path.join(dir, 'md.txt'), 'changed on feature\n');
    await git(dir, 'commit', '-qam', 'modify md.txt');

    const sinceHead = await getHeadSha(dir);
    await git(dir, 'merge', 'main').catch(() => {});
    // Resolve by accepting the deletion.
    await git(dir, 'rm', '-q', '-f', 'md.txt');
    await git(dir, 'commit', '-qm', 'merge main, keep deletion');

    const [resolution] = await captureMergeResolutions({
      worktreePath: dir,
      sinceHead,
    });
    const file = resolution!.files.find(
      (candidate) => path.basename(candidate.filePath) === 'md.txt',
    );
    expect(file).toBeDefined();
    // The resolved side has no blob because the file is gone — that is a
    // deletion, not content we failed to read.
    expect(file!.resolvedDeleted).toBe(true);
    expect(file!.unavailable ?? []).not.toContain('resolved');
    // Removing a file with content is a real deletion count, not +0/-0.
    expect(file!.deletions).toBeGreaterThan(0);
  });
});

describe('captureMergeResolutions scope', () => {
  it('ignores merge commits that merely arrived from the branch being merged in', async () => {
    const dir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'jc-merge-scope-')),
    );
    tempDirs.push(dir);
    await git(dir, 'init', '-q', '-b', 'main');
    await git(dir, 'config', 'user.email', 'test@example.com');
    await git(dir, 'config', 'user.name', 'Test');
    await fs.writeFile(path.join(dir, 'f.txt'), 'one\ntwo\nthree\n');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-qm', 'init');
    const fork = await git(dir, 'rev-parse', 'HEAD');

    // main gains its own conflicted merge — somebody else's PR.
    await git(dir, 'checkout', '-qb', 'pr');
    await fs.writeFile(path.join(dir, 'f.txt'), 'one\nPR\nthree\n');
    await git(dir, 'commit', '-qam', 'pr change');
    await git(dir, 'checkout', '-q', 'main');
    await fs.writeFile(path.join(dir, 'f.txt'), 'one\nMAIN\nthree\n');
    await git(dir, 'commit', '-qam', 'main change');
    await git(dir, 'merge', 'pr').catch(() => {});
    await fs.writeFile(path.join(dir, 'f.txt'), 'one\nPR-RESOLVED\nthree\n');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-qm', 'Merge PR');

    // The agent's branch forked before all of that and hits its own conflict.
    await git(dir, 'checkout', '-q', '-b', 'feature', fork);
    await fs.writeFile(path.join(dir, 'f.txt'), 'one\nFEATURE\nthree\n');
    await git(dir, 'commit', '-qam', 'feature work');
    const sinceHead = await getHeadSha(dir);
    await git(dir, 'merge', 'main').catch(() => {});
    await fs.writeFile(path.join(dir, 'f.txt'), 'one\nAGENT-RESOLVED\nthree\n');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-qm', 'Merge main');

    // "Merge PR" is now reachable from HEAD but was never the agent's work.
    // Asserting on the agent's own resolution too, so this cannot pass merely
    // because the backfill found nothing at all.
    const resolutions = await captureMergeResolutions({
      worktreePath: dir,
      sinceHead,
    });
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]!.files[0]!.resolved).toBe(
      'one\nAGENT-RESOLVED\nthree\n',
    );
    // Replaying "Merge PR" would surface the resolution *its* author committed.
    // Note the agent legitimately merged main whose tip IS that commit, so the
    // resolved content, not the label, is what separates the two.
    expect(
      resolutions.flatMap((r) => r.files).map((f) => f.resolved),
    ).not.toContain('one\nPR-RESOLVED\nthree\n');
  });
});

describe('installMergeHook', () => {
  it('refuses to touch the primary checkout', async () => {
    const { repo } = await makeConflictingRepo();

    // The primary checkout is the user's own repository. Redirecting
    // core.hooksPath there would reroute the hooks for every commit they make by
    // hand, with nothing to undo it if the app is force-quit.
    expect(await installMergeHook(repo)).toBe(false);
    await expect(
      git(repo, 'config', '--get', 'core.hooksPath'),
    ).rejects.toThrow();
  });


  it('keeps non-pre-commit hooks running', async () => {
    const { repo, worktree: dir } = await makeConflictingRepo();
    const marker = path.join(dir, 'commit-msg-ran');
    const hooksDir = path.join(repo, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(hooksDir, 'commit-msg'),
      `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`,
    );
    await fs.chmod(path.join(hooksDir, 'commit-msg'), 0o755);

    expect(await installMergeHook(dir)).toBe(true);
    await fs.writeFile(path.join(dir, 'clean.txt'), 'trigger a commit\n');
    await git(dir, 'commit', '-qam', 'commit with commit-msg hook');

    // core.hooksPath redirects every hook, not just pre-commit, so without a
    // forwarding stub this hook would silently stop running.
    await expect(fs.stat(marker)).resolves.toBeTruthy();
  });

  it('picks up a hook installed after the first install', async () => {
    const { repo, worktree: dir } = await makeConflictingRepo();
    expect(await installMergeHook(dir)).toBe(true);

    // Simulates `npx husky init` landing after we already took over.
    const marker = path.join(dir, 'late-hook-ran');
    const hooksDir = path.join(repo, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(hooksDir, 'pre-commit'),
      `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`,
    );
    await fs.chmod(path.join(hooksDir, 'pre-commit'), 0o755);

    await fs.writeFile(path.join(dir, 'clean.txt'), 'trigger a commit\n');
    await git(dir, 'commit', '-qam', 'commit after late hook install');

    await expect(fs.stat(marker)).resolves.toBeTruthy();
  });


  it('scopes core.hooksPath to the worktree rather than the shared config', async () => {
    const { worktree: dir } = await makeConflictingRepo();
    expect(await installMergeHook(dir)).toBe(true);

    const worktreeScoped = await git(
      dir,
      'config',
      '--worktree',
      '--get',
      'core.hooksPath',
    );
    expect(worktreeScoped).toContain('jean-claude');

    // The shared config must stay clean, or the user's main checkout would pick
    // up our hooks too.
    const shared = await git(dir, 'config', '--local', '--get', 'core.hooksPath')
      .catch(() => '');
    expect(shared).toBe('');
  });

  it('still runs a pre-commit hook the repository already had', async () => {
    const { repo, worktree: dir } = await makeConflictingRepo();
    const marker = path.join(dir, 'original-hook-ran');
    const hooksDir = path.join(repo, '.git', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(hooksDir, 'pre-commit'),
      `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`,
    );
    await fs.chmod(path.join(hooksDir, 'pre-commit'), 0o755);

    expect(await installMergeHook(dir)).toBe(true);
    await fs.writeFile(path.join(dir, 'clean.txt'), 'trigger a commit\n');
    await git(dir, 'commit', '-qam', 'commit with chained hook');

    await expect(fs.stat(marker)).resolves.toBeTruthy();
  });

  it('is idempotent and does not chain to itself', async () => {
    const { worktree: dir } = await makeConflictingRepo();
    expect(await installMergeHook(dir)).toBe(true);
    const first = await git(dir, 'config', '--worktree', '--get', 'core.hooksPath');
    await installMergeHook(dir);
    const second = await git(dir, 'config', '--worktree', '--get', 'core.hooksPath');
    expect(second).toBe(first);

    const script = await fs.readFile(path.join(first, 'pre-commit'), 'utf-8');
    expect(script).not.toContain(path.join(first, 'pre-commit'));

    // A commit must still succeed rather than hang in a hook loop.
    await fs.writeFile(path.join(dir, 'clean.txt'), 'after reinstall\n');
    await expect(
      git(dir, 'commit', '-qam', 'after reinstall'),
    ).resolves.toBeDefined();
  });
});
