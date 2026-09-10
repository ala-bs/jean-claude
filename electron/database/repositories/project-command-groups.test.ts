import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const executeTakeFirst = vi.fn();
  const execute = vi.fn();
  // `orderBy` chains onto itself so list queries can order by several columns.
  const orderByResult: { execute: typeof execute; orderBy: () => unknown } = {
    execute,
    orderBy: vi.fn(() => orderByResult),
  };
  const orderBy = orderByResult.orderBy;
  const where = vi.fn(() => ({ executeTakeFirst, orderBy }));
  const selectAll = vi.fn(() => ({ where, orderBy }));

  const executeTakeFirstOrThrow = vi.fn();
  const returningAll = vi.fn(() => ({ executeTakeFirstOrThrow }));
  const values = vi.fn(() => ({ returningAll }));
  const set = vi.fn(() => ({
    where: vi.fn(() => ({ returningAll })),
  }));

  const selectFrom = vi.fn(() => ({ selectAll }));
  const insertInto = vi.fn(() => ({ values }));
  const updateTable = vi.fn(() => ({ set }));

  return {
    dbMock: { selectFrom, insertInto, updateTable },
    execute,
    executeTakeFirst,
    executeTakeFirstOrThrow,
    insertInto,
    selectFrom,
    set,
    updateTable,
    values,
    where,
  };
});

const {
  execute,
  executeTakeFirst,
  executeTakeFirstOrThrow,
  selectFrom,
  set,
  values,
  where,
} = mocks;

vi.mock('../index', () => ({
  db: mocks.dbMock,
}));

import { ProjectCommandGroupRepository } from './project-command-groups';

describe('ProjectCommandGroupRepository.findById', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses stages and derives commandIds from them', async () => {
    executeTakeFirst.mockResolvedValue({
      id: 'group-1',
      projectId: 'project-1',
      name: 'Development',
      stages: JSON.stringify([
        {
          id: 'stage-1',
          delayMs: 0,
          entries: [{ commandId: 'command-1', waitForExit: true }],
        },
        {
          id: 'stage-2',
          delayMs: 3000,
          entries: [{ commandId: 'command-2', waitForExit: false }],
        },
      ]),
      // Deliberately stale: the derived value must win over the column.
      commandIds: '["stale"]',
      sortOrder: 2,
      createdAt: '2026-07-13T00:00:00.000Z',
    });

    await expect(
      ProjectCommandGroupRepository.findById('group-1'),
    ).resolves.toEqual({
      id: 'group-1',
      projectId: 'project-1',
      name: 'Development',
      stages: [
        {
          id: 'stage-1',
          delayMs: 0,
          entries: [{ commandId: 'command-1', waitForExit: true }],
        },
        {
          id: 'stage-2',
          delayMs: 3000,
          entries: [{ commandId: 'command-2', waitForExit: false }],
        },
      ],
      commandIds: ['command-1', 'command-2'],
      isFavorite: false,
      sortOrder: 2,
      createdAt: '2026-07-13T00:00:00.000Z',
    });

    expect(selectFrom).toHaveBeenCalledWith('project_command_groups');
    expect(where).toHaveBeenCalledWith('id', '=', 'group-1');
  });

  it('de-duplicates commandIds when a command repeats across stages', async () => {
    executeTakeFirst.mockResolvedValue({
      id: 'group-1',
      projectId: 'project-1',
      name: 'Development',
      stages: JSON.stringify([
        {
          id: 'stage-1',
          delayMs: 0,
          entries: [{ commandId: 'build', waitForExit: true }],
        },
        {
          id: 'stage-2',
          delayMs: 0,
          entries: [{ commandId: 'build', waitForExit: true }],
        },
      ]),
      commandIds: '[]',
      sortOrder: 0,
      createdAt: '2026-07-13T00:00:00.000Z',
    });

    const group = await ProjectCommandGroupRepository.findById('group-1');
    expect(group?.commandIds).toEqual(['build']);
    expect(group?.stages).toHaveLength(2);
  });

  it('rebuilds one stage from legacy commandIds when stages are unusable', async () => {
    // A row written by a build predating migration 087, or corrupted JSON.
    // Presenting the group as empty would look like the user's config was
    // wiped, and the next editor write would make that permanent.
    executeTakeFirst.mockResolvedValue({
      id: 'group-1',
      projectId: 'project-1',
      name: 'Development',
      stages: 'not json',
      commandIds: '["command-1","command-2"]',
      sortOrder: 0,
      createdAt: '2026-07-13T00:00:00.000Z',
    });

    const group = await ProjectCommandGroupRepository.findById('group-1');
    expect(group?.commandIds).toEqual(['command-1', 'command-2']);
    expect(group?.stages).toHaveLength(1);
    expect(group?.stages[0].entries).toEqual([
      { commandId: 'command-1', waitForExit: false },
      { commandId: 'command-2', waitForExit: false },
    ]);
  });

  it('reports a genuinely empty group as empty', async () => {
    executeTakeFirst.mockResolvedValue({
      id: 'group-1',
      projectId: 'project-1',
      name: 'Development',
      stages: '[]',
      commandIds: '[]',
      sortOrder: 0,
      createdAt: '2026-07-13T00:00:00.000Z',
    });

    const group = await ProjectCommandGroupRepository.findById('group-1');
    expect(group?.stages).toEqual([]);
    expect(group?.commandIds).toEqual([]);
  });

  it('returns undefined when the group does not exist', async () => {
    executeTakeFirst.mockResolvedValue(undefined);

    await expect(
      ProjectCommandGroupRepository.findById('missing-group'),
    ).resolves.toBeUndefined();

    expect(where).toHaveBeenCalledWith('id', '=', 'missing-group');
  });
});

