const MAX_ERROR_DETAIL_LENGTH = 200;

/** Flattens error causes into the message so IPC-serialized errors stay debuggable. */
export function describeErrors(errors: unknown[]): string {
  return errors
    .map((error) => {
      const message =
        error instanceof Error ? error.message : String(error);
      const firstLine = message.split('\n')[0] ?? '';
      return firstLine.length > MAX_ERROR_DETAIL_LENGTH
        ? `${firstLine.slice(0, MAX_ERROR_DETAIL_LENGTH)}…`
        : firstLine;
    })
    .join('; ');
}

export function createTaskRuntimeCleanupService(deps: {
  stopRunCommandsForTask: (taskId: string) => Promise<void>;
  stopMobilePreviewSessionsByTask: (taskId: string) => Promise<void>;
  resetRunCommandTaskAfterReactivation: (taskId: string) => Promise<void>;
  resetMobilePreviewTaskAfterReactivation: (taskId: string) => Promise<void>;
}) {
  async function runAll(
    taskId: string,
    label: string,
    operations: Array<() => Promise<void>>,
  ): Promise<void> {
    const results = await Promise.allSettled(
      operations.map((operation) => Promise.resolve().then(operation)),
    );
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Failed to ${label}: ${taskId} (${describeErrors(errors)})`,
      );
    }
  }

  const service = {
    stopByTask(taskId: string): Promise<void> {
      return runAll(taskId, 'stop task runtime', [
        () => deps.stopRunCommandsForTask(taskId),
        () => deps.stopMobilePreviewSessionsByTask(taskId),
      ]);
    },

    resetAfterReactivation(taskId: string): Promise<void> {
      return runAll(taskId, 'reset task runtime', [
        () => deps.resetRunCommandTaskAfterReactivation(taskId),
        () => deps.resetMobilePreviewTaskAfterReactivation(taskId),
      ]);
    },

    async runProvisionalTransition<Result>(
      taskId: string,
      transition: () => Promise<Result>,
      isTerminal: (result: Result) => boolean,
    ): Promise<Result> {
      const rollbackAndThrow = async (error: unknown): Promise<never> => {
        try {
          await service.resetAfterReactivation(taskId);
        } catch (resetError) {
          throw new AggregateError(
            [error, resetError],
            `Task transition and runtime reset failed: ${taskId} (${describeErrors([error, resetError])})`,
          );
        }
        throw error;
      };

      let result: Result;
      try {
        await service.stopByTask(taskId);
        result = await transition();
      } catch (error) {
        return rollbackAndThrow(error);
      }

      let terminal: boolean;
      try {
        terminal = isTerminal(result);
      } catch (error) {
        return rollbackAndThrow(error);
      }
      if (!terminal) {
        await service.resetAfterReactivation(taskId);
      }
      return result;
    },
  };
  return service;
}

export const taskRuntimeCleanupService = createTaskRuntimeCleanupService({
  stopRunCommandsForTask: async (taskId) => {
    const { runCommandService } = await import('./run-command-service');
    await runCommandService.stopCommandsForTask(taskId);
  },
  stopMobilePreviewSessionsByTask: async (taskId) => {
    const { mobilePreviewService } = await import('./mobile-preview-service');
    await mobilePreviewService.stopByTask(taskId);
  },
  resetRunCommandTaskAfterReactivation: async (taskId) => {
    const { runCommandService } = await import('./run-command-service');
    await runCommandService.resetTaskAfterReactivation(taskId);
  },
  resetMobilePreviewTaskAfterReactivation: async (taskId) => {
    const { mobilePreviewService } = await import('./mobile-preview-service');
    await mobilePreviewService.resetTaskAfterReactivation(taskId);
  },
});
