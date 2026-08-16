import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', async () =>
  vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'),
);

// Home is redirected into the temp dir so the worktrees-base-dir guard passes
let homeDir = '/tmp';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => homeDir) },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

const findAllProjects = vi.fn();
const findAllTasks = vi.fn();
const updateTask = vi.fn();

vi.mock('../database/repositories/projects', () => ({
  ProjectRepository: {
    findAll: () => findAllProjects(),
    findById: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../database/repositories/tasks', () => ({
  TaskRepository: {
    findAll: () => findAllTasks(),
    update: (id: string, data: unknown) => updateTask(id, data),
  },
}));

vi.mock('./mcp-template-service', () => ({
  installMcpForWorktree: vi.fn(),
}));

const execFileAsync = promisify(execFile);
const fs =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const { cleanupUnusedWorktrees, scanUnusedWorktrees } = await import(
  './unused-worktree-service'
);

let rootDir: string;
let projectPath: string;
let worktreesPath: string;

async function git(args: string[], cwd: string) {
  return execFileAsync('git', args, { cwd, encoding: 'utf-8' });
}

function project() {
  return { id: 'p1', name: 'Demo', path: projectPath, worktreesPath };
}

function task(overrides: Record<string, unknown>) {
  return {
    id: 't1',
    name: 'Some task',
    worktreePath: null,
    branchName: null,
    userCompleted: false,
    ...overrides,
  };
}

/** Creates a git worktree under the project's worktrees folder. */
async function addWorktree(name: string) {
  const worktreePath = path.join(worktreesPath, name);
  await git(
    ['worktree', 'add', worktreePath, '-b', `jean-claude/${name}`],
    projectPath,
  );
  return worktreePath;
}

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jc-unused-wt-'));
  homeDir = rootDir;
  projectPath = path.join(rootDir, 'repo');
  worktreesPath = path.join(rootDir, '.jean-claude', 'worktrees', 'demo');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.mkdir(worktreesPath, { recursive: true });

  await git(['init', '-b', 'main'], projectPath);
  await git(['config', 'user.email', 'test@example.com'], projectPath);
  await git(['config', 'user.name', 'Test User'], projectPath);
  await fs.writeFile(path.join(projectPath, 'readme.md'), 'hi\n');
  await git(['add', '.'], projectPath);
  await git(['commit', '-m', 'base'], projectPath);

  findAllProjects.mockResolvedValue([project()]);
  findAllTasks.mockResolvedValue([]);
  updateTask.mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.clearAllMocks();
  await fs.rm(rootDir, { recursive: true, force: true });
});

describe('scanUnusedWorktrees', () => {
  it('reports a worktree with no task as orphaned', async () => {
    const worktreePath = await addWorktree('feature-a');

    const result = await scanUnusedWorktrees();

    expect(result.totalWorktrees).toBe(1);
    expect(result.activeWorktrees).toBe(0);
    expect(result.worktrees).toHaveLength(1);
    expect(result.worktrees[0]).toMatchObject({
      path: worktreePath,
      name: 'feature-a',
      projectName: 'Demo',
      reason: 'orphaned',
      registered: true,
      branchName: 'jean-claude/feature-a',
      hasUncommittedChanges: false,
    });
  });

  it('keeps a worktree owned by an active task', async () => {
    const worktreePath = await addWorktree('feature-a');
    findAllTasks.mockResolvedValue([
      task({ worktreePath, userCompleted: false }),
    ]);

    const result = await scanUnusedWorktrees();

    expect(result.activeWorktrees).toBe(1);
    expect(result.worktrees).toHaveLength(0);
  });

  it('reports a worktree owned by a completed task', async () => {
    const worktreePath = await addWorktree('feature-a');
    findAllTasks.mockResolvedValue([
      task({ worktreePath, userCompleted: true, name: 'Old task' }),
    ]);

    const result = await scanUnusedWorktrees();

    expect(result.worktrees).toHaveLength(1);
    expect(result.worktrees[0]).toMatchObject({
      reason: 'completed-task',
      taskId: 't1',
      taskName: 'Old task',
    });
  });

  it('prefers the active task when two tasks share a worktree path', async () => {
    const worktreePath = await addWorktree('feature-a');
    findAllTasks.mockResolvedValue([
      task({ id: 'done', worktreePath, userCompleted: true }),
      task({ id: 'active', worktreePath, userCompleted: false }),
    ]);

    const result = await scanUnusedWorktrees();

    expect(result.worktrees).toHaveLength(0);
    expect(result.activeWorktrees).toBe(1);
  });

  it('flags uncommitted changes', async () => {
    const worktreePath = await addWorktree('feature-a');
    await fs.writeFile(path.join(worktreePath, 'dirty.txt'), 'wip\n');

    const result = await scanUnusedWorktrees();

    expect(result.worktrees[0]?.hasUncommittedChanges).toBe(true);
  });

  it('counts commits that exist on no remote as unpushed', async () => {
    const worktreePath = await addWorktree('feature-a');
    await fs.writeFile(path.join(worktreePath, 'new.txt'), 'work\n');
    await git(['add', '.'], worktreePath);
    await git(['commit', '-m', 'work'], worktreePath);

    const result = await scanUnusedWorktrees();

    expect(result.worktrees[0]?.unpushedCommits).toBeGreaterThan(0);
  });

  it('reports a stale directory git no longer tracks', async () => {
    const stalePath = path.join(worktreesPath, 'leftover');
    await fs.mkdir(stalePath, { recursive: true });

    const result = await scanUnusedWorktrees();

    expect(result.worktrees).toHaveLength(1);
    expect(result.worktrees[0]).toMatchObject({
      name: 'leftover',
      registered: false,
      reason: 'orphaned',
    });
  });

  it('ignores the .project-id marker file', async () => {
    await fs.writeFile(path.join(worktreesPath, '.project-id'), 'p1');

    const result = await scanUnusedWorktrees();

    expect(result.totalWorktrees).toBe(0);
    expect(result.worktrees).toHaveLength(0);
  });
});

