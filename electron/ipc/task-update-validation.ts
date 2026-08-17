import {
  isPrReviewChatStepMeta,
  type NewTask,
  type NewTaskStep,
  type Task,
  type TaskStep,
  type TaskStepMeta,
  type UpdateTask,
  type UpdateTaskStep,
} from '@shared/types';

function hasPrReviewChatKind(meta: TaskStepMeta | null | undefined): boolean {
  return (meta as { kind?: unknown } | null | undefined)?.kind === 'pr-review-chat';
}

export function sanitizeRendererTaskCreate<T extends NewTask>(
  data: T,
): Omit<
  T,
  | 'worktreePath'
  | 'branchName'
  | 'startCommitHash'
  | 'prWorkspaceState'
  | 'prWorkspacePendingAt'
> {
  if (data.type === 'pr-review') {
    throw new Error(
      'PR review tasks must be created through the PR Workspace API',
    );
  }

  const {
    worktreePath: _worktreePath,
    branchName: _branchName,
    startCommitHash: _startCommitHash,
    prWorkspaceState: _prWorkspaceState,
    prWorkspacePendingAt: _prWorkspacePendingAt,
    ...safeData
  } = data as T & { prWorkspacePendingAt?: unknown };
  return safeData;
}

const BACKEND_OWNED_UPDATE_FIELDS = [
  'projectId',
  'worktreePath',
  'startCommitHash',
  'sourceBranch',
  'branchName',
  'prWorkspaceState',
  'prWorkspacePendingAt',
] as const;

const PR_REVIEW_PROTECTED_UPDATE_FIELDS = [
  'pullRequestId',
  'pullRequestUrl',
  'status',
  'userCompleted',
] as const satisfies readonly (keyof UpdateTask)[];

export function validateRendererTaskUpdate(
  task: Pick<Task, 'id' | 'type'>,
  data: UpdateTask,
): void {
  for (const field of BACKEND_OWNED_UPDATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      throw new Error(`Cannot update backend-owned task ${field} from renderer`);
    }
  }

  if (task.type !== 'pr-review') return;

  for (const field of PR_REVIEW_PROTECTED_UPDATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      throw new Error(
        `Cannot update PR review task ${field} from renderer; use lifecycle service`,
      );
    }
  }
}

export function validateRendererStepCreate(
  task: Pick<Task, 'id'>,
  data: NewTaskStep,
): void {
  if (data.taskId !== task.id) {
    throw new Error(`Step task ${data.taskId} does not match parent task ${task.id}`);
  }
  if (hasPrReviewChatKind(data.meta)) {
    throw new Error('PR review chat steps must be created through the chat API');
  }
  if (Object.prototype.hasOwnProperty.call(data, 'sessionRules')) {
    throw new Error(
      'Step session rules cannot be set through generic step APIs',
    );
  }
}

export function validateRendererStepUpdate(
  step: Pick<TaskStep, 'meta'>,
  data: UpdateTaskStep,
): void {
  if (isPrReviewChatStepMeta(step.meta) || hasPrReviewChatKind(step.meta)) {
    throw new Error(
      'PR review chat steps cannot be updated through generic step APIs',
    );
  }
  if (hasPrReviewChatKind(data.meta)) {
    throw new Error('PR review chat metadata cannot be set through generic step APIs');
  }
  if (Object.prototype.hasOwnProperty.call(data, 'sessionRules')) {
    throw new Error(
      'Step session rules cannot be updated through generic step APIs',
    );
  }
}

export function validateRendererStepArchive(
  step: Pick<TaskStep, 'meta'>,
): void {
  if (isPrReviewChatStepMeta(step.meta) || hasPrReviewChatKind(step.meta)) {
    throw new Error('PR review chat steps are read-only and cannot be archived');
  }
}

export function validateRendererStepModeChange(
  step: Pick<TaskStep, 'meta'>,
): void {
  if (isPrReviewChatStepMeta(step.meta) || hasPrReviewChatKind(step.meta)) {
    throw new Error('PR review chat steps are read-only and cannot change mode');
  }
}
