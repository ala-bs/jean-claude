import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

// The global setup swaps `fs` for an in-memory volume. These tests drive a real
// git binary against a real temp dir, so the service must see the same disk git
// does — otherwise its README write lands in memfs and `git add` finds nothing.
vi.mock('fs', async () => vi.importActual<typeof import('node:fs')>('node:fs'));
vi.mock('fs/promises', async () =>
  vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'),
);

// The service reaches Electron and the database through its import graph, not
// through anything under test here.
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('../database/repositories/projects', () => ({
  ProjectRepository: vi.fn(),
}));

vi.mock('../database', () => ({ db: {} }));

const { getProjectGitStatus, initProjectRepository } = await import(
  './project-git-service'
);

/**
 * Runs against a real `git` binary: the whole point of `initProjectRepository`
 * is the unborn-HEAD case, which no amount of mocking would reproduce
 * faithfully. Isolated from the developer's global config so a local
 * `init.defaultBranch` or gpg signing setting cannot change the outcome.
 */
describe('initProjectRepository', () => {
  let dir: string;

  const ISOLATED_GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };

  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf-8',
      env: ISOLATED_GIT_ENV,
    });

  /** Only the keys these tests touch, so the restore can be surgical. */
  const OVERRIDDEN_KEYS = [
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
    'GIT_CONFIG_NOSYSTEM',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
  ] as const;

  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jc-git-init-'));
    // `initProjectRepository` shells out through the service's own execFile,
    // which inherits this process's env — so the identity/isolation has to be
    // set here rather than passed per command. Snapshot first: vitest shares
    // one process across the files in a worker, so leaking GIT_CONFIG_GLOBAL
    // would silently reconfigure git for every test that runs after these.
    savedEnv = Object.fromEntries(
      OVERRIDDEN_KEYS.map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, ISOLATED_GIT_ENV);
  });

  afterEach(() => {
    // Restoring key-by-key rather than replacing `process.env` wholesale: the
    // object identity is shared with anything that captured a reference to it.
    for (const key of OVERRIDDEN_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('initializes a plain folder and commits a README', async () => {
    await initProjectRepository(dir);

    expect(readFileSync(join(dir, 'README.md'), 'utf-8')).toContain('#');
    expect(git('log', '--oneline').trim()).toContain('Initial commit');
    expect(git('status', '--porcelain').trim()).toBe('');
  });

  it('creates the first commit in a repo with an unborn HEAD', async () => {
    git('init', '--quiet');
    expect((await getProjectGitStatus(dir)).hasCommits).toBe(false);

    await initProjectRepository(dir);

    expect((await getProjectGitStatus(dir)).hasCommits).toBe(true);
    expect(git('log', '--oneline').trim().split('\n')).toHaveLength(1);
  });

  it('commits an existing README rather than overwriting it', async () => {
    git('init', '--quiet');
    writeFileSync(join(dir, 'README.md'), 'keep me\n');

    await initProjectRepository(dir);

    expect(readFileSync(join(dir, 'README.md'), 'utf-8')).toBe('keep me\n');
    expect(git('show', 'HEAD:README.md')).toBe('keep me\n');
  });

  it('commits only the README on an orphan branch', async () => {
    // `git checkout --orphan` is the other way to get an unborn HEAD, and it
    // leaves the previous branch's entire tree staged. An unqualified commit
    // would sweep all of it into the "initial commit".
    git('init', '--quiet');
    writeFileSync(join(dir, 'unrelated.txt'), 'do not commit me');
    git('add', '.');
    git('commit', '--quiet', '-m', 'existing');
    git('checkout', '--quiet', '--orphan', 'orphan-branch');
    expect(git('status', '--porcelain').trim()).toContain('unrelated.txt');

    await initProjectRepository(dir);

    expect(git('show', '--stat', '--oneline', 'HEAD')).toContain('README.md');
    expect(git('show', '--stat', '--oneline', 'HEAD')).not.toContain(
      'unrelated.txt',
    );
  });

  it('falls back to an empty commit when README.md is gitignored', async () => {
    // Force-adding would override a choice the user wrote into .gitignore. The
    // commit still has to happen — worktrees need something to branch from.
    git('init', '--quiet');
    writeFileSync(join(dir, '.gitignore'), 'README.md\n');

    await initProjectRepository(dir);

    expect((await getProjectGitStatus(dir)).hasCommits).toBe(true);
    expect(git('show', '--stat', '--oneline', 'HEAD')).not.toContain(
      'README.md',
    );
  });

  it('reports commits elsewhere on an orphan branch but not in a fresh repo', async () => {
    git('init', '--quiet');
    expect((await getProjectGitStatus(dir)).hasCommitsElsewhere).toBe(false);

    writeFileSync(join(dir, 'a.txt'), 'a');
    git('add', '.');
    git('commit', '--quiet', '-m', 'existing');
    git('checkout', '--quiet', '--orphan', 'orphan-branch');

    const status = await getProjectGitStatus(dir);
    expect(status.hasCommits).toBe(false);
    expect(status.hasCommitsElsewhere).toBe(true);
  });

  it('explains a missing git identity instead of leaking raw git output', async () => {
    // The service special-cases this error; without a test the regex could
    // stop matching and nobody would notice until a user hit it.
    Object.assign(process.env, {
      GIT_AUTHOR_NAME: '',
      GIT_AUTHOR_EMAIL: '',
      GIT_COMMITTER_NAME: '',
      GIT_COMMITTER_EMAIL: '',
    });

    await expect(initProjectRepository(dir)).rejects.toThrow(
      /git needs an identity/i,
    );
  });

  it('is a no-op on a repo that already has commits', async () => {
    git('init', '--quiet');
    writeFileSync(join(dir, 'a.txt'), 'a');
    git('add', '.');
    git('commit', '--quiet', '-m', 'existing');

    await initProjectRepository(dir);

    expect(git('log', '--oneline').trim().split('\n')).toHaveLength(1);
    expect(existsSync(join(dir, 'README.md'))).toBe(false);
  });
});
