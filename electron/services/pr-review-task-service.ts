import { execFile } from 'child_process';
import { promisify } from 'util';

import { type PermissionScope } from '@shared/permission-types';
import { type Task } from '@shared/types';

import { buildReadOnlyPrReviewSessionRules } from './pr-review-agent-service';
import { dbg } from '../lib/debug';

const execFileAsync = promisify(execFile);

type CreateTaskInput = {
  projectId: string;
  type: 'pr-review';
  prompt: string;
  name: string;
  worktreePath: string;
  startCommitHash: string;
  branchName: string;
  sourceBranch: string;
  pullRequestId: string;
  pullRequestUrl: string | null;
  sessionRules: PermissionScope;
  updatedAt: string;
};

type RestoreTaskWorktreeInput = {
  worktreePath: string;
  startCommitHash: string;
  branchName: string;
  sourceBranch: string;
  pullRequestUrl: string | null;
  sessionRules: PermissionScope;
  updatedAt: string;
};

type PrReviewProject = {
  id: string;
  name: string;
  path: string;
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
    url?: string | null;
  }>;
  fetchSourceBranch: (params: {
    projectPath: string;
    sourceBranch: string;
  }) => Promise<void>;
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
  createTask: (data: CreateTaskInput) => Promise<Task>;
  updateTask: (taskId: string, data: RestoreTaskWorktreeInput) => Promise<Task>;
};

type CompletePrReviewTasksDeps = {
  findPrReviewTasksByPullRequest: (params: {
    projectId: string;
    pullRequestId: string;
  }) => Promise<Task[]>;
  updateTaskStatus: (
    taskId: string,
    data: { status: 'completed' },
  ) => Promise<Task>;
  markUserCompleted: (taskId: string) => Promise<Task>;
  compactRawMessages: (taskId: string) => Promise<void>;
  emitTaskUpsert: (task: Task) => void;
};

async function getDefaultCompletePrReviewTasksDeps(): Promise<CompletePrReviewTasksDeps> {
  const [{ TaskRepository }, { emitTaskUpsert }, { agentService }] =
    await Promise.all([
      import('../database/repositories'),
      import('./cache-event-service'),
      import('./agent-service'),
    ]);

  return {
    findPrReviewTasksByPullRequest:
      TaskRepository.findPrReviewTasksByPullRequest,
    updateTaskStatus: TaskRepository.update,
    markUserCompleted: TaskRepository.markUserCompleted,
    compactRawMessages: (taskId) => agentService.compactRawMessages(taskId),
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

export async function createOrGetPrReviewTask(
  params: {
    projectId: string;
    pullRequestId: number;
  },
  deps: PrReviewTaskDeps,
): Promise<{ task: Task; created: boolean }> {
  const { projectId, pullRequestId } = params;
  const existingTask = await deps.findActivePrReviewTask({
    projectId,
    pullRequestId: String(pullRequestId),
  });
  if (existingTask?.worktreePath) return { task: existingTask, created: false };
  if (existingTask?.status === 'completed' || existingTask?.userCompleted) {
    throw new Error('PR review task is completed and cannot recreate a worktree');
  }

  const project = await deps.findProjectById(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  if (project.archivedAt) {
    throw new Error('Cannot create tasks for archived projects');
  }
  if (!project.repoProviderId || !project.repoProjectId || !project.repoId) {
    throw new Error('Project has no linked repository');
  }

  const pr = await deps.getPullRequest({
    providerId: project.repoProviderId,
    projectId: project.repoProjectId,
    repoId: project.repoId,
    pullRequestId,
  });
  const sourceBranch = pr.sourceRefName.replace('refs/heads/', '');
  const rawName = `Review: ${pr.title}`;
  const taskName = rawName.length > 40 ? rawName.slice(0, 37) + '...' : rawName;
  const remoteSourceBranch = `origin/${sourceBranch}`;

  try {
    await deps.fetchSourceBranch({
      projectPath: project.path,
      sourceBranch,
    });
  } catch (fetchError) {
    dbg.ipc(
      'Failed to fetch origin/%s before review worktree creation: %O',
      sourceBranch,
      fetchError,
    );
  }

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

  const { worktreePath, startCommitHash, branchName } = worktreeResult;
  if (existingTask) {
    const task = await deps.updateTask(existingTask.id, {
      worktreePath,
      startCommitHash,
      branchName,
      sourceBranch,
      pullRequestUrl: pr.url ?? null,
      sessionRules: buildReadOnlyPrReviewSessionRules(),
      updatedAt: new Date().toISOString(),
    });

    return { task, created: false };
  }

  const task = await deps.createTask({
    projectId,
    type: 'pr-review',
    prompt: `Review PR #${pullRequestId}: ${pr.title}`,
    name: taskName,
    worktreePath,
    startCommitHash,
    branchName,
    sourceBranch,
    pullRequestId: String(pullRequestId),
    pullRequestUrl: pr.url ?? null,
    sessionRules: buildReadOnlyPrReviewSessionRules(),
    updatedAt: new Date().toISOString(),
  });

  return { task, created: true };
}

export async function completePrReviewTasksForMergedPr(
  params: {
    projectId: string;
    pullRequestId: number | string;
  },
  deps?: CompletePrReviewTasksDeps,
): Promise<Task[]> {
  const resolvedDeps = deps ?? (await getDefaultCompletePrReviewTasksDeps());
  const completedTasks: Task[] = [];
  const pullRequestId = String(params.pullRequestId);
  const tasks = await resolvedDeps.findPrReviewTasksByPullRequest({
    projectId: params.projectId,
    pullRequestId,
  });

  for (const task of tasks) {
    if (task.type !== 'pr-review') continue;
    if (task.pullRequestId !== pullRequestId) continue;
    if (task.status === 'completed' && task.userCompleted) continue;

    let updatedTask = await resolvedDeps.updateTaskStatus(task.id, {
      status: 'completed',
    });
    if (!task.userCompleted) {
      updatedTask = await resolvedDeps.markUserCompleted(task.id);
      await resolvedDeps.compactRawMessages(task.id);
    }

    resolvedDeps.emitTaskUpsert(updatedTask);
    completedTasks.push(updatedTask);
  }

  return completedTasks;
}
