import { execFile } from 'child_process';
import { promisify } from 'util';

import type {
  PortsInUseErrorData,
  ProjectCommand,
  ProjectCommandGroup,
  RunStatus,
  StartPrCommandParams,
  StartPrCommandResult,
} from '@shared/run-command-types';
import { type Task, type TaskStep } from '@shared/types';

import { dbg } from '../lib/debug';
import { getCleanupVerification } from './task-worktree-cleanup-service';

const execFileAsync = promisify(execFile);
const prLifecycleLocks = new Map<string, Promise<void>>();

type CreateTaskInput = {
  projectId: string;
  type: 'pr-review';
  prompt: string;
  name: string;
  worktreePath: string;
  startCommitHash: string;
  branchName: string;
  sourceBranch: string | null;
  pullRequestId: string;
  pullRequestUrl: string | null;
  prWorkspaceState: 'active';
  workItemIds: string[] | null;
  workItemUrls: string[] | null;
  updatedAt: string;
};

type RestoreTaskWorktreeInput = {
  worktreePath?: string;
  startCommitHash?: string;
  branchName?: string;
  sourceBranch?: string | null;
  pullRequestUrl?: string | null;
  prWorkspaceState: 'active';
  prWorkspacePendingAt: null;
  status?: 'waiting';
  userCompleted?: false;
  updatedAt: string;
};

type PrReviewProject = {
  id: string;
  name: string;
  path: string;
  defaultBranch?: string | null;
  archivedAt: string | null;
  repoProviderId: string | null;
  repoProjectId: string | null;
  repoId: string | null;
};

export type PrReviewTaskDeps = {
  findActivePrReviewTask: (params: {
    projectId: string;
    pullRequestId: string;
  }) => Promise<Task | undefined>;
  findProjectById: (projectId: string) => Promise<PrReviewProject | undefined>;
  getPullRequest: (params: {
    providerId: string;
    projectId: string;
    repoId: string;
    pullRequestId: number;
  }) => Promise<{
    title: string;
    sourceRefName: string;
    targetRefName?: string | null;
    url?: string | null;
    status: 'active' | 'completed' | 'abandoned';
  }>;
  fetchSourceBranch: (params: {
    projectPath: string;
    sourceBranch: string;
  }) => Promise<void>;
  /**
   * Resolves the merge-base between the worktree HEAD and a branch.
   * Used to anchor the PR review diff at target..source.
   */
  resolveMergeBase: (params: {
    worktreePath: string;
    sourceBranch: string;
  }) => Promise<string | null>;
  createWorktree: (
    projectPath: string,
    projectId: string,
    projectName: string,
    prompt: string,
    taskName: string,
    sourceBranch: string,
  ) => Promise<{
    worktreePath: string;
    startCommitHash: string;
    branchName: string;
  }>;
  /** Work items linked to the PR on the provider side. */
  getPullRequestWorkItems: (params: {
    providerId: string;
    projectId: string;
    repoId: string;
    pullRequestId: number;
  }) => Promise<Array<{ id: number | string; url?: string | null }>>;
  createTask: (data: CreateTaskInput) => Promise<Task>;
  updateTask: (taskId: string, data: RestoreTaskWorktreeInput) => Promise<Task>;
  setPrWorkspaceState: (
    taskId: string,
    state: 'active',
  ) => Promise<Task>;
  emitTaskUpsert: (task: Task) => void;
  cleanupWorktree: (params: {
    worktreePath: string;
    projectPath: string;
    branchName: string;
    branchCleanup: 'delete';
    force: true;
  }) => Promise<void>;
};

type StartOptions = {
  afterStop?: () => void | Promise<void>;
};

export type StartPrCommandDeps = PrReviewTaskDeps & {
  findCommandById: (id: string) => Promise<ProjectCommand | undefined>;
  findCommandGroupById: (
    id: string,
  ) => Promise<ProjectCommandGroup | undefined>;
  resetLogs: (taskId: string, runCommandIds: string[]) => void | Promise<void>;
  startCommand: (
    params: {
      taskId: string;
      projectId: string;
      workingDir: string;
      runCommandId: string;
    },
    options?: StartOptions,
  ) => Promise<RunStatus | PortsInUseErrorData>;
  startGroup: (
    params: {
      taskId: string;
      projectId: string;
      workingDir: string;
      runCommandIds: string[];
    },
    options?: StartOptions,
  ) => Promise<RunStatus | PortsInUseErrorData>;
};

