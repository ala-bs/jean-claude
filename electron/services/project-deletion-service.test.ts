import { beforeEach, describe, expect, it, vi } from 'vitest';

const repositories = vi.hoisted(() => ({
  ProjectRepository: {
    delete: vi.fn(),
  },
}));

const storage = vi.hoisted(() => ({
  removeProjectAgentMemory: vi.fn(),
}));

vi.mock('../database/repositories', () => repositories);
vi.mock('./agent-memory-storage', () => storage);

import { deleteProjectRetainingMemory } from './project-deletion-service';

describe('deleteProjectRetainingMemory', () => {
  beforeEach(() => {
    repositories.ProjectRepository.delete.mockReset();
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
});
