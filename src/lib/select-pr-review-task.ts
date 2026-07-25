import type { Task } from '@shared/types';

export function selectNewestPrReviewTask({
  tasks,
  projectId,
  pullRequestId,
}: {
  tasks: Task[];
  projectId: string;
  pullRequestId: string;
}) {
  return (
    tasks
      .filter(
        (task) =>
          task.projectId === projectId &&
          task.type === 'pr-review' &&
          task.pullRequestId === pullRequestId,
      )
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          right.id.localeCompare(left.id),
      )[0] ?? null
  );
}
