import { describe, expect, it } from 'vitest';

import {
  buildCommandLogTabs,
  buildCommandPortsById,
  commandPortsMatchQuery,
  describeCommandPorts,
  describeWellKnownCommandId,
  formatCommandPorts,
  getCommandLogsEmptyText,
} from './command-log-tabs';
import {
  getRunCommandLogLineCount,
  useTaskMessagesStore,
} from '@/stores/task-messages';
import type { ProjectCommand } from '@shared/run-command-types';
import type { RunCommandLogs } from '@/stores/task-messages';

function makeCommand(overrides: Partial<ProjectCommand>): ProjectCommand {
  return {
    id: 'command-1',
    projectId: 'project-1',
    name: 'Command',
    command: 'echo hi',
    ports: [],
    portConflictStrategy: 'prompt',
    portOverrideProvider: 'env',
    portOverrideEnvVar: null,
    portOverrideArgs: null,
    envVars: [],
    sortOrder: 0,
    confirmBeforeRun: false,
    confirmMessage: null,
    isFavorite: false,
    isHidden: false,
    createdAt: '',
    ...overrides,
  };
}

function makeLogs(commandId: string): RunCommandLogs {
  return {
    [commandId]: {
      chunks: [
        {
          id: 'chunk-1',
          lines: [{ stream: 'stdout', line: 'output', timestamp: 1 }],
          lineCount: 1,
        },
      ],
      pendingLines: { stdout: null, stderr: null },
      trailingText: { stdout: '', stderr: '' },
      totalLineCount: 1,
      updatedAt: 1,
      version: 1,
    },
  };
}

/**
 * What `resetRunCommandLogs` leaves behind: the entry survives (it carries the
 * generation guard) but holds no lines. The tab must still go away.
 */
function makeClearedLogs(commandId: string): RunCommandLogs {
  return {
    [commandId]: {
      chunks: [],
      pendingLines: { stdout: null, stderr: null },
      trailingText: { stdout: '', stderr: '' },
      totalLineCount: 0,
      updatedAt: 2,
      version: 2,
    },
  };
}

describe('buildCommandLogTabs', () => {
  it('keeps removed-command history reachable', () => {
    const tabs = buildCommandLogTabs({
      commands: [],
      projectId: 'project-1',
      runCommandLogs: {
        'removed-command': {
          chunks: [
            {
              id: 'chunk-1',
              lines: [{ stream: 'stdout', line: 'old output', timestamp: 1 }],
              lineCount: 1,
            },
          ],
          pendingLines: { stdout: null, stderr: null },
          trailingText: { stdout: '', stderr: '' },
          totalLineCount: 1,
          updatedAt: 1,
          version: 1,
        },
      },
      runningCommandIds: new Set(),
    });

    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      id: 'removed-command',
      name: 'Removed command (removed-)',
    });
  });

  it('shows a virtual tab first once it has something to show', () => {
    const virtual = makeCommand({ id: 'mobile-dev', name: 'Mobile' });
    const configured = makeCommand({ id: 'cmd-api', name: 'API' });
    const tabs = buildCommandLogTabs({
      commands: [configured],
      projectId: 'project-1',
      runCommandLogs: makeLogs('cmd-api'),
      runningCommandIds: new Set(['mobile-dev']),
      virtualTabs: [virtual],
    });

    expect(tabs).toEqual([virtual, configured]);
  });

  it('does not duplicate a virtual tab as a historical tab', () => {
    const virtual = makeCommand({ id: 'mobile-dev', name: 'Mobile' });
    const tabs = buildCommandLogTabs({
      commands: [],
      projectId: 'project-1',
      runCommandLogs: makeLogs('mobile-dev'),
      runningCommandIds: new Set(),
      virtualTabs: [virtual],
    });

    expect(tabs).toEqual([virtual]);
  });

  it('lets a virtual tab win over a configured command with the same id', () => {
    const virtual = makeCommand({ id: 'shared-id', name: 'Virtual' });
    const configured = makeCommand({ id: 'shared-id', name: 'Configured' });
    const tabs = buildCommandLogTabs({
      commands: [configured],
      projectId: 'project-1',
      runCommandLogs: makeLogs('shared-id'),
      runningCommandIds: new Set(['shared-id']),
      virtualTabs: [virtual],
    });

    expect(tabs).toEqual([virtual]);
  });

  it('names well-known historical command ids', () => {
    const devServerTabs = buildCommandLogTabs({
      commands: [],
      projectId: 'project-1',
      runCommandLogs: makeLogs('mobile-dev-server:apps%2Fmobile'),
      runningCommandIds: new Set(),
    });
    expect(devServerTabs[0]?.name).toBe('Mobile dev server');

    const buildTabs = buildCommandLogTabs({
      commands: [],
      projectId: 'project-1',
      runCommandLogs: makeLogs('mobile-build:apps%2Fmobile:ios:sim-1'),
      runningCommandIds: new Set(),
    });
    expect(buildTabs[0]?.name).toBe('iOS build · sim-1');
  });

  it('gives same-platform builds on different devices distinct tab names', () => {
    const tabs = buildCommandLogTabs({
      commands: [],
      projectId: 'project-1',
      runCommandLogs: {
        ...makeLogs('mobile-build:.:ios:IOS-1'),
        ...makeLogs('mobile-build:.:ios:IOS-2'),
      },
      runningCommandIds: new Set(),
    });

    const names = tabs.map((tab) => tab.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining(['iOS build · IOS-1', 'iOS build · IOS-2']),
    );
  });

  it('does not claim commands are unconfigured while queries load or fail', () => {
    expect(
      getCommandLogsEmptyText({
        availabilityState: 'loading',
        hasConfiguredItems: false,
      }),
    ).toBe('Loading project commands...');
    expect(
      getCommandLogsEmptyText({
        availabilityState: 'error',
        hasConfiguredItems: false,
      }),
    ).toBe('Could not load project commands.');
    expect(
      getCommandLogsEmptyText({
        availabilityState: 'ready',
        hasConfiguredItems: false,
      }),
    ).toContain('No project commands configured');
  });
});

