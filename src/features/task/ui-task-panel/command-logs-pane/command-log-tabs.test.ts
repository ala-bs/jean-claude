import { describe, expect, it } from 'vitest';

import {
  buildCommandLogTabs,
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
