import { describe, expect, it } from 'vitest';

import {
  buildCommandLogTabs,
  buildCommandPortsById,
  commandPortsMatchQuery,
  describeCommandPorts,
  formatCommandPorts,
  getCommandLogsEmptyText,
} from './command-log-tabs';

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