type ReconcilePrWorkspaceStateDeps = {
  findPrReviewTasksByPullRequest: (params: {
    projectId: string;
    pullRequestId: string;
  }) => Promise<Task[]>;
  revalidatePullRequestStatus: (params: {
    projectId: string;
    pullRequestId: number;
  }) => Promise<'active' | 'completed' | 'abandoned'>;
  markPrWorkspacesKept: (params: {
    projectId: string;
    pullRequestId: string;
    taskIds: string[];
  }) => Promise<Task[]>;
  reactivatePrWorkspaces: (taskIds: string[]) => Promise<Task[]>;
  emitTaskUpsert: (task: Task) => void;
};

type PrReviewWorkspaceCleanupDeps = {
  findTaskById: (taskId: string) => Promise<Task | undefined>;
  findProjectById: (projectId: string) => Promise<PrReviewProject | undefined>;
  stopCommandsForTask: (taskId: string) => Promise<boolean | void>;
  closeEditorWindowsForTaskWorktree: (task: {
    id: string;
    worktreePath: string | null;
  }) => Promise<string | undefined>;
  pathExists: (path: string) => Promise<boolean>;
  cleanupWorktree: (params: {
    worktreePath: string;
    projectPath: string;
    branchName: string | null;
    branchCleanup: 'delete';
    force: true;
    onVerified?: () => void | Promise<void>;
  }) => Promise<void>;
  cleanupMissingWorktree: (params: {
    worktreePath?: string;
    projectPath: string;
    branchName: string;
    throwOnError?: boolean;
    allowUnregistered?: boolean;
    onVerified?: () => void | Promise<void>;
  }) => Promise<void>;
  clearWorktreeMetadata: (
    taskId: string,
    data: {
      worktreePath: null;
      branchName: null;
      startCommitHash: null;
      sourceBranch: null;
    },
  ) => Promise<Task>;
  getVerifiedCleanupIdentity?: (
    taskId: string,
  ) => Promise<{ worktreePath: string; branchName: string } | undefined>;
  markCleanupIdentityVerified?: (
    taskId: string,
    identity: { worktreePath: string; branchName: string },
  ) => Promise<void>;
  clearCleanupIdentity?: (taskId: string) => Promise<unknown>;
  emitTaskUpsert: (task: Task) => void;
};

async function getDefaultPrReviewWorkspaceCleanupDeps(): Promise<PrReviewWorkspaceCleanupDeps> {
  const [
    { TaskRepository, ProjectRepository },
    { emitTaskUpsert },
    { runCommandService },
    { closeEditorWindowsForTaskWorktree },
    { cleanupMissingWorktree, cleanupWorktree },
    { pathExists },
  ] =
    await Promise.all([
      import('../database/repositories'),
      import('./cache-event-service'),
      import('./run-command-service'),
      import('./editor-automation-service'),
      import('./worktree-service'),
      import('../lib/fs'),
    ]);

  return {
    findTaskById: TaskRepository.findById,
    findProjectById: ProjectRepository.findById,
    stopCommandsForTask: (taskId) =>
      runCommandService.stopCommandsForTask(taskId),
    closeEditorWindowsForTaskWorktree,
    pathExists,
    cleanupWorktree,
    cleanupMissingWorktree,
    clearWorktreeMetadata: TaskRepository.update,
    getVerifiedCleanupIdentity: TaskRepository.getVerifiedCleanupIdentity,
    markCleanupIdentityVerified: TaskRepository.markCleanupIdentityVerified,
    clearCleanupIdentity: TaskRepository.clearCleanupIdentity,
    emitTaskUpsert,
  };
}

export type CleanPrReviewWorkspaceDeps = Pick<
  PrReviewWorkspaceCleanupDeps,
  | 'findTaskById'
  | 'findProjectById'
  | 'stopCommandsForTask'
  | 'closeEditorWindowsForTaskWorktree'
  | 'pathExists'
  | 'cleanupWorktree'
  | 'cleanupMissingWorktree'
  | 'clearWorktreeMetadata'
  | 'getVerifiedCleanupIdentity'
  | 'markCleanupIdentityVerified'
  | 'clearCleanupIdentity'
  | 'emitTaskUpsert'
>;