/**
 * One rule for every tab: visible iff it has log lines OR its command is
 * running. A finished command keeps its tab so the user can read what happened;
 * clearing the logs of something that is no longer running is what retires it.
 *
 * Both tab families are covered, because they used to differ: virtual tabs were
 * emitted unconditionally.
 */
describe.each([
  {
    family: 'virtual tab',
    build: (args: {
      runCommandLogs: RunCommandLogs;
      runningCommandIds: Set<string>;
    }) =>
      buildCommandLogTabs({
        commands: [],
        projectId: 'project-1',
        virtualTabs: [makeCommand({ id: 'metro', name: 'Metro' })],
        ...args,
      }),
  },
  {
    family: 'configured project command',
    build: (args: {
      runCommandLogs: RunCommandLogs;
      runningCommandIds: Set<string>;
    }) =>
      buildCommandLogTabs({
        commands: [makeCommand({ id: 'metro', name: 'Metro' })],
        projectId: 'project-1',
        ...args,
      }),
  },
])('buildCommandLogTabs lifecycle of a $family', ({ build }) => {
  it('hides it while nothing has run and nothing is running', () => {
    expect(
      build({ runCommandLogs: {}, runningCommandIds: new Set() }),
    ).toEqual([]);
  });

  it('shows it while running even with zero log lines', () => {
    const tabs = build({
      runCommandLogs: {},
      runningCommandIds: new Set(['metro']),
    });

    expect(tabs.map((tab) => tab.id)).toEqual(['metro']);
  });

  it('keeps it after the command stops, because its output is still there', () => {
    const tabs = build({
      runCommandLogs: makeLogs('metro'),
      runningCommandIds: new Set(),
    });

    expect(tabs.map((tab) => tab.id)).toEqual(['metro']);
  });

  it('retires it once its logs are cleared and it is not running', () => {
    expect(
      build({
        runCommandLogs: makeClearedLogs('metro'),
        runningCommandIds: new Set(),
      }),
    ).toEqual([]);
  });

  it('keeps it when its logs are cleared while it is still running', () => {
    const tabs = build({
      runCommandLogs: makeClearedLogs('metro'),
      runningCommandIds: new Set(['metro']),
    });

    expect(tabs.map((tab) => tab.id)).toEqual(['metro']);
  });
});

describe('describeWellKnownCommandId', () => {
  it('labels mobile dev server and build ids', () => {
    expect(describeWellKnownCommandId('mobile-dev-server:apps%2Fmobile')).toBe(
      'Mobile dev server',
    );
    expect(
      describeWellKnownCommandId('mobile-build:apps%2Fmobile:ios:sim-1'),
    ).toBe('iOS build · sim-1');
    expect(
      describeWellKnownCommandId('mobile-build:.:android:no-device'),
    ).toBe('Android build');
    // No device id at all (legacy two-part id) reads plainly too.
    expect(describeWellKnownCommandId('mobile-build:.:ios')).toBe('iOS build');
  });

  it('distinguishes two builds on different devices of one platform', () => {
    const first = describeWellKnownCommandId('mobile-build:.:ios:IOS-1');
    const second = describeWellKnownCommandId('mobile-build:.:ios:IOS-2');

    expect(first).toBe('iOS build · IOS-1');
    expect(second).toBe('iOS build · IOS-2');
    expect(first).not.toBe(second);
  });

  it('abbreviates long device ids from both ends', () => {
    expect(
      describeWellKnownCommandId(
        'mobile-build:.:ios:C0FFEE11-2222-3333-4444-5555AAAA9F2C',
      ),
    ).toBe('iOS build · C0FFEE11…9F2C');
  });

  it('returns null for unknown ids', () => {
    expect(describeWellKnownCommandId('removed-command')).toBeNull();
    expect(describeWellKnownCommandId('mobile-build:.:windows:x')).toBeNull();
  });
});

