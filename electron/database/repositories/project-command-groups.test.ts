import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const executeTakeFirst = vi.fn();
  const where = vi.fn(() => ({ executeTakeFirst }));
  const selectAll = vi.fn(() => ({ where }));
  const selectFrom = vi.fn(() => ({ selectAll }));

  return {
    dbMock: { selectFrom },
    executeTakeFirst,
    selectFrom,
    where,
  };
});

const { executeTakeFirst, selectFrom, where } = mocks;

vi.mock('../index', () => ({
  db: mocks.dbMock,
}));

import { ProjectCommandGroupRepository } from './project-command-groups';

describe('ProjectCommandGroupRepository.findById', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a project command group with parsed command IDs', async () => {
    executeTakeFirst.mockResolvedValue({
      id: 'group-1',
      projectId: 'project-1',
      name: 'Development',
      commandIds: '["command-1","command-2"]',
      sortOrder: 2,
      createdAt: '2026-07-13T00:00:00.000Z',
    });

    await expect(
      ProjectCommandGroupRepository.findById('group-1'),
    ).resolves.toEqual({
      id: 'group-1',
      projectId: 'project-1',
      name: 'Development',
      commandIds: ['command-1', 'command-2'],
      sortOrder: 2,
      createdAt: '2026-07-13T00:00:00.000Z',
    });

    expect(selectFrom).toHaveBeenCalledWith('project_command_groups');
    expect(where).toHaveBeenCalledWith('id', '=', 'group-1');
  });

  it('returns undefined when the group does not exist', async () => {
    executeTakeFirst.mockResolvedValue(undefined);

    await expect(
      ProjectCommandGroupRepository.findById('missing-group'),
    ).resolves.toBeUndefined();

    expect(where).toHaveBeenCalledWith('id', '=', 'missing-group');
  });
});
