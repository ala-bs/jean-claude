import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';


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

vi.mock('../lib/fs', () => ({
  isEnoent: (error: unknown) =>
    error instanceof Error &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT',
  pathExists: vi.fn(async () => true),
}));

const execFileAsync = promisify(execFile);
const fs =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const {
  getWorktreeDiff,
  getWorktreeFileContent,
  getWorktreeUnifiedDiff,
  hasUncommittedWorktreeChanges,
} = await import('./worktree-service');

let testDir: string;

async function git(args: string[], cwd = testDir) {
  return execFileAsync('git', args, { cwd, encoding: 'utf-8' });
}

async function writeFile(relativePath: string, content: string) {
  const filePath = path.join(testDir, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

async function commit(message: string) {
  await git(['add', '.']);
  await git(['commit', '-m', message]);
  const { stdout } = await git(['rev-parse', 'HEAD']);
  return stdout.trim();
}

describe('hasUncommittedWorktreeChanges', () => {
  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jc-worktree-status-'));
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test User']);
    await writeFile('tracked.txt', 'base\n');
    await commit('base');
  });

  afterEach(async () => {
    if (testDir) await fs.rm(testDir, { force: true, recursive: true });
  });

  it('detects tracked and untracked worktree changes', async () => {
    await expect(hasUncommittedWorktreeChanges(testDir)).resolves.toBe(false);

    await writeFile('tracked.txt', 'changed\n');
    await expect(hasUncommittedWorktreeChanges(testDir)).resolves.toBe(true);

    await git(['restore', 'tracked.txt']);
    await writeFile('generated/nested/untracked.txt', 'new\n');
    await expect(hasUncommittedWorktreeChanges(testDir)).resolves.toBe(true);
  });
});