describe('buildCommandPortsById', () => {
  it('exposes runtime ports for running commands', () => {
    const map = buildCommandPortsById([
      { id: 'a', ports: [5173], status: 'running' },
      { id: 'b', ports: [3000, 9229], status: 'running' },
    ]);

    expect(map.get('a')).toEqual([5173]);
    expect(map.get('b')).toEqual([3000, 9229]);
  });

  it('hides ports for commands that exited so no dead port is advertised', () => {
    const map = buildCommandPortsById([
      { id: 'a', ports: [5173], status: 'stopped' },
      { id: 'b', ports: [3000], status: 'errored' },
    ]);

    expect(map.size).toBe(0);
  });

  it('ignores missing or non-numeric ports', () => {
    const map = buildCommandPortsById([
      { id: 'a', status: 'running' },
      { id: 'b', ports: [], status: 'running' },
      { id: 'c', ports: [Number.NaN], status: 'running' },
    ]);

    expect(map.size).toBe(0);
  });

  it('keeps the valid ports of a mixed entry', () => {
    const map = buildCommandPortsById([
      { id: 'a', ports: [Number.NaN, 3000, 0, 99_999], status: 'running' },
    ]);

    expect(map.get('a')).toEqual([3000]);
  });

  it('handles a missing status payload', () => {
    expect(buildCommandPortsById(undefined).size).toBe(0);
  });
});

describe('formatCommandPorts', () => {
  it('formats single and multiple ports', () => {
    expect(formatCommandPorts([5173])).toBe('5173');
    expect(formatCommandPorts([3000, 9229])).toBe('3000, 9229');
  });

  it('returns null when there is nothing to show', () => {
    expect(formatCommandPorts([])).toBeNull();
    expect(formatCommandPorts(undefined)).toBeNull();
  });
});

describe('commandPortsMatchQuery', () => {
  it('matches any port by partial digits', () => {
    expect(commandPortsMatchQuery({ ports: [3000, 9229], query: '9229' })).toBe(
      true,
    );
    expect(commandPortsMatchQuery({ ports: [5173], query: '517' })).toBe(true);
  });

  it('does not match unrelated queries', () => {
    expect(commandPortsMatchQuery({ ports: [5173], query: '8080' })).toBe(false);
    expect(commandPortsMatchQuery({ ports: undefined, query: '80' })).toBe(
      false,
    );
    expect(commandPortsMatchQuery({ ports: [5173], query: '' })).toBe(false);
  });
});

describe('describeCommandPorts', () => {
  it('pluralizes for multi-port commands', () => {
    expect(describeCommandPorts([5173])).toBe('port 5173');
    expect(describeCommandPorts([3000, 9229])).toBe('ports 3000, 9229');
    expect(describeCommandPorts([])).toBeNull();
    expect(describeCommandPorts(undefined)).toBeNull();
  });
});

/**
 * End-to-end over the real store: the main process writes a synthetic exit
 * marker for a command that failed silently, which is the only thing keeping
 * its tab alive.
 */
describe('failed commands with no output of their own', () => {
  const taskId = 'task-1';
  const commandId = 'silent-fail';

  function tabsForStore(): ProjectCommand[] {
    return buildCommandLogTabs({
      commands: [makeCommand({ id: commandId, name: 'Build' })],
      projectId: 'project-1',
      runCommandLogs:
        useTaskMessagesStore.getState().runCommandLogs[taskId] ?? {},
      runningCommandIds: new Set(),
    });
  }

  it('keeps its tab, and loses it once the logs are cleared', () => {
    const store = useTaskMessagesStore.getState();
    // stop -> resetLogs -> start, exactly as `runStart` orders it.
    const generation = store.resetRunCommandLogs(taskId, commandId);
    expect(tabsForStore()).toEqual([]);

    store.appendRunCommandLogBatch(
      taskId,
      commandId,
      'stdout',
      '[process exited with code 1]\n',
      generation,
    );

    expect(tabsForStore().map((tab) => tab.id)).toEqual([commandId]);
    expect(
      getRunCommandLogLineCount(
        useTaskMessagesStore.getState().runCommandLogs[taskId]?.[commandId],
      ),
    ).toBe(1);

    useTaskMessagesStore.getState().resetRunCommandLogs(taskId, commandId);
    expect(tabsForStore()).toEqual([]);
  });

  it('discards a marker stamped with a stale generation', () => {
    const store = useTaskMessagesStore.getState();
    const generation = store.resetRunCommandLogs(taskId, commandId);
    store.appendRunCommandLogBatch(
      taskId,
      commandId,
      'stdout',
      '[process exited with code 1]\n',
      generation - 1,
    );

    expect(tabsForStore()).toEqual([]);
  });
});