async function getDefaultReconcilePrWorkspaceStateDeps(): Promise<ReconcilePrWorkspaceStateDeps> {
  const [{ TaskRepository, ProjectRepository }, { emitTaskUpsert }, { getPullRequest }] =
    await Promise.all([
      import('../database/repositories'),
      import('./cache-event-service'),
      import('./azure-devops-service'),
    ]);

  return {
    findPrReviewTasksByPullRequest:
      TaskRepository.findPrReviewTasksByPullRequest,
    revalidatePullRequestStatus: async ({ projectId, pullRequestId }) => {
      const project = await ProjectRepository.findById(projectId);
      if (!project?.repoProviderId || !project.repoProjectId || !project.repoId) {
        throw new Error(`Project ${projectId} has no linked repository`);
      }
      const pullRequest = await getPullRequest({
        providerId: project.repoProviderId,
        projectId: project.repoProjectId,
        repoId: project.repoId,
        pullRequestId,
      });
      return pullRequest.status;
    },
    markPrWorkspacesKept: TaskRepository.markPrWorkspacesKept,
    reactivatePrWorkspaces: TaskRepository.reactivatePrWorkspaces,
    emitTaskUpsert,
  };
}

export async function fetchPrReviewSourceBranch({
  projectPath,
  sourceBranch,
}: {
  projectPath: string;
  sourceBranch: string;
}) {
  await execFileAsync(
    'git',
    ['fetch', 'origin', `+refs/heads/${sourceBranch}:refs/remotes/origin/${sourceBranch}`],
    {
      cwd: projectPath,
      encoding: 'utf-8',
    },
  );
}

