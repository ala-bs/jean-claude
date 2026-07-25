import type { Task } from '@shared/types';

type CleanupTask = Pick<
  Task,
  'id' | 'type' | 'pullRequestId' | 'worktreePath' | 'branchName'
>;

type CleanupTaskWorktreeDeps = {
  stopCommandsForTask: (taskId: string) => Promise<boolean | void>;
  pathExists: (path: string) => Promise<boolean>;
  closeEditorWindowsForTaskWorktree: (
    task: Pick<Task, 'id' | 'worktreePath'>,
  ) => Promise<string | undefined>;
  cleanupWorktree: (params: {
    worktreePath: string;
    projectPath: string;
    branchName: string | null;
    branchCleanup: 'delete' | 'keep';
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
  clearWorktreeMetadata: (taskId: string) => Promise<unknown>;
  getVerifiedCleanupIdentity?: (
    taskId: string,
  ) => Promise<{ worktreePath: string; branchName: string } | undefined>;
  markCleanupIdentityVerified?: (
    taskId: string,
    identity: { worktreePath: string; branchName: string },
  ) => Promise<void>;
  clearCleanupIdentity?: (taskId: string) => Promise<unknown>;
};

export async function getCleanupVerification(
  task: { id: string; worktreePath: string; branchName: string },
  deps: Pick<
    CleanupTaskWorktreeDeps,
    'getVerifiedCleanupIdentity' | 'markCleanupIdentityVerified'
  >,
) {
  const identity = {
    worktreePath: task.worktreePath,
    branchName: task.branchName,
  };
  const persisted = await deps.getVerifiedCleanupIdentity?.(task.id);
  const verified =
    persisted?.worktreePath === identity.worktreePath &&
    persisted.branchName === identity.branchName;
  return {
    verified,
    onVerified: verified
      ? undefined
      : deps.markCleanupIdentityVerified
        ? () => deps.markCleanupIdentityVerified!(task.id, identity)
        : undefined,
  };
}

export async function cleanupPrWorkspaceGitForDeletion(
  params: {
    task: Task;
    projectPath: string;
  },
  deps: {
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
      throwOnError: true;
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
    getVerifiedCleanupIdentity?: CleanupTaskWorktreeDeps['getVerifiedCleanupIdentity'];
    markCleanupIdentityVerified?: CleanupTaskWorktreeDeps['markCleanupIdentityVerified'];
    clearCleanupIdentity?: CleanupTaskWorktreeDeps['clearCleanupIdentity'];
  },
): Promise<{ task: Task; changed: boolean }> {
  const { task, projectPath } = params;
  const hasWorkspaceMetadata = Boolean(
    task.worktreePath ||
      task.branchName ||
      task.startCommitHash ||
      task.sourceBranch,
  );
  if (!hasWorkspaceMetadata) {
    await deps.clearCleanupIdentity?.(task.id);
    return { task, changed: false };
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
      projectPath,
      branchName: task.branchName,
      branchCleanup: 'delete',
      force: true,
      ...(verification?.onVerified && { onVerified: verification.onVerified }),
    });
  } else if (task.branchName) {
    await deps.cleanupMissingWorktree({
      worktreePath: task.worktreePath ?? undefined,
      projectPath,
      branchName: task.branchName,
      throwOnError: true,
      allowUnregistered: verification?.verified,
      ...(verification?.onVerified && { onVerified: verification.onVerified }),
    });
  }

  const clearedTask = await deps.clearWorktreeMetadata(task.id, {
    worktreePath: null,
    branchName: null,
    startCommitHash: null,
    sourceBranch: null,
  });
  await deps.clearCleanupIdentity?.(task.id);
  return { task: clearedTask, changed: true };
}

export async function ensureTaskCommandsStopped(
  taskId: string,
  stopCommandsForTask: (taskId: string) => Promise<boolean | void>,
): Promise<void> {
  if ((await stopCommandsForTask(taskId)) === false) {
    throw new Error(`Failed to stop commands for task ${taskId}`);
  }
}

export async function cleanupTaskForDeletion(
  params: {
    task: Pick<Task, 'id' | 'worktreePath' | 'branchName'>;
    projectPath: string;
    force: boolean;
  },
  deps: {
    stopCommandsForTask: (taskId: string) => Promise<boolean | void>;
    pathExists: (path: string) => Promise<boolean>;
    closeEditorWindowsForTaskWorktree: (
      task: Pick<Task, 'id' | 'worktreePath'>,
    ) => Promise<string | undefined>;
    cleanupWorktree: (params: {
      worktreePath: string;
      projectPath: string;
      branchName: string | null;
      skipIfChanges: boolean;
      branchCleanup: 'delete';
      force: boolean;
      onVerified?: () => void | Promise<void>;
    }) => Promise<void>;
    cleanupMissingWorktree: (params: {
      worktreePath: string;
      projectPath: string;
      branchName: string;
      throwOnError: true;
      allowUnregistered?: boolean;
      onVerified?: () => void | Promise<void>;
    }) => Promise<void>;
    getVerifiedCleanupIdentity?: CleanupTaskWorktreeDeps['getVerifiedCleanupIdentity'];
    markCleanupIdentityVerified?: CleanupTaskWorktreeDeps['markCleanupIdentityVerified'];
  },
): Promise<void> {
  const { task, projectPath, force } = params;
  if (!task.worktreePath) return;
  await ensureTaskCommandsStopped(task.id, deps.stopCommandsForTask);
  await deps.closeEditorWindowsForTaskWorktree(task);
  if (!task.branchName) {
    throw new Error(`Task ${task.id} has no branch metadata`);
  }
  const verification = await getCleanupVerification(
    { ...task, worktreePath: task.worktreePath, branchName: task.branchName },
    deps,
  );
  if (await deps.pathExists(task.worktreePath)) {
    await deps.cleanupWorktree({
      worktreePath: task.worktreePath,
      projectPath,
      branchName: task.branchName,
      skipIfChanges: !force,
      branchCleanup: 'delete',
      force,
      ...(verification.onVerified && {
        onVerified: verification.onVerified,
      }),
    });
  } else if (task.branchName) {
    await deps.cleanupMissingWorktree({
      worktreePath: task.worktreePath,
      projectPath,
      branchName: task.branchName,
      throwOnError: true,
      allowUnregistered: verification.verified,
      ...(verification.onVerified && {
        onVerified: verification.onVerified,
      }),
    });
  }
}