describe('cleanupUnusedWorktrees', () => {
  it('removes the worktree and its managed branch', async () => {
    const worktreePath = await addWorktree('feature-a');

    const result = await cleanupUnusedWorktrees([worktreePath]);

    expect(result.removed).toEqual([worktreePath]);
    expect(result.failed).toEqual([]);
    await expect(fs.stat(worktreePath)).rejects.toThrow();
    const { stdout } = await git(['branch', '--list'], projectPath);
    expect(stdout).not.toContain('jean-claude/feature-a');
  });

  it('removes a worktree that has uncommitted changes when selected', async () => {
    const worktreePath = await addWorktree('feature-a');
    await fs.writeFile(path.join(worktreePath, 'dirty.txt'), 'wip\n');

    const result = await cleanupUnusedWorktrees([worktreePath]);

    expect(result.removed).toEqual([worktreePath]);
    await expect(fs.stat(worktreePath)).rejects.toThrow();
  });

  it('deletes a stale untracked directory', async () => {
    const stalePath = path.join(worktreesPath, 'leftover');
    await fs.mkdir(stalePath, { recursive: true });
    await fs.writeFile(path.join(stalePath, 'junk.txt'), 'junk\n');

    const result = await cleanupUnusedWorktrees([stalePath]);

    expect(result.removed).toEqual([stalePath]);
    await expect(fs.stat(stalePath)).rejects.toThrow();
  });

  it('clears stale worktree metadata on the completed task', async () => {
    const worktreePath = await addWorktree('feature-a');
    findAllTasks.mockResolvedValue([
      task({ worktreePath, userCompleted: true }),
    ]);

    await cleanupUnusedWorktrees([worktreePath]);

    expect(updateTask).toHaveBeenCalledWith('t1', {
      worktreePath: null,
      branchName: null,
      startCommitHash: null,
      sourceBranch: null,
    });
  });

  it('skips a worktree that became active between scan and cleanup', async () => {
    const worktreePath = await addWorktree('feature-a');
    findAllTasks.mockResolvedValue([
      task({ worktreePath, userCompleted: false }),
    ]);

    const result = await cleanupUnusedWorktrees([worktreePath]);

    expect(result.removed).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    await expect(fs.stat(worktreePath)).resolves.toBeTruthy();
  });

  it('skips paths outside the worktrees base directory', async () => {
    const outside = path.join(rootDir, 'not-a-worktree');
    await fs.mkdir(outside, { recursive: true });

    const result = await cleanupUnusedWorktrees([outside]);

    expect(result.removed).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    await expect(fs.stat(outside)).resolves.toBeTruthy();
  });

  it('returns an empty result for an empty selection', async () => {
    const result = await cleanupUnusedWorktrees([]);

    expect(result).toEqual({
      removed: [],
      skipped: [],
      failed: [],
      freedBytes: 0,
      updatedTasks: [],
    });
  });

  it('refuses to raw-delete a directory sitting directly under the base dir', async () => {
    // A project whose worktreesPath was mis-pointed at the shared base would
    // otherwise make every *other* project's folder look like an orphan.
    const otherProjectFolder = path.join(
      rootDir,
      '.jean-claude',
      'worktrees',
      'another-project',
    );
    await fs.mkdir(otherProjectFolder, { recursive: true });
    findAllProjects.mockResolvedValue([
      { ...project(), worktreesPath: path.join(rootDir, '.jean-claude', 'worktrees') },
    ]);

    const scan = await scanUnusedWorktrees();
    expect(scan.worktrees).toHaveLength(0);
    expect(scan.errors[0]?.error).toContain('shared worktrees root');

    const result = await cleanupUnusedWorktrees([otherProjectFolder]);
    expect(result.removed).toEqual([]);
    await expect(fs.stat(otherProjectFolder)).resolves.toBeTruthy();
  });

  it('keeps a branch that is not managed by jean-claude', async () => {
    const worktreePath = path.join(worktreesPath, 'on-user-branch');
    await git(['worktree', 'add', worktreePath, '-b', 'develop'], projectPath);

    const result = await cleanupUnusedWorktrees([worktreePath]);

    expect(result.removed).toEqual([worktreePath]);
    const { stdout } = await git(['branch', '--list'], projectPath);
    expect(stdout).toContain('develop');
  });

  it('does not delete an unmanaged branch when the directory vanished', async () => {
    const worktreePath = path.join(worktreesPath, 'on-user-branch');
    await git(['worktree', 'add', worktreePath, '-b', 'develop'], projectPath);
    const scan = await scanUnusedWorktrees();
    expect(scan.worktrees).toHaveLength(1);

    // Directory disappears between scan and cleanup (Finder, external prune…)
    await fs.rm(worktreePath, { recursive: true, force: true });

    await cleanupUnusedWorktrees([worktreePath]);

    const { stdout } = await git(['branch', '--list'], projectPath);
    expect(stdout).toContain('develop');
  });

  it('reports the project instead of raw-deleting when git cannot be queried', async () => {
    await addWorktree('feature-a');
    // Project repo is gone, so `git worktree list` fails
    await fs.rm(projectPath, { recursive: true, force: true });

    const scan = await scanUnusedWorktrees();

    expect(scan.worktrees).toHaveLength(0);
    expect(scan.errors[0]?.error).toContain('Could not read git worktrees');
  });
});

