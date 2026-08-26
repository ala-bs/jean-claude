import type { BranchInfo, Task } from '@shared/types';

/**
 * Branch a worktree task lives on. `branchName` can be null for older tasks,
 * so fall back to the naming convention derived from the worktree folder.
 */
export function resolveTaskBranchName(
  task: Pick<Task, 'branchName' | 'worktreePath'>,
): string | null {
  if (task.branchName) return task.branchName;
  if (!task.worktreePath) return null;
  const folderName = task.worktreePath.split('/').pop() || '';
  return folderName ? `jean-claude/${folderName}` : null;
}

/**
 * Guards a manual source branch override. This is the safety net that makes it
 * acceptable to bypass `BACKEND_OWNED_UPDATE_FIELDS` on `tasks:update`.
 */
export function validateTaskSourceBranchChange({
  task,
  sourceBranch,
  branches,
}: {
  task: Pick<Task, 'type' | 'worktreePath' | 'branchName'>;
  sourceBranch: string;
  branches: Pick<BranchInfo, 'name'>[];
}): void {
  if (task.type === 'pr-review') {
    throw new Error('PR review tasks cannot change source branch');
  }
  if (!task.worktreePath) {
    throw new Error('Only worktree tasks have a source branch');
  }
  if (!sourceBranch.trim()) {
    throw new Error('Source branch is required');
  }
  if (sourceBranch === resolveTaskBranchName(task)) {
    throw new Error('Source branch cannot be the task branch itself');
  }
  if (!branches.some((branch) => branch.name === sourceBranch)) {
    throw new Error(`Branch ${sourceBranch} not found in repository`);
  }
}

/**
 * Guards a manual rename of the task's own worktree branch.
 */
export function validateTaskBranchRename({
  task,
  newBranch,
  branches,
}: {
  task: Pick<
    Task,
    | 'type'
    | 'worktreePath'
    | 'branchName'
    | 'sourceBranch'
    | 'status'
    | 'pullRequestId'
  >;
  newBranch: string;
  branches: Pick<BranchInfo, 'name'>[];
}): string {
  if (task.type === 'pr-review') {
    throw new Error('PR review tasks cannot rename their branch');
  }
  const currentBranch = resolveTaskBranchName(task);
  if (!task.worktreePath || !currentBranch) {
    throw new Error('Only worktree tasks have a branch');
  }
  if (task.pullRequestId) {
    throw new Error(
      'This task has a pull request. Renaming its branch would orphan the pull request.',
    );
  }
  if (task.status === 'running') {
    throw new Error('Stop the running session before renaming the branch');
  }
  const trimmed = newBranch.trim();
  if (!trimmed) {
    throw new Error('Branch name is required');
  }
  if (trimmed === currentBranch) {
    throw new Error('Branch name is unchanged');
  }
  if (trimmed === task.sourceBranch) {
    throw new Error('Task branch cannot be the source branch itself');
  }
  if (branches.some((branch) => branch.name === trimmed)) {
    throw new Error(`Branch ${trimmed} already exists`);
  }
  return currentBranch;
}
