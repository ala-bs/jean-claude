import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  buildGraphArgs,
  parseGraphLine,
  parseStatus,
} from './utils-project-git-parse';

/**
 * End-to-end checks against a real `git` binary. The unit tests cover parsing
 * of hand-written fixtures; these guard the half the type system cannot see —
 * that the arguments we actually pass produce the shape the parser expects.
 * A dropped `--decorate=full` still compiles but silently reclassifies every
 * branch, so it needs a test that runs git for real.
 *
 * The repo is built fresh per run and isolated from the developer's global
 * git config, which could otherwise perturb decoration and date formatting.
 */
describe('project git integration', () => {
  let root: string;
  let repo: string;
  let clone: string;

  const ISOLATED_GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };

  const runGit = (cwd: string, args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8', env: ISOLATED_GIT_ENV });

  const git = (...args: string[]) => runGit(repo, args);

  const identify = (dir: string) => {
    runGit(dir, ['config', 'user.email', 'test@example.com']);
    runGit(dir, ['config', 'user.name', 'Test']);
    runGit(dir, ['config', 'commit.gpgsign', 'false']);
  };

  const commit = (dir: string, file: string, message: string) => {
    writeFileSync(join(dir, file), `${file}:${message}`);
    runGit(dir, ['add', '.']);
    runGit(dir, ['commit', '--quiet', '-m', message]);
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'jc-project-git-'));
    repo = join(root, 'origin-repo');
    clone = join(root, 'clone');

    execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo], {
      encoding: 'utf-8',
      env: ISOLATED_GIT_ENV,
    });
    identify(repo);

    commit(repo, 'a.txt', 'first commit');
    git('tag', 'v1.0');

    // A local branch whose name contains a slash: the case a name-shape
    // heuristic gets wrong.
    git('checkout', '--quiet', '-b', 'team/feature');
    commit(repo, 'b.txt', 'second commit');

    // A real merge, so the connector rows the parser preserves are exercised
    // against git's actual lane art rather than a hand-written fixture.
    git('checkout', '--quiet', 'main');
    commit(repo, 'c.txt', 'main side commit');
    git('merge', '--quiet', '--no-ff', '-m', 'merge feature', 'team/feature');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Several tests below deliberately dirty the shared repo (staged files,
   * branch switches). Resetting after each keeps them order-independent, so a
   * single `.only` run behaves the same as a full run and one early failure
   * cannot cascade into the rest.
   */
  afterEach(() => {
    runGit(repo, ['checkout', '--quiet', '--force', 'main']);
    runGit(repo, ['reset', '--hard', '--quiet', 'HEAD']);
    runGit(repo, ['clean', '-qfd']);
  });

  it('classifies refs by namespace, including slash-containing branches', () => {
    const stdout = git(...buildGraphArgs({ limit: 20 }));
    const refs = stdout
      .split('\n')
      .map(parseGraphLine)
      .flatMap((row) => row?.commit?.refs ?? []);

    expect(refs).toContainEqual({
      name: 'team/feature',
      kind: 'branch',
      isHead: false,
    });
    expect(refs).toContainEqual({ name: 'main', kind: 'branch', isHead: true });
    expect(refs).toContainEqual({ name: 'v1.0', kind: 'tag', isHead: false });
  });

  it('preserves connector-only rows from a real merge', () => {
    const rows = git(...buildGraphArgs({ limit: 20 }))
      .split('\n')
      .map(parseGraphLine)
      .filter((row) => row != null);

    // git draws lane-routing rows (e.g. `|\`) around a merge that carry no
    // commit. Dropping them would misalign every row beneath.
    const connectors = rows.filter((row) => row.commit === null);
    expect(connectors.length).toBeGreaterThan(0);
    expect(connectors.every((row) => row.graph.trim().length > 0)).toBe(true);

    const merge = rows.find((row) => row.commit?.subject === 'merge feature');
    expect(merge?.commit?.parents).toHaveLength(2);
  });

  it('reads real ahead/behind counts against a remote', () => {
    execFileSync('git', ['clone', '--quiet', repo, clone], {
      encoding: 'utf-8',
      env: ISOLATED_GIT_ENV,
    });
    identify(clone);

    // Two commits only the clone has, one only the origin has.
    commit(clone, 'local-1.txt', 'local one');
    commit(clone, 'local-2.txt', 'local two');
    commit(repo, 'remote-1.txt', 'remote one');
    runGit(clone, ['fetch', '--quiet', 'origin']);

    const status = parseStatus(
      runGit(clone, ['status', '--porcelain=v2', '--branch']),
    );

    expect(status.branch).toBe('main');
    expect(status.upstream).toBe('origin/main');
    expect(status.ahead).toBe(2);
    expect(status.behind).toBe(1);
  });

  it('reports no upstream rather than a misleading zero divergence', () => {
    const status = parseStatus(
      git('status', '--porcelain=v2', '--branch', '--untracked-files=normal'),
    );

    expect(status.upstream).toBeNull();
    expect(status.ahead).toBeNull();
    expect(status.behind).toBeNull();
  });

  it('counts staged, unstaged and untracked files from a real work tree', () => {
    writeFileSync(join(repo, 'a.txt'), 'modified');
    writeFileSync(join(repo, 'staged.txt'), 'staged');
    writeFileSync(join(repo, 'untracked.txt'), 'untracked');
    git('add', 'staged.txt');

    const status = parseStatus(
      git('status', '--porcelain=v2', '--branch', '--untracked-files=normal'),
    );

    expect(status.staged).toBe(1);
    expect(status.unstaged).toBe(1);
    expect(status.untracked).toBe(1);
    expect(status.conflicted).toBe(0);
  });

  it('counts an untracked directory once, however many files it holds', () => {
    // Why the panel labels this "untracked paths": the service uses
    // `--untracked-files=normal`, which collapses a new directory into one
    // entry rather than enumerating it (that would be unbounded output).
    mkdirSync(join(repo, 'newdir'));
    for (const name of ['x.ts', 'y.ts', 'z.ts']) {
      writeFileSync(join(repo, 'newdir', name), name);
    }

    const status = parseStatus(
      git('status', '--porcelain=v2', '--branch', '--untracked-files=normal'),
    );

    expect(status.untracked).toBe(1);
  });

  /**
   * `checkoutProjectBranch` relies on a `--` terminator to stop git treating a
   * renderer-supplied string as a pathspec. Without it, `git checkout a.txt`
   * restores that file from the index — discarding uncommitted work and
   * exiting 0. These assert git's real behaviour, so the guard cannot be
   * removed without a test failing.
   */
  describe('checkout argument safety', () => {
    it('destroys uncommitted work when a path is passed WITHOUT the terminator', () => {
      writeFileSync(join(repo, 'a.txt'), 'UNCOMMITTED');

      git('checkout', 'a.txt');

      expect(readFileSync(join(repo, 'a.txt'), 'utf-8')).not.toBe(
        'UNCOMMITTED',
      );
    });

    it('refuses a path instead of destroying it WITH the terminator', () => {
      writeFileSync(join(repo, 'a.txt'), 'UNCOMMITTED');

      expect(() => git('checkout', 'a.txt', '--')).toThrow();
      expect(readFileSync(join(repo, 'a.txt'), 'utf-8')).toBe('UNCOMMITTED');
    });

    it('accepts option-like names in check-ref-format, so the dash guard is required', () => {
      // If check-ref-format rejected these, the explicit leading-dash check in
      // checkoutProjectBranch would be redundant. It does not — so removing
      // that check would reopen option injection.
      for (const name of ['-B', '-f', '--orphan', '--detach']) {
        expect(() => git('check-ref-format', `refs/heads/${name}`)).not.toThrow();
      }
    });

    it('rejects glob metacharacters, closing the branch --list glob hole', () => {
      // `git branch --list` treats its argument as a glob, so a pattern could
      // otherwise satisfy the existence check while a different ref is what
      // gets checked out. check-ref-format is what blocks that.
      expect(git('branch', '--list', 'ma*', '--format=%(refname:short)')).toContain(
        'main',
      );
      for (const pattern of ['*', 'ma*', '?ain', 'mai[n]']) {
        expect(() =>
          git('check-ref-format', `refs/heads/${pattern}`),
        ).toThrow();
      }
    });

    it('treats a leading-dash argument as an option', () => {
      // Why the service rejects names starting with '-' before calling git.
      git('checkout', '-B', 'injected-branch');
      expect(git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(
        'injected-branch',
      );
    });
  });
});