export function withPrLifecycleLock<T>(
  projectId: string,
  pullRequestId: number | string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${projectId}:${pullRequestId}`;
  const previous = prLifecycleLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  prLifecycleLocks.set(key, current);

  return (async () => {
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (prLifecycleLocks.get(key) === current) {
        prLifecycleLocks.delete(key);
      }
    }
  })();
}

/**
 * Converts a Git ref into a branch name. Returns null for refs that are not
 * branches (e.g. `refs/pull/...`), so callers can fall back instead of
 * building a nonsense `origin/refs/pull/...` base.
 */
function toBranchName(ref: string): string | null {
  if (!ref.startsWith('refs/')) return ref;
  if (!ref.startsWith('refs/heads/')) return null;
  return ref.slice('refs/heads/'.length);
}

/**
 * Resolves the commit a PR review diff should be anchored on: the merge-base
 * between the review worktree HEAD (the PR source branch) and the PR target
 * branch. Falls back to the worktree start commit when the target branch is
 * unknown or unreachable.
 */
async function resolveDiffBaseCommit({
  deps,
  worktreePath,
  diffBaseBranch,
  fallbackCommitHash,
}: {
  deps: Pick<PrReviewTaskDeps, 'resolveMergeBase'>;
  worktreePath: string;
  diffBaseBranch: string | null;
  fallbackCommitHash: string;
}): Promise<string> {
  if (!diffBaseBranch) return fallbackCommitHash;
  try {
    const mergeBase = await deps.resolveMergeBase({
      worktreePath,
      sourceBranch: diffBaseBranch,
    });
    if (mergeBase) return mergeBase;
    dbg.ipc(
      'No merge-base with %s for PR review worktree %s; the diff may be empty',
      diffBaseBranch,
      worktreePath,
    );
  } catch (mergeBaseError) {
    dbg.ipc(
      'Failed to resolve merge-base with %s for PR review worktree %s: %O',
      diffBaseBranch,
      worktreePath,
      mergeBaseError,
    );
  }
  return fallbackCommitHash;
}

/**
 * Resolves the work items linked to a PR so the review workspace task carries
 * the same work item links as the PR itself. Best-effort: a provider failure
 * must never block workspace creation.
 *
 * Unlike normal task creation, PR review tasks deliberately do NOT activate the
 * linked work items in Azure — reviewing someone else's PR must not transition
 * their work item state.
 */
async function resolvePrWorkItems({
  deps,
  providerId,
  repoProjectId,
  repoId,
  pullRequestId,
}: {
  deps: Pick<PrReviewTaskDeps, 'getPullRequestWorkItems'>;
  providerId: string;
  repoProjectId: string;
  repoId: string;
  pullRequestId: number;
}): Promise<{ workItemIds: string[] | null; workItemUrls: string[] | null }> {
  try {
    const workItems = await deps.getPullRequestWorkItems({
      providerId,
      projectId: repoProjectId,
      repoId,
      pullRequestId,
    });
    if (workItems.length === 0) {
      return { workItemIds: null, workItemUrls: null };
    }
    // Consumers zip the two arrays by index (task panel, feed card), so keep
    // them positionally aligned rather than dropping empty URLs.
    return {
      workItemIds: workItems.map((workItem) => String(workItem.id)),
      workItemUrls: workItems.map((workItem) => workItem.url ?? ''),
    };
  } catch (workItemsError) {
    dbg.ipc(
      'Failed to resolve work items for PR #%d; creating workspace without links: %O',
      pullRequestId,
      workItemsError,
    );
    return { workItemIds: null, workItemUrls: null };
  }
}

async function createOrGetPrReviewTaskUnlocked(
  params: {
    projectId: string;
    pullRequestId: number;
  },
  deps: PrReviewTaskDeps,
): Promise<{ task: Task; created: boolean }> {
  const { projectId, pullRequestId } = params;
  const foundTask = await deps.findActivePrReviewTask({
    projectId,
    pullRequestId: String(pullRequestId),
  });
  const wasCompleted = Boolean(
    foundTask && (foundTask.status === 'completed' || foundTask.userCompleted),
  );
  const hasWorkspace = Boolean(
    foundTask?.worktreePath ||
      foundTask?.branchName ||
      foundTask?.startCommitHash ||
      foundTask?.sourceBranch,
  );
  const isRetainedWorkspace = Boolean(
    hasWorkspace &&
      (foundTask?.prWorkspaceState === 'cleanup-pending' ||
        foundTask?.prWorkspaceState === 'kept'),
  );
  if (
    wasCompleted &&
    hasWorkspace &&
    !isRetainedWorkspace
  ) {
    throw new Error('PR review task is completed and cannot recreate a worktree');
  }
  const existingTask = wasCompleted && !isRetainedWorkspace ? undefined : foundTask;

  const project = await deps.findProjectById(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  if (project.archivedAt) {
    throw new Error('Cannot create tasks for archived projects');
  }
  if (!project.repoProviderId || !project.repoProjectId || !project.repoId) {
    throw new Error('Project has no linked repository');
  }
  const repo = {
    providerId: project.repoProviderId,
    projectId: project.repoProjectId,
    repoId: project.repoId,
  };

  const pr = await deps.getPullRequest({
    providerId: project.repoProviderId,
    projectId: project.repoProjectId,
    repoId: project.repoId,
    pullRequestId,
  });
  if (pr.status !== 'active') {
    throw new Error('PR review tasks can only start for an active PR');
  }
  const sourceBranch = pr.sourceRefName.replace('refs/heads/', '');
  const targetBranch = pr.targetRefName
    ? toBranchName(pr.targetRefName)
    : null;
  // The worktree HEAD is the PR source branch, so diffing against the source
  // branch always yields nothing. Anchor the diff on the PR target branch.
  // Without a usable target, prefer the project default branch and finally
  // null (which makes the diff fall back to the stored start commit) — never
  // the source branch, which would collapse the diff base onto HEAD again.
  const diffBaseBranch = targetBranch
    ? `origin/${targetBranch}`
    : project.defaultBranch
      ? `origin/${project.defaultBranch}`
      : null;

  // Existing workspaces keep whatever work item links they already have —
  // linking is a creation-time concern only.
  if (existingTask?.worktreePath) {
    if (existingTask.prWorkspaceState === 'active') {
      return { task: existingTask, created: false };
    }
    const task = await deps.setPrWorkspaceState(existingTask.id, 'active');
    deps.emitTaskUpsert(task);
    return { task, created: false };
  }
  const rawName = `Review: ${pr.title}`;
  const taskName = rawName.length > 40 ? rawName.slice(0, 37) + '...' : rawName;
  const remoteSourceBranch = `origin/${sourceBranch}`;

  const branchesToFetch = [
    ...new Set(
      [sourceBranch, targetBranch].filter(
        (branch): branch is string => branch !== null,
      ),
    ),
  ];
  await Promise.all(
    branchesToFetch.map(async (branch) => {
      try {
        await deps.fetchSourceBranch({
          projectPath: project.path,
          sourceBranch: branch,
        });
      } catch (fetchError) {
        dbg.ipc(
          'Failed to fetch origin/%s before review worktree creation: %O',
          branch,
          fetchError,
        );
      }
    }),
  );

  let worktreeResult:
    | {
        worktreePath: string;
        startCommitHash: string;
        branchName: string;
      }
    | undefined;

  try {
    worktreeResult = await deps.createWorktree(
      project.path,
      project.id,
      project.name,
      `Review PR #${pullRequestId}`,
      taskName,
      remoteSourceBranch,
    );
  } catch (remoteBranchError) {
    dbg.ipc(
      'Failed to create worktree from %s, retrying with local branch %s: %O',
      remoteSourceBranch,
      sourceBranch,
      remoteBranchError,
    );

    worktreeResult = await deps.createWorktree(
      project.path,
      project.id,
      project.name,
      `Review PR #${pullRequestId}`,
      taskName,
      sourceBranch,
    );
  }

  const { worktreePath, branchName } = worktreeResult;
  const startCommitHash = await resolveDiffBaseCommit({
    deps,
    worktreePath,
    diffBaseBranch,
    fallbackCommitHash: worktreeResult.startCommitHash,
  });
  // Only fetched for brand new tasks: an existing task keeps its own links.
  const prWorkItems = existingTask
    ? { workItemIds: null, workItemUrls: null }
    : await resolvePrWorkItems({
        deps,
        providerId: repo.providerId,
        repoProjectId: repo.projectId,
        repoId: repo.repoId,
        pullRequestId,
      });
  let persistedResult: { task: Task; created: boolean };
  try {
    if (existingTask) {
      const task = await deps.updateTask(existingTask.id, {
        worktreePath,
        startCommitHash,
        branchName,
        sourceBranch: diffBaseBranch,
        pullRequestUrl: pr.url ?? null,
        prWorkspaceState: 'active',
        prWorkspacePendingAt: null,
        updatedAt: new Date().toISOString(),
      });
      persistedResult = { task, created: false };
    } else {
      const task = await deps.createTask({
        projectId,
        type: 'pr-review',
        prompt: `Review PR #${pullRequestId}: ${pr.title}`,
        name: taskName,
        worktreePath,
        startCommitHash,
        branchName,
        sourceBranch: diffBaseBranch,
        pullRequestId: String(pullRequestId),
        pullRequestUrl: pr.url ?? null,
        prWorkspaceState: 'active',
        workItemIds: prWorkItems.workItemIds,
        workItemUrls: prWorkItems.workItemUrls,
        updatedAt: new Date().toISOString(),
      });
      persistedResult = { task, created: true };
    }
  } catch (persistenceError) {
    try {
      await deps.cleanupWorktree({
        worktreePath,
        projectPath: project.path,
        branchName,
        branchCleanup: 'delete',
        force: true,
      });
    } catch (cleanupError) {
      dbg.ipc(
        'Failed compensating PR workspace persistence failure at %s on branch %s: %O',
        worktreePath,
        branchName,
        cleanupError,
      );
      throw new AggregateError(
        [persistenceError, cleanupError],
        `Failed to persist PR workspace and clean orphan ${worktreePath} (${branchName})`,
        { cause: persistenceError },
      );
    }
    throw persistenceError;
  }
  deps.emitTaskUpsert(persistedResult.task);
  return persistedResult;
}

