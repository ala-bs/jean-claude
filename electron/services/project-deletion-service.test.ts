import { beforeEach, describe, expect, it, vi } from 'vitest';

const repositories = vi.hoisted(() => ({
  ProjectRepository: {
    delete: vi.fn(),
  },
  TaskRepository: {
    findByProjectId: vi.fn(),
  },
}));

const storage = vi.hoisted(() => ({
  removeProjectAgentMemory: vi.fn(),
}));

vi.mock('../database/repositories', () => repositories);
vi.mock('./agent-memory-storage', () => storage);
const runtimeCleanup = vi.hoisted(() => ({
  stopByTask: vi.fn(),
  resetAfterReactivation: vi.fn(),
}));
vi.mock('./task-runtime-cleanup-service', () => ({
  taskRuntimeCleanupService: runtimeCleanup,
}));

import { deleteProjectRetainingMemory } from './project-deletion-service';

describe('deleteProjectRetainingMemory', () => {
  beforeEach(() => {
    repositories.ProjectRepository.delete.mockReset();
    repositories.TaskRepository.findByProjectId.mockReset();
    repositories.TaskRepository.findByProjectId.mockResolvedValue([]);
    runtimeCleanup.stopByTask.mockReset();
    runtimeCleanup.stopByTask.mockResolvedValue(undefined);
    runtimeCleanup.resetAfterReactivation.mockReset();
    runtimeCleanup.resetAfterReactivation.mockResolvedValue(undefined);
    storage.removeProjectAgentMemory.mockReset();
  });

  it('deletes the project without removing retained Agent Memory', async () => {
    const deletionResult = [{ numDeletedRows: 1n }];
    repositories.ProjectRepository.delete.mockResolvedValue(deletionResult);

    await expect(
      deleteProjectRetainingMemory('project-1'),
    ).resolves.toBe(deletionResult);

    expect(repositories.ProjectRepository.delete).toHaveBeenCalledWith(
      'project-1',
    );
    expect(storage.removeProjectAgentMemory).not.toHaveBeenCalled();
  });

  it('stops task runtimes before project cascade deletion', async () => {
    repositories.TaskRepository.findByProjectId.mockResolvedValue([
      { id: 'task-1' },
      { id: 'task-2' },
    ]);
    repositories.ProjectRepository.delete.mockResolvedValue([]);

    await deleteProjectRetainingMemory('project-1');

    expect(runtimeCleanup.stopByTask).toHaveBeenCalledWith('task-1');
    expect(runtimeCleanup.stopByTask).toHaveBeenCalledWith('task-2');
    expect(runtimeCleanup.stopByTask.mock.invocationCallOrder.at(-1)).toBeLessThan(
      repositories.ProjectRepository.delete.mock.invocationCallOrder[0],
    );
    expect(runtimeCleanup.resetAfterReactivation).not.toHaveBeenCalled();
  });

  it('resets task runtime eligibility when project deletion fails', async () => {
    repositories.TaskRepository.findByProjectId.mockResolvedValue([
      { id: 'task-1' },
      { id: 'task-2' },
    ]);
    repositories.ProjectRepository.delete.mockRejectedValue(
      new Error('delete failed'),
    );

    const error = await deleteProjectRetainingMemory(
      'project-1',
    ).catch((reason) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([
      expect.objectContaining({ message: 'delete failed' }),
    ]);
    expect(runtimeCleanup.resetAfterReactivation).toHaveBeenCalledWith('task-1');
    expect(runtimeCleanup.resetAfterReactivation).toHaveBeenCalledWith('task-2');
  });

  it('aggregates cleanup and rollback failures and does not delete project', async () => {
    const cleanupError = new Error('task-1 cleanup failed');
    const resetError = new Error('task-2 reset failed');
    repositories.TaskRepository.findByProjectId.mockResolvedValue([
      { id: 'task-1' },
      { id: 'task-2' },
    ]);
    runtimeCleanup.stopByTask.mockImplementation(async (taskId: string) => {
      if (taskId === 'task-1') throw cleanupError;
    });
    runtimeCleanup.resetAfterReactivation.mockImplementation(
      async (taskId: string) => {
        if (taskId === 'task-2') throw resetError;
      },
    );

    const error = await deleteProjectRetainingMemory(
      'project-1',
    ).catch((reason) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([cleanupError, resetError]);
    expect(runtimeCleanup.stopByTask).toHaveBeenCalledWith('task-1');
    expect(runtimeCleanup.stopByTask).toHaveBeenCalledWith('task-2');
    expect(runtimeCleanup.resetAfterReactivation).toHaveBeenCalledWith('task-1');
    expect(runtimeCleanup.resetAfterReactivation).toHaveBeenCalledWith('task-2');
    expect(repositories.ProjectRepository.delete).not.toHaveBeenCalled();
  });

  it('aggregates deletion and every rollback failure', async () => {
    const deletionError = new Error('delete failed');
    const firstResetError = new Error('task-1 reset failed');
    const secondResetError = new Error('task-2 reset failed');
    repositories.TaskRepository.findByProjectId.mockResolvedValue([
      { id: 'task-1' },
      { id: 'task-2' },
    ]);
    repositories.ProjectRepository.delete.mockRejectedValue(deletionError);
    runtimeCleanup.resetAfterReactivation.mockRejectedValueOnce(firstResetError);
    runtimeCleanup.resetAfterReactivation.mockRejectedValueOnce(secondResetError);

    const error = await deleteProjectRetainingMemory(
      'project-1',
    ).catch((reason) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([
      deletionError,
      firstResetError,
      secondResetError,
    ]);
    expect(runtimeCleanup.resetAfterReactivation).toHaveBeenCalledTimes(2);
  });
});
