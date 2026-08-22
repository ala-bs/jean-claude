import type {
  PrWorkspaceResolutionResult,
  Task,
  TaskStep,
} from '@shared/types';

import { cleanupPrWorkspaceGitForDeletion } from './task-worktree-cleanup-service';
import { dbg } from '../lib/debug';
import { withPrLifecycleLock } from './pr-review-task-service';

export type PrWorkspaceDeletionDeps = {
  findTaskById: (taskId: string) => Promise<Task | undefined>;
  findPrReviewTasksByPullRequest: (params: {
    projectId: string;
    pullRequestId: string;
  }) => Promise<Task[]>;
  findStepsByTaskIds: (taskIds: string[]) => Promise<Record<string, TaskStep[]>>;
  findProjectById: (
    projectId: string,
  ) => Promise<{ id: string; path: string } | undefined>;
  stopCommandsForTask: (taskId: string) => Promise<boolean | void>;
  stopAgent: (stepId: string) => Promise<void>;
  closeEditorWindowsForTaskWorktree: (
    task: Pick<Task, 'id' | 'worktreePath'>,
  ) => Promise<string | undefined>;
  cleanupPrWorkspaceGit: (params: {
    task: Task;
    projectPath: string;
  }) => Promise<{ task: Task; changed: boolean }>;
  deleteTasks: (taskIds: string[]) => Promise<unknown>;
  emitTaskUpsert: (task: Task) => void;
  emitTaskDelete: (params: {
    taskId: string;
    projectId: string;
    stepIds: string[];
  }) => void;
};

async function getDefaultDeps(): Promise<PrWorkspaceDeletionDeps> {
  const [
    { ProjectRepository, TaskRepository },
    { TaskStepRepository },
    { agentService },
    { runCommandService },
    { closeEditorWindowsForTaskWorktree },
    { cleanupMissingWorktree, cleanupWorktree },
    { pathExists },
    { emitTaskDelete, emitTaskUpsert },
  ] = await Promise.all([
    import('../database/repositories'),
    import('../database/repositories/task-steps'),
    import('./agent-service'),
    import('./run-command-service'),
    import('./editor-automation-service'),
    import('./worktree-service'),
    import('../lib/fs'),
    import('./cache-event-service'),
  ]);

  return {
    findTaskById: TaskRepository.findById,
    findPrReviewTasksByPullRequest:
      TaskRepository.findPrReviewTasksByPullRequest,
    findStepsByTaskIds: TaskStepRepository.findByTaskIds,
    findProjectById: ProjectRepository.findById,
    stopCommandsForTask: (taskId) =>
      runCommandService.stopCommandsForTask(taskId),
    stopAgent: (stepId) => agentService.stop(stepId),
    closeEditorWindowsForTaskWorktree,
    cleanupPrWorkspaceGit: (params) =>
      cleanupPrWorkspaceGitForDeletion(params, {
        pathExists,
        cleanupWorktree,
        cleanupMissingWorktree,
        clearWorktreeMetadata: TaskRepository.update,
        getVerifiedCleanupIdentity: TaskRepository.getVerifiedCleanupIdentity,
        markCleanupIdentityVerified: TaskRepository.markCleanupIdentityVerified,
        clearCleanupIdentity: TaskRepository.clearCleanupIdentity,
      }),
    deleteTasks: TaskRepository.deleteMany,
    emitTaskUpsert,
    emitTaskDelete,
  };
}

function validateTasks(
  tasks: Task[],
  expected: { projectId: string; pullRequestId: string; taskId?: string },
): asserts tasks is Array<Task & { type: 'pr-review'; pullRequestId: string }> {
  for (const task of tasks) {
    if (
      task.type !== 'pr-review' ||
      task.projectId !== expected.projectId ||
      task.pullRequestId !== expected.pullRequestId ||
      (expected.taskId !== undefined && task.id !== expected.taskId)
    ) {
      throw new Error(`Task ${task.id} does not match requested PR workspace`);
    }
  }
}

function validatePullRequestId(pullRequestId: number): void {
  if (!Number.isSafeInteger(pullRequestId) || pullRequestId <= 0) {
    throw new Error('Invalid pullRequestId: must be a positive safe integer');
  }
}

async function runPhase(
  operations: Array<() => Promise<unknown>>,
  phase: 'commands' | 'agents' | 'editors',
): Promise<void> {
  const results = await Promise.allSettled(
    operations.map((operation) => operation()),
  );
  if (results.some((result) => result.status === 'rejected')) {
    throw new Error(`Failed PR workspace ${phase} phase`);
  }
}