describe('getWorktreeDiff', () => {
  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jc-worktree-diff-'));
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test User']);
  });

  afterEach(async () => {
    if (testDir) await fs.rm(testDir, { force: true, recursive: true });
  });

  it('uses local source branch before origin when calculating task diff', async () => {
    await writeFile('base.txt', 'base\n');
    await commit('base');
    await git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    await writeFile('source-only.txt', 'local source commit\n');
    await writeFile('task.txt', 'before\n');
    const startCommitHash = await commit('local source commit');

    await git(['switch', '-c', 'task']);
    await writeFile('task.txt', 'after\n');

    const diff = await getWorktreeDiff(testDir, startCommitHash, 'main');

    expect(diff.files).toEqual([
      {
        path: 'task.txt',
        status: 'modified',
        additions: 1,
        deletions: 1,
      },
    ]);
  });

  it('uses local source branch for refs/remotes/origin source ref', async () => {
    await writeFile('base.txt', 'base\n');
    await commit('base');

    await writeFile('remote-only.txt', 'remote\n');
    const remoteCommit = await commit('remote source commit');
    await git(['update-ref', 'refs/remotes/origin/main', remoteCommit]);

    await git(['reset', '--hard', 'HEAD^']);
    await writeFile('local-only.txt', 'local\n');
    await writeFile('task.txt', 'before\n');
    const startCommitHash = await commit('local source commit');

    await git(['switch', '-c', 'task']);
    await writeFile('task.txt', 'after\n');

    const diff = await getWorktreeDiff(
      testDir,
      startCommitHash,
      'refs/remotes/origin/main',
    );

    expect(diff.files.map((file) => file.path)).toEqual(['task.txt']);
  });

  it('uses local source branch for refs/heads source ref', async () => {
    await writeFile('base.txt', 'base\n');
    await commit('base');
    await git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    await writeFile('source-only.txt', 'local source commit\n');
    await writeFile('task.txt', 'before\n');
    const startCommitHash = await commit('local source commit');

    await git(['switch', '-c', 'task']);
    await writeFile('task.txt', 'after\n');

    const diff = await getWorktreeDiff(
      testDir,
      startCommitHash,
      'refs/heads/main',
    );

    expect(diff.files.map((file) => file.path)).toEqual(['task.txt']);
  });

  it('uses remote source branch when local branch is absent', async () => {
    await writeFile('base.txt', 'base\n');
    await writeFile('task.txt', 'before\n');
    const startCommitHash = await commit('remote source commit');
    await git(['update-ref', 'refs/remotes/origin/main', startCommitHash]);

    await git(['switch', '-c', 'task']);
    await git(['branch', '-D', 'main']);
    await writeFile('task.txt', 'after\n');

    const diff = await getWorktreeDiff(testDir, startCommitHash, 'origin/main');

    expect(diff.files.map((file) => file.path)).toEqual(['task.txt']);
  });

  it('preserves non-origin remote names in qualified source refs', async () => {
    await writeFile('task.txt', 'before\n');
    const startCommitHash = await commit('remote source commit');
    await git(['remote', 'add', 'upstream', testDir]);
    await git(['update-ref', 'refs/remotes/upstream/main', startCommitHash]);
    await git(['switch', '-c', 'task']);
    await git(['branch', '-D', 'main']);
    await writeFile('task.txt', 'after\n');

    const qualifiedDiff = await getWorktreeDiff(
      testDir,
      startCommitHash,
      'refs/remotes/upstream/main',
    );
    const shorthandDiff = await getWorktreeDiff(
      testDir,
      startCommitHash,
      'upstream/main',
    );

    expect(qualifiedDiff.files.map((file) => file.path)).toEqual(['task.txt']);
    expect(shorthandDiff.files.map((file) => file.path)).toEqual(['task.txt']);
  });

  it('prefers an exact local branch over ambiguous remote shorthand', async () => {
    await writeFile('task.txt', 'before\n');
    const baseCommit = await commit('base');
    await git(['remote', 'add', 'upstream', testDir]);

    await git(['switch', '-c', 'remote-source']);
    await writeFile('remote-only.txt', 'remote\n');
    const remoteCommit = await commit('remote change');
    await git(['update-ref', 'refs/remotes/upstream/development', remoteCommit]);

    await git(['switch', '-c', 'upstream/development', baseCommit]);
    await writeFile('task.txt', 'local source\n');
    const startCommitHash = await commit('local source change');
    await git(['switch', '-c', 'task']);
    await git(['merge', '--no-edit', 'refs/remotes/upstream/development']);
    await writeFile('task.txt', 'task change\n');

    const diff = await getWorktreeDiff(
      testDir,
      startCommitHash,
      'upstream/development',
    );

    expect(diff.files.map((file) => file.path)).toEqual([
      'remote-only.txt',
      'task.txt',
    ]);
  });

  it('falls back to start commit when source refs are absent', async () => {
    await writeFile('task.txt', 'before\n');
    const startCommitHash = await commit('base');
    await git(['switch', '-c', 'task']);
    await writeFile('task.txt', 'after\n');

    const diff = await getWorktreeDiff(
      testDir,
      startCommitHash,
      'missing-source',
    );

    expect(diff.files.map((file) => file.path)).toEqual(['task.txt']);
  });

  it('uses nearest source merge-base after task absorbs remote updates', async () => {
    await writeFile('task.txt', 'before\n');
    const startCommitHash = await commit('local source commit');

    await git(['switch', '-c', 'task']);
    await writeFile('task.txt', 'task commit\n');
    await commit('task change');
    await git(['switch', '-c', 'remote-source', 'main']);
    await writeFile('source-only.txt', 'remote source change\n');
    const remoteCommit = await commit('remote source commit');
    await git(['update-ref', 'refs/remotes/origin/main', remoteCommit]);

    await git(['switch', 'task']);
    await git(['branch', '-D', 'remote-source']);
    await git(['merge', '--no-edit', 'refs/remotes/origin/main']);
    await writeFile('task.txt', 'working tree change\n');

    const diff = await getWorktreeDiff(testDir, startCommitHash, 'main');

    expect(diff.files.map((file) => file.path)).toEqual(['task.txt']);
  });

  it('does not interpret a malformed source branch as a Git option', async () => {
    await writeFile('staged.txt', 'before\n');
    await writeFile('unstaged.txt', 'before\n');
    const startCommitHash = await commit('base');
    await git(['switch', '-c', 'task']);
    await writeFile('staged.txt', 'after\n');
    await git(['add', 'staged.txt']);
    await writeFile('unstaged.txt', 'after\n');

    const diff = await getWorktreeDiff(
      testDir,
      startCommitHash,
      'origin/--cached',
    );

    expect(diff.files.map((file) => file.path)).toEqual([
      'staged.txt',
      'unstaged.txt',
    ]);
  });

  it('hides changes merged from the source branch', async () => {
    await writeFile('base.txt', 'base\n');
    await writeFile('task.txt', 'before\n');
    const startCommitHash = await commit('base');

    await git(['switch', '-c', 'task']);
    await writeFile('task.txt', 'after\n');
    await commit('task change');

    await git(['switch', 'main']);
    await writeFile('source-only.txt', 'source branch change\n');
    await commit('source change');

    await git(['switch', 'task']);
    await git(['merge', '--no-edit', 'main']);

    const diff = await getWorktreeDiff(testDir, startCommitHash, 'main');

    expect(diff.files).toEqual([
      {
        path: 'task.txt',
        status: 'modified',
        additions: 1,
        deletions: 1,
      },
    ]);
  });
});

describe('remote-qualified source baselines', () => {
  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jc-worktree-diff-'));
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test User']);

    await writeFile('task.txt', 'remote\n');
    const remoteCommit = await commit('remote source commit');
    await git(['update-ref', 'refs/remotes/origin/main', remoteCommit]);
    await writeFile('remote-only.txt', 'remote\n');
    await commit('remote-only source commit');
    await git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    await git(['reset', '--hard', remoteCommit]);
    await writeFile('task.txt', 'local\n');
    await writeFile('local-only.txt', 'local\n');
    await commit('local source commit');
    await git(['switch', '-c', 'task']);
    await writeFile('task.txt', 'task\n');
  });

  afterEach(async () => {
    if (testDir) await fs.rm(testDir, { force: true, recursive: true });
  });

  it('uses local baseline for file content', async () => {
    const { stdout } = await git(['rev-parse', 'refs/heads/main']);
    const content = await getWorktreeFileContent(
      testDir,
      stdout.trim(),
      'task.txt',
      'modified',
      'refs/remotes/origin/main',
    );

    expect(content.oldContent).toBe('local\n');
    expect(content.newContent).toBe('task\n');
  });

  it('uses one local baseline and filter for unified diff', async () => {
    const { stdout } = await git(['rev-parse', 'refs/heads/main']);
    const diff = await getWorktreeUnifiedDiff(
      testDir,
      stdout.trim(),
      'refs/remotes/origin/main',
    );

    expect(diff).toContain('-local');
    expect(diff).toContain('+task');
    expect(diff).not.toContain('local-only.txt');
    expect(diff).not.toContain('remote-only.txt');
  });
});