export function shouldUsePrReviewWorkspaceCleanup(
  task: Pick<Task, 'type' | 'pullRequestId'>,
): task is Pick<Task, 'type' | 'pullRequestId'> & {
  type: 'pr-review';
  pullRequestId: string;
} {
  return task.type === 'pr-review' && Boolean(task.pullRequestId);
}

export async function cleanupTaskWorktree(
  params: {
    task: CleanupTask & { worktreePath: string };
    projectPath: string;
    keepBranch: boolean;
  },
  deps: CleanupTaskWorktreeDeps,
): Promise<{ editorCloseWarning?: string }> {
  const { task, projectPath, keepBranch } = params;
  await ensureTaskCommandsStopped(task.id, deps.stopCommandsForTask);
  const worktreeExists = await deps.pathExists(task.worktreePath);
  const editorCloseWarning =
    await deps.closeEditorWindowsForTaskWorktree(task);
  const verification =
    !keepBranch && task.branchName
      ? await getCleanupVerification(
          { ...task, branchName: task.branchName },
          deps,
        )
      : undefined;

  if (worktreeExists) {
    await deps.cleanupWorktree({
      worktreePath: task.worktreePath,
      projectPath,
      branchName: task.branchName,
      branchCleanup: keepBranch ? 'keep' : 'delete',
      force: true,
      ...(verification?.onVerified && {
        onVerified: verification.onVerified,
      }),
    });
  } else if (!keepBranch && task.branchName) {
    await deps.cleanupMissingWorktree({
      worktreePath: task.worktreePath,
      projectPath,
      branchName: task.branchName,
      throwOnError: true,
      allowUnregistered: verification?.verified,
      ...(verification?.onVerified && {
        onVerified: verification.onVerified,
      }),
    });
  }

  await deps.clearWorktreeMetadata(task.id);
  await deps.clearCleanupIdentity?.(task.id);
  return { editorCloseWarning };
}

export async function completeTaskWithWorktreeCleanup(
  params: { task: Task; cleanupWorktree: boolean },
  deps: {
    stopCommandsForTask: (taskId: string) => Promise<boolean | void>;
    closeEditorWindowsForTaskWorktree: (
      task: Pick<Task, 'id' | 'worktreePath'>,
    ) => Promise<string | undefined>;
    cleanupPrReviewWorkspace: (
      task: Task,
    ) => Promise<{ task: Task; changed: boolean }>;
    cleanupTaskWorktree: (task: Task) => Promise<{ task: Task }>;
    markUserCompleted: (taskId: string) => Promise<Task>;
    clearWorktreeMetadata: (taskId: string) => Promise<Task>;
    cleanupFeatureMapTempDirs: (taskId: string) => Promise<void>;
    compactRawMessages: (taskId: string) => Promise<void>;
    emitTaskUpsert: (task: Task) => void;
  },
): Promise<{
  task: Task;
}> {
  const { task, cleanupWorktree } = params;
  let updatedTask = task;

  if (shouldUsePrReviewWorkspaceCleanup(task) && cleanupWorktree) {
    const cleanup = await deps.cleanupPrReviewWorkspace(task);
    updatedTask = cleanup.task;
    if (task.userCompleted && cleanup.changed) {
      deps.emitTaskUpsert(updatedTask);
    }
  } else if (
    cleanupWorktree &&
    task.worktreePath &&
    task.branchName
  ) {
    const cleanup = await deps.cleanupTaskWorktree(task);
    updatedTask = cleanup.task;
  } else if (!task.userCompleted) {
    await ensureTaskCommandsStopped(task.id, deps.stopCommandsForTask);
  }

  if (!task.userCompleted) {
    if (!cleanupWorktree) {
      await deps.closeEditorWindowsForTaskWorktree(task);
    }
    updatedTask = await deps.markUserCompleted(task.id);
    deps.emitTaskUpsert(updatedTask);
    await deps.cleanupFeatureMapTempDirs(task.id);
    await deps.compactRawMessages(task.id);
  }

  return { task: updatedTask };
}