export function createOrGetPrReviewTask(
  params: {
    projectId: string;
    pullRequestId: number;
  },
  deps: PrReviewTaskDeps,
): Promise<{ task: Task; created: boolean }> {
  return withPrLifecycleLock(params.projectId, params.pullRequestId, () =>
    createOrGetPrReviewTaskUnlocked(params, deps),
  );
}

export function startPrCommand(
  params: StartPrCommandParams,
  deps: StartPrCommandDeps,
): Promise<StartPrCommandResult> {
  return withPrLifecycleLock(
    params.projectId,
    params.pullRequestId,
    async () => {
      const project = await deps.findProjectById(params.projectId);
      if (!project) throw new Error(`Project ${params.projectId} not found`);
      if (project.archivedAt) {
        throw new Error('Cannot start commands for archived projects');
      }
      if (!project.repoProviderId || !project.repoProjectId || !project.repoId) {
        throw new Error('Project has no linked repository');
      }

      const pullRequest = await deps.getPullRequest({
        providerId: project.repoProviderId,
        projectId: project.repoProjectId,
        repoId: project.repoId,
        pullRequestId: params.pullRequestId,
      });
      if (pullRequest.status !== 'active') {
        throw new Error('Project commands can only start for an active PR');
      }

      let runCommandIds: string[];
      if (params.target.type === 'command') {
        const command = await deps.findCommandById(params.target.id);
        if (!command || command.projectId !== params.projectId) {
          throw new Error(
            `Command ${params.target.id} not found for project ${params.projectId}`,
          );
        }
        runCommandIds = [command.id];
      } else {
        const group = await deps.findCommandGroupById(params.target.id);
        if (!group || group.projectId !== params.projectId) {
          throw new Error(
            `Command group ${params.target.id} not found for project ${params.projectId}`,
          );
        }
        runCommandIds = [...new Set(group.commandIds)];
        if (runCommandIds.length === 0) {
          throw new Error(`Command group ${params.target.id} is empty`);
        }

        for (const runCommandId of runCommandIds) {
          const command = await deps.findCommandById(runCommandId);
          if (!command || command.projectId !== params.projectId) {
            throw new Error(
              `Command ${runCommandId} not found for project ${params.projectId}`,
            );
          }
        }
      }

      const { task, created } = await createOrGetPrReviewTaskUnlocked(
        {
          projectId: params.projectId,
          pullRequestId: params.pullRequestId,
        },
        deps,
      );
      if (!task.worktreePath) {
        throw new Error(`PR review task ${task.id} has no worktree`);
      }

      const startParams = {
        taskId: task.id,
        projectId: task.projectId,
        workingDir: task.worktreePath,
      };
      const options: StartOptions = {
        afterStop: () => deps.resetLogs(task.id, runCommandIds),
      };
      const runResult =
        params.target.type === 'command'
          ? await deps.startCommand(
              { ...startParams, runCommandId: runCommandIds[0] },
              options,
            )
          : await deps.startGroup(
              { ...startParams, runCommandIds },
              options,
            );

      return { task, created, runCommandIds, runResult };
    },
  );
}

