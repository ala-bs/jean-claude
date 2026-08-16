import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile, type ExecFileOptions } from 'child_process';
import { promisify } from 'util';

import type {
  CleanupUnusedWorktreesResult,
  UnusedWorktreeInfo,
  UnusedWorktreeScanResult,
} from '@shared/worktree-cleanup-types';
import type { Task } from '@shared/types';

import { pathExists } from '../lib/fs';
import { dbg } from '../lib/debug';
import { ProjectRepository } from '../database/repositories/projects';
import { TaskRepository } from '../database/repositories/tasks';

import {
  cleanupMissingWorktree,
  cleanupWorktree,
  getWorktreesBaseDir,
} from './worktree-service';

const execFileAsync = promisify(execFile) as (
  file: string,
  args: string[],
  options?: ExecFileOptions,
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Every child process here runs against user repositories that may be huge or
 * on stalled network volumes. Without these bounds a single wedged `du` leaves
 * the IPC promise pending forever and the Settings dialog spins with no cancel.
 */
const EXEC_OPTIONS = {
  encoding: 'utf-8' as const,
  timeout: 30_000,
  maxBuffer: 32 * 1024 * 1024,
};

/** Files/folders that live in a project worktrees folder but are not worktrees */
const NON_WORKTREE_ENTRIES = new Set(['.project-id', '.DS_Store']);

/** Branch prefix owned by Jean-Claude — only these branches get deleted */
const MANAGED_BRANCH_PREFIX = 'jean-claude/';

/**
 * Depth below ~/.jean-claude/worktrees that a directory must sit at before we
 * will `rm -rf` it: <base>/<project>/<worktree>. This is what stops a project
 * whose worktreesPath was mis-pointed at the base itself from turning every
 * *other* project's folder into a deletion candidate.
 */
const WORKTREE_DEPTH_BELOW_BASE = 2;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolves a path through symlinks so comparisons against git's canonical
 * worktree paths (always real paths) succeed on macOS (/var -> /private/var).
 * Returns null when the path cannot be resolved.
 */
async function canonicalize(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}

/** Path segments of `target` relative to the worktrees base, or null if outside it. */
async function segmentsBelowBase(target: string): Promise<string[] | null> {
  const base = (await canonicalize(getWorktreesBaseDir())) ?? getWorktreesBaseDir();
  const resolved = (await canonicalize(target)) ?? path.resolve(target);
  if (resolved === base) return [];
  if (!resolved.startsWith(base + path.sep)) return null;
  return resolved.slice(base.length + path.sep.length).split(path.sep);
}

/**
 * Guards raw recursive deletion. Only directories that sit exactly where
 * Jean-Claude puts worktrees may be removed without git's involvement.
 */
async function assertSafeToRawDelete(target: string): Promise<void> {
  const segments = await segmentsBelowBase(target);
  if (segments === null) {
    throw new Error(
      `Refusing to delete "${target}" — it is not under "${getWorktreesBaseDir()}"`,
    );
  }
  if (segments.length < WORKTREE_DEPTH_BELOW_BASE) {
    throw new Error(
      `Refusing to delete "${target}" — expected a <base>/<project>/<worktree> path, got depth ${segments.length}`,
    );
  }
}

/**
 * Parses `git worktree list --porcelain`.
 * Throws on failure so callers can distinguish "no worktrees" from "unknown".
 */
async function listRegisteredWorktrees(
  projectPath: string,
): Promise<Map<string, string | null>> {
  const registered = new Map<string, string | null>();
  const { stdout } = await execFileAsync(
    'git',
    ['worktree', 'list', '--porcelain'],
    { ...EXEC_OPTIONS, cwd: projectPath },
  );
  for (const block of stdout.trim().split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const wtPath = lines
      .find((line) => line.startsWith('worktree '))
      ?.slice('worktree '.length);
    if (!wtPath) continue;
    const branch =
      lines
        .find((line) => line.startsWith('branch refs/heads/'))
        ?.slice('branch refs/heads/'.length) ?? null;
    registered.set(wtPath, branch);
  }
  return registered;
}

/**
 * Working-tree state. `unknown` when git could not answer — the caller must
 * treat that as "may hold unsaved work", never as clean.
 */
async function getWorkingState(
  worktreePath: string,
  branchName: string | null,
): Promise<{
  hasUncommittedChanges: boolean;
  unpushedCommits: number;
  unknown: boolean;
}> {
  let hasUncommittedChanges = false;
  let unpushedCommits = 0;
  let unknown = false;

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain', '--untracked-files=all'],
      { ...EXEC_OPTIONS, cwd: worktreePath },
    );
    hasUncommittedChanges = stdout.trim().length > 0;
  } catch (error) {
    dbg.worktree('git status failed in %s: %O', worktreePath, error);
    unknown = true;
  }

  try {
    // Commits that exist nowhere else: not on any remote, and not reachable
    // from any other local branch. Counting only `--not --remotes` would flag
    // every commit in a repo that has no remote configured.
    const { stdout } = await execFileAsync(
      'git',
      [
        'rev-list',
        '--count',
        'HEAD',
        '--not',
        '--remotes',
        // The glob for `--branches` is relative to refs/heads/
        ...(branchName ? [`--exclude=${branchName}`] : []),
        '--branches',
      ],
      { ...EXEC_OPTIONS, cwd: worktreePath },
    );
    unpushedCommits = Number.parseInt(stdout.trim(), 10) || 0;
  } catch (error) {
    dbg.worktree('git rev-list failed in %s: %O', worktreePath, error);
    unknown = true;
  }

  return { hasUncommittedChanges, unpushedCommits, unknown };
}

