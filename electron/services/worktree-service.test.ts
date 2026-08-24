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

const execFileAsync = promisify(execFile);
const fs =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const {
  cleanupMissingWorktree,
  cleanupWorktree,
  getDiffBaseInfo,
  getWorktreeDiff,
  getWorktreeFileContent,
  getWorktreeUnifiedDiff,
  hasUncommittedWorktreeChanges,
  hasUnpushedWorktreeCommits,
  mergeWorktree,
  pullBranch,
  renameWorktreeBranch,
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
    vi.unstubAllEnvs();
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

  it('returns false when the worktree was deleted', async () => {
    await fs.rm(testDir, { recursive: true });

    await expect(hasUncommittedWorktreeChanges(testDir)).resolves.toBe(false);
  });

  it('rejects when git is missing but the worktree exists', async () => {
    vi.stubEnv('PATH', '');

    await expect(hasUncommittedWorktreeChanges(testDir)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('hasUnpushedWorktreeCommits', () => {
  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jc-worktree-ahead-'));
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test User']);
    await writeFile('tracked.txt', 'base\n');
    await commit('base');
    await git(['branch', 'upstream']);
    await git(['branch', '--set-upstream-to=upstream', 'main']);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (testDir) await fs.rm(testDir, { force: true, recursive: true });
  });

  it('detects commits ahead of the upstream branch', async () => {
    await expect(hasUnpushedWorktreeCommits(testDir)).resolves.toBe(false);

    await writeFile('tracked.txt', 'changed\n');
    await commit('local change');

    await expect(hasUnpushedWorktreeCommits(testDir)).resolves.toBe(true);
  });

  it('treats commits without an upstream branch as unpushed', async () => {
    await git(['branch', '--unset-upstream']);

    await expect(hasUnpushedWorktreeCommits(testDir)).resolves.toBe(true);
  });

  it('does not mark a branch as unpushed when a remote ref contains HEAD', async () => {
    await git(['branch', '--unset-upstream']);
    await git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    await expect(hasUnpushedWorktreeCommits(testDir)).resolves.toBe(false);
  });

  it('rejects when git is missing but the worktree exists', async () => {
    vi.stubEnv('PATH', '');

    await expect(hasUnpushedWorktreeCommits(testDir)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('worktree cleanup branch safety', () => {
  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jc-worktree-cleanup-'));
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test User']);
    await writeFile('base.txt', 'base\n');
    await commit('base');
  });

  afterEach(async () => {
    if (testDir) await fs.rm(testDir, { force: true, recursive: true });
  });

  it('rejects persisted branch mismatch before removing worktree', async () => {
    const worktreePath = path.join(testDir, 'review-worktree');
    await git(['branch', 'actual-review']);
    await git(['branch', 'persisted-wrong']);
    await git(['worktree', 'add', worktreePath, 'actual-review']);

    await expect(
      cleanupWorktree({
        worktreePath,
        projectPath: testDir,
        branchName: 'persisted-wrong',
        branchCleanup: 'delete',
        force: true,
      }),
    ).rejects.toThrow('branch');

    await expect(fs.stat(worktreePath)).resolves.toBeDefined();
    const { stdout } = await git(['branch', '--list', 'persisted-wrong']);
    expect(stdout).toContain('persisted-wrong');
  });

  it('surfaces git output when branch verification fails, and preserves the branch', async () => {
    const worktreePath = path.join(testDir, 'broken-worktree');
    await git(['branch', 'feature-work']);
    await git(['worktree', 'add', worktreePath, 'feature-work']);
    // Point the worktree's .git file at a missing admin dir so `git rev-parse` fails.
    await fs.writeFile(
      path.join(worktreePath, '.git'),
      'gitdir: /nonexistent/jc-worktree-admin\n',
    );

    await expect(
      cleanupWorktree({
        worktreePath,
        projectPath: testDir,
        branchName: 'feature-work',
        branchCleanup: 'delete',
        force: true,
      }),
    ).rejects.toThrow(/Failed to verify worktree branch before delete.*broken-worktree/s);

    const { stdout } = await git(['branch', '--list', 'feature-work']);
    expect(stdout).toContain('feature-work');
  });

  it('does not delete arbitrary branch for missing registered worktree mismatch', async () => {
    const worktreePath = path.join(testDir, 'missing-review-worktree');
    await git(['branch', 'actual-review']);
    await git(['branch', 'persisted-wrong']);
    await git(['worktree', 'add', worktreePath, 'actual-review']);
    await fs.rm(worktreePath, { recursive: true });

    await expect(
      cleanupMissingWorktree({
        worktreePath,
        projectPath: testDir,
        branchName: 'persisted-wrong',
        throwOnError: true,
      }),
    ).rejects.toThrow('branch');

    const { stdout } = await git(['branch', '--list', 'persisted-wrong']);
    expect(stdout).toContain('persisted-wrong');
  });

  it('deletes matching branch for a missing registered worktree', async () => {
    const worktreePath = path.join(testDir, 'missing-matching-worktree');
    await git(['branch', 'actual-review']);
    await git(['worktree', 'add', worktreePath, 'actual-review']);
    await fs.rm(worktreePath, { recursive: true });

    await cleanupMissingWorktree({
      worktreePath,
      projectPath: testDir,
      branchName: 'actual-review',
      throwOnError: true,
    });

    const { stdout } = await git(['branch', '--list', 'actual-review']);
    expect(stdout).toBe('');
  });

  it('retries branch deletion after verified worktree removal', async () => {
    const worktreePath = path.join(testDir, 'removed-review-worktree');
    await git(['branch', 'verified-review']);
    await git(['worktree', 'add', worktreePath, 'verified-review']);
    await git(['worktree', 'remove', '--force', worktreePath]);

    await cleanupMissingWorktree({
      worktreePath,
      projectPath: testDir,
      branchName: 'verified-review',
      throwOnError: true,
      allowUnregistered: true,
    });

    const { stdout } = await git(['branch', '--list', 'verified-review']);
    expect(stdout).toBe('');
  });

  it('successfully merges and deletes worktree branch', async () => {
    const worktreePath = path.join(testDir, 'merge-worktree');
    await git(['branch', 'feature-merge']);
    await git(['worktree', 'add', worktreePath, 'feature-merge']);
    await fs.writeFile(path.join(worktreePath, 'feature.txt'), 'feature\n');
    await git(['add', '.'], worktreePath);
    await git(['commit', '-m', 'feature'], worktreePath);

    await expect(
      mergeWorktree({
        worktreePath,
        projectPath: testDir,
        targetBranch: 'main',
      }),
    ).resolves.toEqual({ success: true });
    await expect(fs.stat(worktreePath)).rejects.toThrow();
    const { stdout } = await git(['branch', '--list', 'feature-merge']);
    expect(stdout).toBe('');
  });
});

describe('getDiffBaseInfo', () => {
  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jc-diff-base-'));
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test User']);
    await writeFile('base.txt', 'base\n');
    await commit('base');
  });

  afterEach(async () => {
    if (testDir) await fs.rm(testDir, { force: true, recursive: true });
  });

  it('reports headIsMergedIntoSource when the branch adds nothing to source', async () => {
    await git(['switch', '-c', 'task']);

    const info = await getDiffBaseInfo(testDir, 'unused', 'main');

    expect(info.sourceRef).toBe('refs/heads/main');
    expect(info.baseCommit).toBe(info.headCommit);
    expect(info.headIsMergedIntoSource).toBe(true);
  });

  it('reports headIsMergedIntoSource false when the branch has its own commits', async () => {
    await git(['switch', '-c', 'task']);
    await writeFile('task.txt', 'task\n');
    await commit('task work');

    const info = await getDiffBaseInfo(testDir, 'unused', 'main');

    expect(info.baseCommit).not.toBe(info.headCommit);
    expect(info.headIsMergedIntoSource).toBe(false);
  });

  it('never claims merged-into-source when no source ref resolves', async () => {
    const { stdout } = await git(['rev-parse', 'HEAD']);
    const head = stdout.trim();

    // No sourceBranch → baseCommit falls back to startCommitHash, which here
    // equals HEAD. That must NOT be reported as "already merged into source".
    const info = await getDiffBaseInfo(testDir, head, null);

    expect(info.sourceRef).toBeNull();
    expect(info.baseCommit).toBe(head);
    expect(info.headCommit).toBe(head);
    expect(info.headIsMergedIntoSource).toBe(false);
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

describe('pullBranch', () => {
  let remoteDir: string;

  beforeEach(async () => {
    remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jc-pull-remote-'));
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jc-pull-local-'));

    await execFileAsync('git', ['init', '--bare', '-b', 'main', remoteDir]);
    await git(['clone', remoteDir, testDir], os.tmpdir());
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test User']);
    await writeFile('tracked.txt', 'base\n');
    await commit('base');
    await git(['push', '-u', 'origin', 'main']);
  });

  afterEach(async () => {
    if (testDir) await fs.rm(testDir, { force: true, recursive: true });
    if (remoteDir) await fs.rm(remoteDir, { force: true, recursive: true });
  });

  async function pushRemoteCommit() {
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jc-pull-other-'));
    await git(['clone', remoteDir, otherDir], os.tmpdir());
    await git(['config', 'user.email', 'other@example.com'], otherDir);
    await git(['config', 'user.name', 'Other User'], otherDir);
    await fs.writeFile(path.join(otherDir, 'tracked.txt'), 'remote\n', 'utf-8');
    await git(['commit', '-am', 'remote change'], otherDir);
    await git(['push', 'origin', 'main'], otherDir);
    await fs.rm(otherDir, { force: true, recursive: true });
  }

  it('fast-forwards the worktree to the latest remote commit', async () => {
    await pushRemoteCommit();

    await pullBranch({ worktreePath: testDir, branchName: 'main' });

    const content = await fs.readFile(
      path.join(testDir, 'tracked.txt'),
      'utf-8',
    );
    expect(content).toBe('remote\n');
  });

  it('pulls via the upstream ref when the local branch name differs', async () => {
    // Mimics a PR review workspace: local branch tracks origin/main.
    await git([
      'checkout',
      '-b',
      'jean-claude/review-pr-1',
      '--track',
      'origin/main',
    ]);
    await pushRemoteCommit();

    await pullBranch({
      worktreePath: testDir,
      branchName: 'jean-claude/review-pr-1',
    });

    const content = await fs.readFile(
      path.join(testDir, 'tracked.txt'),
      'utf-8',
    );
    expect(content).toBe('remote\n');
  });

  it('ignores a local-tracking upstream and falls back to the remote', async () => {
    // branch.<name>.remote='.' — must not be parsed as remote "feature".
    await git(['branch', 'feature/base', 'main']);
    await git(['checkout', '-b', 'local-tracker', '--track', 'feature/base']);
    await git(['branch', '--set-upstream-to=origin/main', 'main']);
    await git(['checkout', 'main']);
    await pushRemoteCommit();

    await pullBranch({ worktreePath: testDir, branchName: 'main' });

    const content = await fs.readFile(
      path.join(testDir, 'tracked.txt'),
      'utf-8',
    );
    expect(content).toBe('remote\n');
  });

  it('explains a branch that does not exist on the remote yet', async () => {
    await git(['checkout', '-b', 'jean-claude/never-pushed', '--no-track']);

    await expect(
      pullBranch({
        worktreePath: testDir,
        branchName: 'jean-claude/never-pushed',
      }),
    ).rejects.toThrow(/does not exist on the remote yet/i);
  });

  it('explains uncommitted local changes instead of raw git output', async () => {
    await pushRemoteCommit();
    await writeFile('tracked.txt', 'dirty\n');

    await expect(
      pullBranch({ worktreePath: testDir, branchName: 'main' }),
    ).rejects.toThrow(/uncommitted changes/i);
  });

  it('explains a diverged branch instead of raw git output', async () => {
    await pushRemoteCommit();
    await writeFile('tracked.txt', 'local\n');
    await commit('local change');

    await expect(
      pullBranch({ worktreePath: testDir, branchName: 'main' }),
    ).rejects.toThrow(/diverged/i);
  });
});

describe('renameWorktreeBranch', () => {
  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jc-branch-rename-'));
    await git(['init', '-b', 'main']);
    await git(['config', 'user.email', 'test@example.com']);
    await git(['config', 'user.name', 'Test User']);
    await writeFile('a.txt', 'a\n');
    await commit('initial');
    await git(['switch', '-c', 'jean-claude/my-task']);
  });

  afterEach(async () => {
    if (testDir) await fs.rm(testDir, { force: true, recursive: true });
  });

  async function branchNames() {
    const { stdout } = await git([
      'branch',
      '--format=%(refname:short)',
    ]);
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  it('renames the branch the worktree is actually on', async () => {
    const { previousBranch } = await renameWorktreeBranch({
      worktreePath: testDir,
      newBranch: 'feature/new-name',
    });

    expect(previousBranch).toBe('jean-claude/my-task');
    expect(await branchNames()).toContain('feature/new-name');
    expect(await branchNames()).not.toContain('jean-claude/my-task');
    const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(stdout.trim()).toBe('feature/new-name');
  });

  it('rejects a name that already exists', async () => {
    await expect(
      renameWorktreeBranch({ worktreePath: testDir, newBranch: 'main' }),
    ).rejects.toThrow(/already exists/);
    expect(await branchNames()).toContain('jean-claude/my-task');
  });

  it('rejects an invalid branch name', async () => {
    await expect(
      renameWorktreeBranch({ worktreePath: testDir, newBranch: 'bad..name' }),
    ).rejects.toThrow(/not a valid git branch name/);
    expect(await branchNames()).toContain('jean-claude/my-task');
  });

  it('refuses to rename a branch that has an upstream', async () => {
    await git(['update-ref', 'refs/remotes/origin/jean-claude/my-task', 'HEAD']);
    await git(['config', 'branch.jean-claude/my-task.remote', 'origin']);
    await git([
      'config',
      'branch.jean-claude/my-task.merge',
      'refs/heads/jean-claude/my-task',
    ]);

    await expect(
      renameWorktreeBranch({ worktreePath: testDir, newBranch: 'feature/x' }),
    ).rejects.toThrow(/already pushed/);
    expect(await branchNames()).toContain('jean-claude/my-task');
  });

  it('refuses to rename a detached HEAD', async () => {
    await git(['checkout', '--detach', 'HEAD']);
    await expect(
      renameWorktreeBranch({ worktreePath: testDir, newBranch: 'feature/x' }),
    ).rejects.toThrow(/detached HEAD/);
  });
});
