import { describe, expect, it, vi } from 'vitest';

vi.mock('./mobile-preview-service', () => ({
  mobilePreviewService: {},
}));
vi.mock('./run-command-service', () => ({
  runCommandService: {},
}));

import { createTaskRuntimeCleanupService } from './task-runtime-cleanup-service';

describe('task runtime cleanup service', () => {
  it('stops run commands and mobile previews for a task', async () => {
    const deps = {
      stopRunCommandsForTask: vi.fn().mockResolvedValue(undefined),
      stopMobilePreviewSessionsByTask: vi.fn().mockResolvedValue(undefined),
      resetRunCommandTaskAfterReactivation: vi.fn().mockResolvedValue(undefined),
      resetMobilePreviewTaskAfterReactivation: vi.fn().mockResolvedValue(undefined),
    };
    const service = createTaskRuntimeCleanupService(deps);

    await service.stopByTask('task-1');

    expect(deps.stopRunCommandsForTask).toHaveBeenCalledWith('task-1');
    expect(deps.stopMobilePreviewSessionsByTask).toHaveBeenCalledWith('task-1');
  });

  it('attempts both cleanup operations and aggregates sync and async failures', async () => {
    const deps = {
      stopRunCommandsForTask: vi.fn(() => {
        throw new Error('commands');
      }),
      stopMobilePreviewSessionsByTask: vi.fn().mockRejectedValue(new Error('preview')),
      resetRunCommandTaskAfterReactivation: vi.fn().mockResolvedValue(undefined),
      resetMobilePreviewTaskAfterReactivation: vi.fn().mockResolvedValue(undefined),
    };
    const service = createTaskRuntimeCleanupService(deps);

    const error = await service.stopByTask('task-1').catch((reason) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toHaveLength(2);
    expect(deps.stopRunCommandsForTask).toHaveBeenCalled();
    expect(deps.stopMobilePreviewSessionsByTask).toHaveBeenCalled();
  });

  it('resets command and preview task eligibility after reactivation', async () => {
    const deps = {
      stopRunCommandsForTask: vi.fn().mockResolvedValue(undefined),
      stopMobilePreviewSessionsByTask: vi.fn().mockResolvedValue(undefined),
      resetRunCommandTaskAfterReactivation: vi.fn().mockResolvedValue(undefined),
      resetMobilePreviewTaskAfterReactivation: vi.fn().mockResolvedValue(undefined),
    };
    const service = createTaskRuntimeCleanupService(deps);

    await service.resetAfterReactivation('task-1');

    expect(deps.resetRunCommandTaskAfterReactivation).toHaveBeenCalledWith(
      'task-1',
    );
    expect(deps.resetMobilePreviewTaskAfterReactivation).toHaveBeenCalledWith(
      'task-1',
    );
  });

  it('rolls back provisional cleanup when transition returns a failed result', async () => {
    const deps = {
      stopRunCommandsForTask: vi.fn().mockResolvedValue(undefined),
      stopMobilePreviewSessionsByTask: vi.fn().mockResolvedValue(undefined),
      resetRunCommandTaskAfterReactivation: vi.fn().mockResolvedValue(undefined),
      resetMobilePreviewTaskAfterReactivation: vi.fn().mockResolvedValue(undefined),
    };
    const service = createTaskRuntimeCleanupService(deps);

    await expect(
      service.runProvisionalTransition(
        'task-1',
        async () => ({ success: false }),
        (result) => result.success,
      ),
    ).resolves.toEqual({ success: false });
    expect(deps.stopRunCommandsForTask).toHaveBeenCalledWith('task-1');
    expect(deps.stopMobilePreviewSessionsByTask).toHaveBeenCalledWith('task-1');
    expect(deps.resetRunCommandTaskAfterReactivation).toHaveBeenCalledWith(
      'task-1',
    );
    expect(deps.resetMobilePreviewTaskAfterReactivation).toHaveBeenCalledWith(
      'task-1',
    );
  });

  it('rolls back provisional cleanup when transition throws', async () => {
    const deps = {
      stopRunCommandsForTask: vi.fn().mockResolvedValue(undefined),
      stopMobilePreviewSessionsByTask: vi.fn().mockResolvedValue(undefined),
      resetRunCommandTaskAfterReactivation: vi.fn().mockResolvedValue(undefined),
      resetMobilePreviewTaskAfterReactivation: vi.fn().mockResolvedValue(undefined),
    };
    const service = createTaskRuntimeCleanupService(deps);

    await expect(
      service.runProvisionalTransition(
        'task-1',
        async () => {
          throw new Error('merge failed');
        },
        () => true,
      ),
    ).rejects.toThrow('merge failed');
    expect(deps.resetRunCommandTaskAfterReactivation).toHaveBeenCalledWith(
      'task-1',
    );
    expect(deps.resetMobilePreviewTaskAfterReactivation).toHaveBeenCalledWith(
      'task-1',
    );
  });

  it('keeps successful provisional transition terminal', async () => {
    const deps = {
      stopRunCommandsForTask: vi.fn().mockResolvedValue(undefined),
      stopMobilePreviewSessionsByTask: vi.fn().mockResolvedValue(undefined),
      resetRunCommandTaskAfterReactivation: vi.fn().mockResolvedValue(undefined),
      resetMobilePreviewTaskAfterReactivation: vi.fn().mockResolvedValue(undefined),
    };
    const service = createTaskRuntimeCleanupService(deps);

    await service.runProvisionalTransition(
      'task-1',
      async () => ({ success: true }),
      (result) => result.success,
    );

    expect(deps.resetRunCommandTaskAfterReactivation).not.toHaveBeenCalled();
    expect(deps.resetMobilePreviewTaskAfterReactivation).not.toHaveBeenCalled();
  });

  it('rolls back eligibility when provisional cleanup itself rejects', async () => {
    const deps = {
      stopRunCommandsForTask: vi.fn().mockRejectedValue(new Error('stop failed')),
      stopMobilePreviewSessionsByTask: vi.fn().mockResolvedValue(undefined),
      resetRunCommandTaskAfterReactivation: vi.fn().mockResolvedValue(undefined),
      resetMobilePreviewTaskAfterReactivation: vi.fn().mockResolvedValue(undefined),
    };
    const service = createTaskRuntimeCleanupService(deps);
    const transition = vi.fn();

    await expect(
      service.runProvisionalTransition('task-1', transition, () => true),
    ).rejects.toThrow('Failed to stop task runtime: task-1');
    expect(transition).not.toHaveBeenCalled();
    expect(deps.resetRunCommandTaskAfterReactivation).toHaveBeenCalledOnce();
    expect(deps.resetMobilePreviewTaskAfterReactivation).toHaveBeenCalledOnce();
  });

  it('attempts both runtime resets after a partial stop failure', async () => {
    const stopError = new Error('preview stop failed');
    const deps = {
      stopRunCommandsForTask: vi.fn().mockResolvedValue(undefined),
      stopMobilePreviewSessionsByTask: vi.fn().mockRejectedValue(stopError),
      resetRunCommandTaskAfterReactivation: vi.fn().mockResolvedValue(undefined),
      resetMobilePreviewTaskAfterReactivation: vi.fn().mockResolvedValue(undefined),
    };
    const service = createTaskRuntimeCleanupService(deps);
    const transition = vi.fn();

    const error = await service
      .runProvisionalTransition('task-1', transition, () => true)
      .catch((reason) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw error;
    expect(error.errors).toContain(stopError);
    expect(transition).not.toHaveBeenCalled();
    expect(deps.resetRunCommandTaskAfterReactivation).toHaveBeenCalledWith(
      'task-1',
    );
    expect(deps.resetMobilePreviewTaskAfterReactivation).toHaveBeenCalledWith(
      'task-1',
    );
  });
});
