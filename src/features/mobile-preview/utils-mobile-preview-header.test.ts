import { describe, expect, it } from 'vitest';

import { createMobileDevServerCommandId } from '@/lib/mobile-preview-runtime';
import { getMobilePreviewHeaderState } from './utils-mobile-preview-header';
import type { Project } from '@shared/types';
import type { RunStatus } from '@shared/run-command-types';

function createStatus(
  commands: Array<{ id: string; status: 'running' | 'stopped' | 'errored' }>,
): RunStatus {
  return {
    isRunning: commands.some((command) => command.status === 'running'),
    commands: commands.map((command) => ({
      ...command,
      name: command.id,
      command: 'pnpm start',
      ports: [],
    })),
  };
}

describe('mobile preview header state', () => {
  it('counts only running mobile dev servers', () => {
    const state = getMobilePreviewHeaderState({
      projects: [],
      runCommandRunning: {
        'task-1': createStatus([
          { id: createMobileDevServerCommandId('.'), status: 'running' },
          { id: 'mobile-build:app:ios:device', status: 'running' },
          { id: 'web-server', status: 'running' },
          {
            id: createMobileDevServerCommandId('apps/stopped'),
            status: 'stopped',
          },
        ]),
      },
    });

    expect(state).toEqual({ runningCount: 1, isVisible: true });
  });

  it('stays visible for an enabled project without a running server', () => {
    const project = {
      id: 'project-1',
      mobilePreviewConfig: {
        mode: 'enabled',
        selectedAppPath: null,
        detectedApps: [],
        detectionUpdatedAt: null,
      },
    } as unknown as Project;

    expect(
      getMobilePreviewHeaderState({
        projects: [project],
        runCommandRunning: {},
      }),
    ).toEqual({ runningCount: 0, isVisible: true });
  });

  it('hides without enabled projects or running mobile servers', () => {
    expect(
      getMobilePreviewHeaderState({
        projects: [],
        runCommandRunning: {
          'task-1': createStatus([
            { id: 'mobile-build:app:android:device', status: 'running' },
          ]),
        },
      }),
    ).toEqual({ runningCount: 0, isVisible: false });
  });
});
