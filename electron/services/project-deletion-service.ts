import { ProjectRepository, TaskRepository } from '../database/repositories';

import { taskRuntimeCleanupService } from './task-runtime-cleanup-service';

export async function deleteProjectRetainingMemory(projectId: string) {
  const tasks = await TaskRepository.findByProjectId(projectId);
  const cleanupResults = await Promise.allSettled(
    tasks.map((task) => taskRuntimeCleanupService.stopByTask(task.id)),
  );
  const cleanupErrors = cleanupResults.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );

  const rollbackAndThrow = async (transitionError: unknown): Promise<never> => {
    const resetResults = await Promise.allSettled(
      tasks.map((task) =>
        taskRuntimeCleanupService.resetAfterReactivation(task.id),
      ),
    );
    const resetErrors = resetResults.flatMap((resetResult) =>
      resetResult.status === 'rejected' ? [resetResult.reason] : [],
    );
    throw new AggregateError(
      [transitionError, ...resetErrors],
      `Project deletion and runtime reset failed: ${projectId}`,
    );
  };

  if (cleanupErrors.length > 0) {
    await rollbackAndThrow(
      cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(
            cleanupErrors,
            `Failed to stop project task runtimes: ${projectId}`,
          ),
    );
  }

  return ProjectRepository.delete(projectId).catch(rollbackAndThrow);
}