function emitSafely(operation: () => void, eventType: string, taskId: string) {
  try {
    operation();
  } catch (error) {
    dbg.ipc(
      'Failed emitting %s for PR workspace task %s after commit: %O',
      eventType,
      taskId,
      error,
    );
  }
}

async function deleteTargetsUnlocked(
  tasks: Array<Task & { type: 'pr-review'; pullRequestId: string }>,
  deps: PrWorkspaceDeletionDeps,
): Promise<void> {
  if (tasks.length === 0) return;

  const stepsByTaskId = await deps.findStepsByTaskIds(
    tasks.map((task) => task.id),
  );
  const project = await deps.findProjectById(tasks[0].projectId);
  if (!project) throw new Error(`Project ${tasks[0].projectId} not found`);

  await runPhase(
    tasks.map((task) => async () => {
      if ((await deps.stopCommandsForTask(task.id)) === false) {
        throw new Error(`Failed to stop commands for task ${task.id}`);
      }
    }),
    'commands',
  );

  const stepIds = tasks.flatMap((task) =>
    (stepsByTaskId[task.id] ?? []).map((step) => step.id),
  );
  await runPhase(
    stepIds.map((stepId) => () => deps.stopAgent(stepId)),
    'agents',
  );

  await runPhase(
    tasks.map((task) => () => deps.closeEditorWindowsForTaskWorktree(task)),
    'editors',
  );

  for (const task of tasks) {
    const cleanup = await deps.cleanupPrWorkspaceGit({
      task,
      projectPath: project.path,
    });
    if (cleanup.changed) {
      emitSafely(
        () => deps.emitTaskUpsert(cleanup.task),
        'task.upsert',
        task.id,
      );
    }
  }

  await deps.deleteTasks(tasks.map((task) => task.id));
  for (const task of tasks) {
    emitSafely(
      () =>
        deps.emitTaskDelete({
          taskId: task.id,
          projectId: task.projectId,
          stepIds: (stepsByTaskId[task.id] ?? []).map((step) => step.id),
        }),
      'task.delete',
      task.id,
    );
  }
}

export async function deletePrWorkspaceTask(
  params: { taskId: string },
  deps?: PrWorkspaceDeletionDeps,
): Promise<PrWorkspaceResolutionResult> {
  const resolvedDeps = deps ?? (await getDefaultDeps());
  const initialTask = await resolvedDeps.findTaskById(params.taskId);
  if (!initialTask) return { action: 'deleted', taskIds: [] };
  if (initialTask.type !== 'pr-review' || !initialTask.pullRequestId) {
    throw new Error(`Task ${initialTask.id} is not a PR review task`);
  }
  const identity = {
    taskId: initialTask.id,
    projectId: initialTask.projectId,
    pullRequestId: initialTask.pullRequestId,
  };

  return withPrLifecycleLock(identity.projectId, identity.pullRequestId, async () => {
    const task = await resolvedDeps.findTaskById(identity.taskId);
    if (!task) return { action: 'deleted' as const, taskIds: [] };
    const tasks = [task];
    validateTasks(tasks, identity);
    await deleteTargetsUnlocked(tasks, resolvedDeps);
    return { action: 'deleted' as const, taskIds: [task.id] };
  });
}

export async function deleteAllPrWorkspaces(
  params: { projectId: string; pullRequestId: number },
  deps?: PrWorkspaceDeletionDeps,
): Promise<PrWorkspaceResolutionResult> {
  validatePullRequestId(params.pullRequestId);
  const resolvedDeps = deps ?? (await getDefaultDeps());
  const pullRequestId = String(params.pullRequestId);
  return withPrLifecycleLock(params.projectId, pullRequestId, async () => {
    const tasks = await resolvedDeps.findPrReviewTasksByPullRequest({
      projectId: params.projectId,
      pullRequestId,
    });
    validateTasks(tasks, { projectId: params.projectId, pullRequestId });
    await deleteTargetsUnlocked(tasks, resolvedDeps);
    return {
      action: 'deleted' as const,
      taskIds: tasks.map((task) => task.id),
    };
  });
}

export async function routeTaskDeletion(
  params: { taskId: string },
  deps: {
    findTaskById: (taskId: string) => Promise<Task | undefined>;
    deletePrWorkspaceTask: (params: { taskId: string }) => Promise<unknown>;
    deleteGenericTask: (task: Task | undefined) => Promise<unknown>;
  },
): Promise<void> {
  const task = await deps.findTaskById(params.taskId);
  if (task?.type === 'pr-review') {
    await deps.deletePrWorkspaceTask(params);
    return;
  }
  await deps.deleteGenericTask(task);
}