/**
 * True when the directory is the root of its own git working tree, rather than
 * an arbitrary folder that merely sits inside one. Without this check, git
 * commands run in a stale directory would report the state of an *ancestor*
 * repository (users who git-track $HOME) against a destructive decision.
 */
async function isWorktreeRoot(target: string): Promise<boolean> {
  return pathExists(path.join(target, '.git'));
}

async function getDirectorySize(target: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('du', ['-sk', target], EXEC_OPTIONS);
    const kb = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? '', 10);
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch {
    return 0;
  }
}

async function getLastModified(target: string): Promise<string | null> {
  try {
    const stats = await fs.stat(target);
    return stats.mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * Indexes tasks by every spelling of their worktree path we might encounter,
 * so a task is never missed (and its worktree never deleted) because the
 * stored string differs from the scanned one by a symlink or trailing slash.
 */
async function indexTasksByWorktreePath(
  tasks: Task[],
): Promise<Map<string, Task>> {
  const byPath = new Map<string, Task>();

  const claim = (key: string, task: Task) => {
    const existing = byPath.get(key);
    // Prefer an active task when several tasks share the same path
    if (!existing || (existing.userCompleted && !task.userCompleted)) {
      byPath.set(key, task);
    }
  };

  for (const task of tasks) {
    if (!task.worktreePath) continue;
    const raw = task.worktreePath.replace(/[/\\]+$/, '');
    claim(raw, task);
    claim(path.resolve(raw), task);
    const canonical = await canonicalize(raw);
    if (canonical) claim(canonical, task);
  }

  return byPath;
}

/**
 * Scans every project's worktrees folder and reports worktrees that are no
 * longer backed by an active task.
 */
export async function scanUnusedWorktrees(): Promise<UnusedWorktreeScanResult> {
  const [projects, tasks] = await Promise.all([
    ProjectRepository.findAll(),
    TaskRepository.findAll(),
  ]);
  const tasksByWorktree = await indexTasksByWorktreePath(tasks);

  const result: UnusedWorktreeScanResult = {
    worktrees: [],
    scannedProjects: 0,
    totalWorktrees: 0,
    activeWorktrees: 0,
    errors: [],
  };

  for (const project of projects) {
    if (!project.worktreesPath) continue;
    if (!(await pathExists(project.worktreesPath))) continue;

    // A project pointed at the base directory (or above it) would make every
    // other project's folder look like an orphaned worktree.
    const projectSegments = await segmentsBelowBase(project.worktreesPath);
    if (projectSegments !== null && projectSegments.length === 0) {
      result.errors.push({
        projectName: project.name,
        error:
          'Its worktrees path is the shared worktrees root; set it to a project-specific folder.',
      });
      continue;
    }

    result.scannedProjects++;

    let registered: Map<string, string | null>;
    try {
      registered = await listRegisteredWorktrees(project.path);
    } catch (error) {
      // Without git's view we cannot tell a real worktree from a stray folder,
      // and must not fall back to raw deletion.
      dbg.worktree(
        'Failed to list worktrees for project %s: %O',
        project.name,
        error,
      );
      result.errors.push({
        projectName: project.name,
        error: `Could not read git worktrees: ${errorMessage(error)}`,
      });
      continue;
    }

    try {
      const entries = await fs.readdir(project.worktreesPath, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (NON_WORKTREE_ENTRIES.has(entry.name)) continue;

        const worktreePath = path.join(project.worktreesPath, entry.name);
        result.totalWorktrees++;

        const canonicalPath = await canonicalize(worktreePath);
        const task =
          tasksByWorktree.get(worktreePath) ??
          (canonicalPath ? tasksByWorktree.get(canonicalPath) : undefined);

        // An active task still owns this worktree — leave it alone
        if (task && !task.userCompleted) {
          result.activeWorktrees++;
          continue;
        }

        const isRegistered =
          registered.has(worktreePath) ||
          (canonicalPath !== null && registered.has(canonicalPath));

        // Unregistered directories are only ever removable by raw deletion, so
        // they must sit exactly where Jean-Claude puts worktrees.
        if (!isRegistered) {
          const segments = await segmentsBelowBase(worktreePath);
          if (segments === null || segments.length < WORKTREE_DEPTH_BELOW_BASE) {
            continue;
          }
        }

        const branchName =
          registered.get(worktreePath) ??
          (canonicalPath ? registered.get(canonicalPath) : undefined) ??
          task?.branchName ??
          null;

        const isGitWorktree = isRegistered || (await isWorktreeRoot(worktreePath));
        const [state, sizeBytes, lastModifiedAt] = await Promise.all([
          isGitWorktree
            ? getWorkingState(worktreePath, branchName)
            : Promise.resolve({
                hasUncommittedChanges: false,
                unpushedCommits: 0,
                unknown: false,
              }),
          getDirectorySize(worktreePath),
          getLastModified(worktreePath),
        ]);

        result.worktrees.push({
          path: worktreePath,
          name: entry.name,
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
          branchName,
          taskId: task?.id ?? null,
          taskName: task?.name ?? null,
          reason: task ? 'completed-task' : 'orphaned',
          registered: isRegistered,
          hasUncommittedChanges: state.hasUncommittedChanges,
          unpushedCommits: state.unpushedCommits,
          stateUnknown: state.unknown,
          sizeBytes,
          lastModifiedAt,
        });
      }
    } catch (error) {
      dbg.worktree(
        'Failed to scan worktrees for project %s: %O',
        project.name,
        error,
      );
      result.errors.push({
        projectName: project.name,
        error: errorMessage(error),
      });
    }
  }

  result.worktrees.sort(
    (a, b) =>
      a.projectName.localeCompare(b.projectName) ||
      a.name.localeCompare(b.name),
  );

  return result;
}

async function removeOne(
  target: UnusedWorktreeInfo,
): Promise<{ clearedTask: Task | null }> {
  const branchCleanup = target.branchName?.startsWith(MANAGED_BRANCH_PREFIX)
    ? 'delete'
    : 'keep';

  let gitError: unknown = null;
  try {
    if (await pathExists(target.path)) {
      if (target.registered) {
        await cleanupWorktree({
          worktreePath: target.path,
          projectPath: target.projectPath,
          branchName: target.branchName,
          branchCleanup,
          force: true,
        });
      } else {
        await assertSafeToRawDelete(target.path);
        await fs.rm(target.path, { recursive: true, force: true });
      }
    } else if (branchCleanup === 'delete' && target.branchName) {
      // Only reachable for branches we own. `allowUnregistered` stays false so
      // git still verifies the branch identity before `git branch -D`.
      await cleanupMissingWorktree({
        worktreePath: target.path,
        projectPath: target.projectPath,
        branchName: target.branchName,
        throwOnError: true,
      });
    }
  } catch (error) {
    gitError = error;
  }

  // The directory is what the task metadata points at. If it is gone the
  // metadata is stale regardless of whether branch deletion succeeded, so
  // clear it before surfacing any git failure.
  let clearedTask: Task | null = null;
  if (target.taskId && !(await pathExists(target.path))) {
    clearedTask = await TaskRepository.update(target.taskId, {
      worktreePath: null,
      branchName: null,
      startCommitHash: null,
      sourceBranch: null,
    });
  }

  if (gitError) throw gitError;
  return { clearedTask };
}

/**
 * Removes the selected worktrees. Each path is re-validated against a fresh
 * scan first, so a worktree that became active between scan and confirm is
 * skipped instead of deleted.
 */
export async function cleanupUnusedWorktrees(
  paths: string[],
): Promise<CleanupUnusedWorktreesResult & { updatedTasks: Task[] }> {
  const result: CleanupUnusedWorktreesResult & { updatedTasks: Task[] } = {
    removed: [],
    skipped: [],
    failed: [],
    freedBytes: 0,
    updatedTasks: [],
  };
  if (!Array.isArray(paths) || paths.length === 0) return result;

  const scan = await scanUnusedWorktrees();
  const stillUnused = new Map(scan.worktrees.map((wt) => [wt.path, wt]));

  for (const target of paths) {
    const info = stillUnused.get(target);
    if (!info) {
      result.skipped.push({
        path: target,
        reason: 'No longer unused (an active task now uses it) or already gone',
      });
      continue;
    }

    try {
      const { clearedTask } = await removeOne(info);
      if (clearedTask) result.updatedTasks.push(clearedTask);
      result.removed.push(target);
      result.freedBytes += info.sizeBytes;
      dbg.worktree('Cleaned up unused worktree %s', target);
    } catch (error) {
      dbg.worktree('Failed to clean up worktree %s: %O', target, error);
      result.failed.push({ path: target, error: errorMessage(error) });
    }
  }

  return result;
}