describe('ProjectCommandGroupRepository write-side commandIds derivation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeTakeFirstOrThrow.mockResolvedValue({
      id: 'group-1',
      projectId: 'project-1',
      name: 'Development',
      stages: '[]',
      commandIds: '[]',
      sortOrder: 0,
      createdAt: '2026-07-13T00:00:00.000Z',
    });
  });

  it('derives commandIds from stages on create', async () => {
    await ProjectCommandGroupRepository.create({
      projectId: 'project-1',
      name: 'Development',
      stages: [
        {
          id: 'stage-1',
          delayMs: 0,
          entries: [{ commandId: 'build', waitForExit: true }],
        },
        {
          id: 'stage-2',
          delayMs: 0,
          entries: [
            { commandId: 'web', waitForExit: false },
            // Duplicated across stages: membership must still be unique.
            { commandId: 'build', waitForExit: true },
          ],
        },
      ],
    });

    const inserted = (values.mock.calls as unknown[][])[0][0] as {
      stages: string;
      commandIds: string;
    };
    expect(JSON.parse(inserted.commandIds)).toEqual(['build', 'web']);
    expect(JSON.parse(inserted.stages)).toHaveLength(2);
  });

  it('rewrites commandIds when stages are updated', async () => {
    await ProjectCommandGroupRepository.update('group-1', {
      stages: [
        {
          id: 'stage-1',
          delayMs: 0,
          entries: [{ commandId: 'only', waitForExit: false }],
        },
      ],
    });

    const updated = (set.mock.calls as unknown[][])[0][0] as {
      commandIds: string;
    };
    expect(JSON.parse(updated.commandIds)).toEqual(['only']);
  });

  it('leaves commandIds untouched when only the name changes', async () => {
    await ProjectCommandGroupRepository.update('group-1', { name: 'Renamed' });

    expect((set.mock.calls as unknown[][])[0][0]).toEqual({ name: 'Renamed' });
  });
});

describe('ProjectCommandGroupRepository favorites', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('selects only favorites and exposes isFavorite as a boolean', async () => {
    execute.mockResolvedValue([
      {
        id: 'group-1',
        projectId: 'project-1',
        name: 'Dev stack',
        stages: JSON.stringify([
          {
            id: 'stage-1',
            delayMs: 0,
            entries: [{ commandId: 'command-1', waitForExit: false }],
          },
        ]),
        commandIds: '["command-1"]',
        isFavorite: 1,
        sortOrder: 0,
        createdAt: '2026-07-13T00:00:00.000Z',
      },
    ]);

    const groups = await ProjectCommandGroupRepository.findFavorites();

    expect(where).toHaveBeenCalledWith('isFavorite', '=', 1);
    expect(groups[0].isFavorite).toBe(true);
  });

  it('stores isFavorite as 0/1 on update', async () => {
    await ProjectCommandGroupRepository.update('group-1', {
      isFavorite: true,
    });

    expect((set.mock.calls as unknown[][])[0][0]).toEqual({ isFavorite: 1 });
  });
});