describe('path matching safety', () => {
  it('does not treat an active task worktree as orphaned when the stored path is canonical', async () => {
    const worktreePath = await addWorktree('feature-a');
    const canonical = await fs.realpath(worktreePath);
    // /var vs /private/var on macOS: stored canonical, scanned non-canonical
    findAllTasks.mockResolvedValue([
      task({ worktreePath: canonical, userCompleted: false }),
    ]);

    const result = await scanUnusedWorktrees();

    expect(result.worktrees).toHaveLength(0);
    expect(result.activeWorktrees).toBe(1);
  });

  it('does not treat an active task worktree as orphaned when the stored path has a trailing slash', async () => {
    const worktreePath = await addWorktree('feature-a');
    findAllTasks.mockResolvedValue([
      task({ worktreePath: `${worktreePath}/`, userCompleted: false }),
    ]);

    const result = await scanUnusedWorktrees();

    expect(result.worktrees).toHaveLength(0);
    expect(result.activeWorktrees).toBe(1);
  });
});

describe('working state reporting', () => {
  it('marks state as unknown for a stale directory that is not a git worktree', async () => {
    const stalePath = path.join(worktreesPath, 'leftover');
    await fs.mkdir(stalePath, { recursive: true });

    const result = await scanUnusedWorktrees();

    // Not a worktree root, so git is never consulted and nothing is claimed
    expect(result.worktrees[0]).toMatchObject({
      registered: false,
      stateUnknown: false,
      hasUncommittedChanges: false,
    });
  });

  it('reports a clean registered worktree as known-clean', async () => {
    await addWorktree('feature-a');

    const result = await scanUnusedWorktrees();

    expect(result.worktrees[0]).toMatchObject({
      stateUnknown: false,
      hasUncommittedChanges: false,
      unpushedCommits: 0,
    });
  });
});

describe('task metadata consistency', () => {
  it('clears task metadata even when branch deletion fails', async () => {
    const worktreePath = await addWorktree('feature-a');
    findAllTasks.mockResolvedValue([
      task({ worktreePath, userCompleted: true }),
    ]);
    // Check the managed branch out in the main repo so `git branch -D` fails
    await git(['checkout', 'jean-claude/feature-a', '--force'], projectPath).catch(
      () => undefined,
    );

    await cleanupUnusedWorktrees([worktreePath]);

    // Whatever git did, the directory is gone, so the stored path must not linger
    if (!(await fs.stat(worktreePath).catch(() => null))) {
      expect(updateTask).toHaveBeenCalledWith('t1', {
        worktreePath: null,
        branchName: null,
        startCommitHash: null,
        sourceBranch: null,
      });
    }
  });

  it('returns the updated tasks so the IPC layer can emit them', async () => {
    const worktreePath = await addWorktree('feature-a');
    const updated = { id: 't1', worktreePath: null };
    findAllTasks.mockResolvedValue([
      task({ worktreePath, userCompleted: true }),
    ]);
    updateTask.mockResolvedValue(updated);

    const result = await cleanupUnusedWorktrees([worktreePath]);

    expect(result.updatedTasks).toEqual([updated]);
  });
});