/**
 * Why a PR workspace can no longer be acted on, or null when it is still live.
 *
 * Deliberately does NOT treat `status === 'completed'` as terminal: that only
 * means the workspace's last agent step finished, while the worktree stays
 * alive and run commands must keep working. See the invariant documented in
 * StepService.syncTaskStatus.
 *
 * These messages reach the user verbatim (the run button and prompt composer
 * surface the rejection), so each branch explains what actually happened.
 */
function getPrWorkspaceTerminalReason(task: Task): string | null {
  if (task.userCompleted) {
    return `PR review task ${task.id} was archived`;
  }
  if (task.prWorkspaceState === 'cleanup-pending') {
    return `PR review task ${task.id} is being cleaned up`;
  }
  if (!task.worktreePath) {
    return `PR review task ${task.id} has no active worktree`;
  }
  return null;
}

export async function runCommandWithPrReviewLifecycle<
  Params extends {
    taskId: string;
    projectId: string;
    workingDir: string;
  },
  Result,
>(
  params: Params,
  operation: (params: Params) => Promise<Result>,
  deps?: { findTaskById: (taskId: string) => Promise<Task | undefined> },
): Promise<Result> {
  const findTaskById =
    deps?.findTaskById ??
    (await import('../database/repositories')).TaskRepository.findById;
  const initialTask = await findTaskById(params.taskId);
  if (
    initialTask?.type !== 'pr-review' ||
    !initialTask.pullRequestId
  ) {
    return operation(params);
  }

  const identity = {
    taskId: initialTask.id,
    projectId: initialTask.projectId,
    pullRequestId: initialTask.pullRequestId,
  };
  return withPrLifecycleLock(
    identity.projectId,
    identity.pullRequestId,
    async () => {
      const task = await findTaskById(params.taskId);
      validatePrReviewTask(task, identity);
      const terminalReason = getPrWorkspaceTerminalReason(task);
      if (terminalReason) throw new Error(terminalReason);

      return operation({
        ...params,
        projectId: task.projectId,
        workingDir: task.worktreePath,
      });
    },
  );
}

export async function startAgentWithPrReviewLifecycle(
  stepId: string,
  operation: (stepId: string) => Promise<void>,
  deps?: {
    findStepById: (stepId: string) => Promise<TaskStep | undefined>;
    findTaskById: (taskId: string) => Promise<Task | undefined>;
  },
): Promise<void> {
  const repositories = deps ?? {
    findStepById: (await import('../database/repositories/task-steps'))
      .TaskStepRepository.findById,
    findTaskById: (await import('../database/repositories')).TaskRepository
      .findById,
  };
  const initialStep = await repositories.findStepById(stepId);
  if (!initialStep) throw new Error(`Step ${stepId} not found`);
  const initialTask = await repositories.findTaskById(initialStep.taskId);
  if (!initialTask) throw new Error(`Task ${initialStep.taskId} not found`);
  if (initialTask.type !== 'pr-review' || !initialTask.pullRequestId) {
    return operation(stepId);
  }

  dbg.agent(
    'pr-review lifecycle: step=%s task=%s state=%s status=%s userCompleted=%s worktree=%s',
    stepId,
    initialTask.id,
    initialTask.prWorkspaceState,
    initialTask.status,
    initialTask.userCompleted,
    initialTask.worktreePath,
  );

  const identity = {
    stepId,
    taskId: initialTask.id,
    projectId: initialTask.projectId,
    pullRequestId: initialTask.pullRequestId,
  };
  return withPrLifecycleLock(
    identity.projectId,
    identity.pullRequestId,
    async () => {
      const step = await repositories.findStepById(identity.stepId);
      if (!step || step.taskId !== identity.taskId) {
        throw new Error(`Step ${identity.stepId} no longer matches requested task`);
      }
      const task = await repositories.findTaskById(identity.taskId);
      validatePrReviewTask(task, identity);
      // A finished agent run must not block starting another step.
      const terminalReason = getPrWorkspaceTerminalReason(task);
      if (terminalReason) throw new Error(terminalReason);
      dbg.agent('pr-review lifecycle: lock acquired for step=%s', step.id);
      await operation(step.id);
    },
  );
}

