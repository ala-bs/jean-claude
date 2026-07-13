import { beforeEach, describe, expect, it, vi } from 'vitest';

const repositories = vi.hoisted(() => ({
  ProjectRepository: {
    delete: vi.fn(),
  },
}));

const debug = vi.hoisted(() => ({
  dbg: {
    ipc: vi.fn(),
  },
}));

const storage = vi.hoisted(() => ({
  removeProjectPreferenceMemory: vi.fn(),
  withProjectPreferenceMemoryLock: vi.fn(
    async (_projectId: string, operation: () => Promise<unknown>) => operation(),
  ),
}));

vi.mock('../database/repositories', () => repositories);
vi.mock('../lib/debug', () => debug);
vi.mock('./preference-memory-storage', () => storage);

import { deleteProjectWithPreferenceMemoryCleanup } from './project-deletion-service';

describe('deleteProjectWithPreferenceMemoryCleanup', () => {
  beforeEach(() => {
    repositories.ProjectRepository.delete.mockReset();
    storage.removeProjectPreferenceMemory.mockReset();
    storage.withProjectPreferenceMemoryLock.mockClear();
    debug.dbg.ipc.mockReset();
  });

  it('returns successful deletion when preference memory cleanup fails', async () => {
    const deletionResult = [{ numDeletedRows: 1n }];
    const cleanupError = new Error('cleanup failed');
    repositories.ProjectRepository.delete.mockResolvedValue(deletionResult);
    storage.removeProjectPreferenceMemory.mockRejectedValue(cleanupError);

    await expect(
      deleteProjectWithPreferenceMemoryCleanup('project-1'),
    ).resolves.toBe(deletionResult);

    expect(repositories.ProjectRepository.delete).toHaveBeenCalledWith(
      'project-1',
    );
    expect(storage.removeProjectPreferenceMemory).toHaveBeenCalledWith({
      projectId: 'project-1',
    });
    expect(debug.dbg.ipc).toHaveBeenCalledWith(
      'Failed to clean preference memory for project %s: %O',
      'project-1',
      cleanupError,
    );
  });
});
