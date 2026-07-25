import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  ProjectCommand,
  ProjectCommandGroup,
} from '@shared/run-command-types';

import {
  buildRunCommandItems,
  getRunCommandAction,
  getRunConfirmation,
  resolveRunCommandIds,
  type RunCommandItem,
} from './run-command-items';

function makeCommand(
  overrides: Partial<ProjectCommand> = {},
): ProjectCommand {
  return {
    id: 'command-1',
    projectId: 'project-1',
    name: 'Dev server',
    command: 'pnpm dev',
    ports: [],
    portConflictStrategy: 'prompt',
    portOverrideProvider: 'env',
    portOverrideEnvVar: null,
    portOverrideArgs: null,
    envVars: [],
    confirmBeforeRun: false,
    confirmMessage: null,
    sortOrder: 0,
    createdAt: '2026-07-13T10:00:00.000Z',
    ...overrides,
  };
}

function makeGroup(
  overrides: Partial<ProjectCommandGroup> = {},
): ProjectCommandGroup {
  return {
    id: 'group-1',
    projectId: 'project-1',
    name: 'Development',
    commandIds: ['command-1'],
    sortOrder: 0,
    createdAt: '2026-07-13T10:00:00.000Z',
    ...overrides,
  };
}

describe('buildRunCommandItems', () => {
  it('sorts commands and groups together by sort order then creation time', () => {
    const command1 = makeCommand({
      id: 'command-1',
      sortOrder: 2,
      createdAt: '2026-07-13T10:00:00.000Z',
    });
    const command2 = makeCommand({
      id: 'command-2',
      sortOrder: 1,
      createdAt: '2026-07-13T12:00:00.000Z',
    });
    const group1 = makeGroup({
      id: 'group-1',
      sortOrder: 1,
      createdAt: '2026-07-13T11:00:00.000Z',
    });

    expect(buildRunCommandItems({ commands: [command1, command2], groups: [group1] }))
      .toEqual([
        { type: 'group', item: group1 },
        { type: 'command', item: command2 },
        { type: 'command', item: command1 },
      ]);
  });

  it('does not mutate command or group arrays', () => {
    const commands = [makeCommand({ id: 'command-2', sortOrder: 2 })];
    const groups = [makeGroup({ id: 'group-1', sortOrder: 1 })];

    buildRunCommandItems({ commands, groups });

    expect(commands.map(({ id }) => id)).toEqual(['command-2']);
    expect(groups.map(({ id }) => id)).toEqual(['group-1']);
  });
});

describe('resolveRunCommandIds', () => {
  it('returns a command ID', () => {
    const command = makeCommand();

    expect(
      resolveRunCommandIds({ item: { type: 'command', item: command }, commands: [command] }),
    ).toEqual(['command-1']);
  });

  it('resolves groups in saved order and omits deleted command IDs', () => {
    const commands = [
      makeCommand({ id: 'command-1' }),
      makeCommand({ id: 'command-2' }),
    ];
    const item: RunCommandItem = {
      type: 'group',
      item: makeGroup({
        commandIds: ['command-2', 'deleted-command', 'command-1'],
      }),
    };

    expect(resolveRunCommandIds({ item, commands })).toEqual([
      'command-2',
      'command-1',
    ]);
  });

  it('resolves an empty or fully deleted group as disabled', () => {
    const item: RunCommandItem = {
      type: 'group',
      item: makeGroup({ commandIds: ['deleted-command'] }),
    };

    expect(resolveRunCommandIds({ item, commands: [] })).toEqual([]);
    expect(getRunCommandAction({ commandIds: [], runningCommandIds: [] })).toEqual({
      type: 'disabled',
      commandIds: [],
    });
  });
});

describe('getRunConfirmation', () => {
  it('builds command confirmation from display name and configured message', () => {
    const command = makeCommand({
      name: '  ',
      command: 'pnpm deploy',
      confirmBeforeRun: true,
      confirmMessage: 'Deploy this branch?',
    });

    expect(
      getRunConfirmation({
        item: { type: 'command', item: command },
        commands: [command],
      }),
    ).toEqual({ label: 'pnpm deploy', message: 'Deploy this branch?' });
  });

  it('does not confirm commands without confirmation enabled', () => {
    const command = makeCommand({ confirmMessage: 'Ignored' });

    expect(
      getRunConfirmation({
        item: { type: 'command', item: command },
        commands: [command],
      }),
    ).toBeNull();
  });

  it('aggregates configured messages for confirming group commands', () => {
    const commands = [
      makeCommand({
        id: 'command-1',
        confirmBeforeRun: true,
        confirmMessage: 'Start API?',
      }),
      makeCommand({
        id: 'command-2',
        confirmBeforeRun: false,
        confirmMessage: 'Ignored',
      }),
      makeCommand({
        id: 'command-3',
        confirmBeforeRun: true,
        confirmMessage: '  Start web?  ',
      }),
    ];
    const group = makeGroup({
      name: 'Full stack',
      commandIds: ['command-3', 'command-2', 'command-1'],
    });

    expect(
      getRunConfirmation({ item: { type: 'group', item: group }, commands }),
    ).toEqual({ label: 'Full stack', message: 'Start web?\nStart API?' });
  });

  it('uses current group summary when confirming commands have no message', () => {
    const commands = [
      makeCommand({
        id: 'command-1',
        confirmBeforeRun: true,
        confirmMessage: null,
      }),
      makeCommand({ id: 'command-2' }),
    ];
    const group = makeGroup({
      name: 'Full stack',
      commandIds: ['command-1', 'deleted-command', 'command-2'],
    });

    expect(
      getRunConfirmation({ item: { type: 'group', item: group }, commands }),
    ).toEqual({
      label: 'Full stack',
      message: 'Run group Full stack (2 commands)?',
    });
  });

  it('returns no confirmation for disabled groups', () => {
    const group = makeGroup({ commandIds: ['deleted-command'] });

    expect(
      getRunConfirmation({ item: { type: 'group', item: group }, commands: [] }),
    ).toBeNull();
  });
});

describe('getRunCommandAction', () => {
  it('types run and stop command IDs as non-empty', () => {
    const action = getRunCommandAction({
      commandIds: ['command-1'],
      runningCommandIds: [],
    });

    if (action.type !== 'disabled') {
      expectTypeOf(action.commandIds).toEqualTypeOf<[
        string,
        ...string[],
      ]>();
      expectTypeOf(action.commandIds[0]).toEqualTypeOf<string>();
    }
  });

  it('stops only currently running group members instead of launching remainder', () => {
    expect(
      getRunCommandAction({
        commandIds: ['command-2', 'command-1', 'command-3'],
        runningCommandIds: ['command-3', 'other-command', 'command-1'],
      }),
    ).toEqual({
      type: 'stop',
      commandIds: ['command-1', 'command-3'],
    });
  });

  it('runs every resolved member when none are running', () => {
    expect(
      getRunCommandAction({
        commandIds: ['command-2', 'command-1'],
        runningCommandIds: [],
      }),
    ).toEqual({
      type: 'run',
      commandIds: ['command-2', 'command-1'],
    });
  });
});