export async function sendMessageWithPrReviewLifecycle(
  stepId: string,
  beginFollowUp: (stepId: string) => Promise<{
    started: Promise<void>;
    completion: Promise<void>;
  }>,
  deps?: {
    findStepById: (stepId: string) => Promise<TaskStep | undefined>;
    findTaskById: (taskId: string) => Promise<Task | undefined>;
    /**
     * When false, resolve as soon as the prompt is ACCEPTED rather than when
     * the agent turn finishes.
     *
     * The renderer awaits this call before clearing the composer, so waiting
     * for the whole turn would pin the user's text and attachments in the
     * input box for the entire agent run.
     *
     * Safe to skip because a turn that fails *after* starting has already
     * surfaced itself: synthetic timeline entry, errored step status and a
     * notification (see `agentService.performSendMessage`). A prompt that never
     * starts rejects `started`, which still propagates from here. Internal
     * callers that genuinely chain off turn completion (e.g. PR review chat
     * continuation) leave this at its default.
     */
    waitForCompletion?: boolean;
  },
): Promise<void> {
  let completion: Promise<void> | undefined;
  await startAgentWithPrReviewLifecycle(
    stepId,
    async (authoritativeStepId) => {
      const followUp = await beginFollowUp(authoritativeStepId);
      completion = followUp.completion;
      // Observe it the moment we own it. `await followUp.started` below can
      // throw, and every path out of here either awaits `completion` or
      // abandons it -- an abandoned rejection would crash the main process.
      completion.catch((error) => {
        dbg.agent('follow-up turn for step %s failed: %O', stepId, error);
      });
      await followUp.started;
    },
    deps,
  );
  if (!completion) throw new Error(`Follow-up for step ${stepId} did not start`);

  if (deps?.waitForCompletion === false) return;

  await completion;
}

export async function runTaskDestructiveWithPrReviewLifecycle<Result>(
  initialTask: Task,
  operation: (task: Task) => Promise<Result>,
  deps?: { findTaskById: (taskId: string) => Promise<Task | undefined> },
): Promise<Result> {
  if (initialTask.type !== 'pr-review' || !initialTask.pullRequestId) {
    return operation(initialTask);
  }

  const findTaskById =
    deps?.findTaskById ??
    (await import('../database/repositories')).TaskRepository.findById;
  const identity = {
    taskId: initialTask.id,
    projectId: initialTask.projectId,
    pullRequestId: initialTask.pullRequestId,
  };
  return withPrLifecycleLock(
    identity.projectId,
    identity.pullRequestId,
    async () => {
      const task = await findTaskById(identity.taskId);
      validatePrReviewTask(task, identity);
      return operation(task);
    },
  );
}

function validatePrReviewTask(
  task: Task | undefined,
  expected?: { projectId: string; pullRequestId: string; taskId?: string },
): asserts task is Task & { type: 'pr-review'; pullRequestId: string } {
  if (!task) throw new Error('PR review task not found');
  if (task.type !== 'pr-review' || !task.pullRequestId) {
    throw new Error(`Task ${task.id} is not a PR review task`);
  }
  if (
    expected &&
    ((expected.taskId !== undefined && task.id !== expected.taskId) ||
      task.projectId !== expected.projectId ||
      task.pullRequestId !== expected.pullRequestId)
  ) {
    throw new Error(`Task ${task.id} does not match the requested PR`);
  }
}

