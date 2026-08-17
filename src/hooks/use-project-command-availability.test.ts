import { describe, expect, it, vi } from 'vitest';

import { resolveProjectCommandAvailability } from './use-project-command-availability';

const refetch = vi.fn();

describe('resolveProjectCommandAvailability', () => {
  it('waits for both command queries before confirming empty', () => {
    expect(
      resolveProjectCommandAvailability({
        commandsQuery: { data: [], isError: false, isSuccess: true, refetch },
        groupsQuery: { data: undefined, isError: false, isSuccess: false, refetch },
      }).state,
    ).toBe('loading');
  });

  it('reports query errors instead of empty configuration', () => {
    expect(
      resolveProjectCommandAvailability({
        commandsQuery: { data: [], isError: true, isSuccess: false, refetch },
        groupsQuery: { data: [], isError: false, isSuccess: true, refetch },
      }).state,
    ).toBe('error');
  });

  it('treats empty and stale-only groups as unconfigured', () => {
    const result = resolveProjectCommandAvailability({
      commandsQuery: { data: [], isError: false, isSuccess: true, refetch },
      groupsQuery: {
        data: [
          {
            id: 'group-1',
            projectId: 'project-1',
            name: 'Workspace',
            commandIds: ['missing-command'],
            sortOrder: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        isError: false,
        isSuccess: true,
        refetch,
      },
    });

    expect(result.state).toBe('ready');
    expect(result.hasConfiguredItems).toBe(false);
    expect(result.items).toHaveLength(0);
  });

  it('preserves groups that resolve at least one existing command', () => {
    const command = {
      id: 'command-1',
      projectId: 'project-1',
      name: 'Dev',
      command: 'pnpm dev',
      ports: [],
      portConflictStrategy: 'prompt' as const,
      portOverrideProvider: 'env' as const,
      portOverrideEnvVar: null,
      portOverrideArgs: null,
      envVars: [],
      confirmBeforeRun: false,
      confirmMessage: null,
      sortOrder: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const result = resolveProjectCommandAvailability({
      commandsQuery: {
        data: [command],
        isError: false,
        isSuccess: true,
        refetch,
      },
      groupsQuery: {
        data: [
          {
            id: 'group-1',
            projectId: 'project-1',
            name: 'Workspace',
            commandIds: ['command-1'],
            sortOrder: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        isError: false,
        isSuccess: true,
        refetch,
      },
    });

    expect(result.hasConfiguredItems).toBe(true);
    expect(result.items.map((item) => item.type)).toEqual(['group', 'command']);
  });
});