export async function cleanPrReviewWorkspaceUnlocked(
  task: Task,
  deps: CleanPrReviewWorkspaceDeps,
): Promise<{ task: Task; changed: boolean; editorCloseWarning?: string }> {
  const project = await deps.findProjectById(task.projectId);
  if (!project) throw new Error(`Project ${task.projectId} not found`);

  if ((await deps.stopCommandsForTask(task.id)) === false) {
    throw new Error(`Failed to stop commands for task ${task.id}`);
  }
  const editorCloseWarning =
    await deps.closeEditorWindowsForTaskWorktree(task);
  const hasWorkspaceMetadata = Boolean(
    task.worktreePath ||
      task.branchName ||
      task.startCommitHash ||
      task.sourceBranch,
  );
  if (!hasWorkspaceMetadata) {
    await deps.clearCleanupIdentity?.(task.id);
    return { task, changed: false, editorCloseWarning };
  }

  const verification =
    task.worktreePath && task.branchName
      ? await getCleanupVerification(
          {
            id: task.id,
            worktreePath: task.worktreePath,
            branchName: task.branchName,
          },
          deps,
        )
      : undefined;

  if (task.worktreePath && (await deps.pathExists(task.worktreePath))) {
    await deps.cleanupWorktree({
      worktreePath: task.worktreePath,
      projectPath: project.path,
      branchName: task.branchName,
      branchCleanup: 'delete',
      force: true,
      ...(verification?.onVerified && {
        onVerified: verification.onVerified,
      }),
    });
  } else if (task.branchName) {
    await deps.cleanupMissingWorktree({
      worktreePath: task.worktreePath ?? undefined,
      projectPath: project.path,
      branchName: task.branchName,
      throwOnError: true,
      allowUnregistered: verification?.verified,
      ...(verification?.onVerified && {
        onVerified: verification.onVerified,
      }),
    });
  }

  const clearedTask = await deps.clearWorktreeMetadata(task.id, {
    worktreePath: null,
    branchName: null,
    startCommitHash: null,
    sourceBranch: null,
  });
  await deps.clearCleanupIdentity?.(task.id);
  return { task: clearedTask, changed: true, editorCloseWarning };
}

export async function cleanPrReviewWorkspace(
  params: {
    projectId: string;
    pullRequestId: number | string;
    taskId: string;
  },
  deps?: CleanPrReviewWorkspaceDeps,
): Promise<{ editorCloseWarning?: string }> {
  const resolvedDeps = deps ?? (await getDefaultPrReviewWorkspaceCleanupDeps());
  const pullRequestId = String(params.pullRequestId);

  return withPrLifecycleLock(
    params.projectId,
    pullRequestId,
    async () => {
      const task = await resolvedDeps.findTaskById(params.taskId);
      validatePrReviewTask(task, {
        taskId: params.taskId,
        projectId: params.projectId,
        pullRequestId,
      });
      const result = await cleanPrReviewWorkspaceUnlocked(task, resolvedDeps);
      if (result.changed) resolvedDeps.emitTaskUpsert(result.task);
      return { editorCloseWarning: result.editorCloseWarning };
    },
  );
}

export async function reconcilePrWorkspaceState(
  params: {
    projectId: string;
    pullRequestId: number | string;
  },
  deps?: ReconcilePrWorkspaceStateDeps,
): Promise<Task[]> {
  const resolvedDeps = deps ?? (await getDefaultReconcilePrWorkspaceStateDeps());
  const pullRequestId = String(params.pullRequestId);
  return withPrLifecycleLock(params.projectId, pullRequestId, async () => {
    let status: 'active' | 'completed' | 'abandoned';
    try {
      status = await resolvedDeps.revalidatePullRequestStatus({
        projectId: params.projectId,
        pullRequestId: Number(pullRequestId),
      });
    } catch (error) {
      dbg.ipc(
        'Failed revalidating PR status for project %s PR %s: %O',
        params.projectId,
        pullRequestId,
        error,
      );
      return [];
    }
    const tasks = await resolvedDeps.findPrReviewTasksByPullRequest({
      projectId: params.projectId,
      pullRequestId,
    });
    if (status === 'active') {
      const taskIds = tasks
        .filter(
          (task) =>
            task.type === 'pr-review' &&
            task.projectId === params.projectId &&
            task.pullRequestId === pullRequestId &&
            (task.prWorkspaceState === 'cleanup-pending' ||
              task.prWorkspaceState === 'kept'),
        )
        .map((task) => task.id);
      if (taskIds.length === 0) return [];
      const reactivatedTasks =
        await resolvedDeps.reactivatePrWorkspaces(taskIds);
      for (const task of reactivatedTasks) {
        resolvedDeps.emitTaskUpsert(task);
      }
      return reactivatedTasks;
    }

    const taskIds = tasks
      .filter(
        (task) =>
          task.type === 'pr-review' &&
          task.projectId === params.projectId &&
          task.pullRequestId === pullRequestId &&
          task.prWorkspaceState === 'active',
      )
      .map((task) => task.id);
    if (taskIds.length === 0) return [];
    const keptTasks = await resolvedDeps.markPrWorkspacesKept({
      projectId: params.projectId,
      pullRequestId,
      taskIds,
    });
    for (const task of keptTasks) {
      resolvedDeps.emitTaskUpsert(task);
    }
    return keptTasks;
  });
}
