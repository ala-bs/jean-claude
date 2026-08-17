import { describe, expect, it, vi } from 'vitest';

import {
  START_PR_COMMAND_CHANNEL,
  type StartPrCommandParams,
} from '@shared/run-command-types';

import {
  registerStartPrCommandHandler,
  resetRunCommandLogs,
  resolveRunCommandStart,
} from './start-pr-command';

describe('start PR command IPC adapter', () => {
  it('registers the shared channel and forwards params and result unchanged', async () => {
    const params = {
      projectId: 'project-1',
      pullRequestId: 12,
      target: { type: 'command' as const, id: 'web' },
    };
    const result = {
      task: { id: 'task-1' },
      created: true,
      runCommandIds: ['web'],
      runResult: 'running',
    };
    const deps = { marker: 'deps' };
    const startPrCommand = vi.fn().mockResolvedValue(result);
    let listener:
      | ((event: unknown, receivedParams: typeof params) => Promise<typeof result>)
      | undefined;
    const ipcMain = {
      handle: vi.fn((channel, registeredListener) => {
        expect(channel).toBe(START_PR_COMMAND_CHANNEL);
        listener = registeredListener;
      }),
    };

    registerStartPrCommandHandler({ ipcMain, startPrCommand, deps });

    await expect(listener?.({}, params)).resolves.toBe(result);
    expect(startPrCommand).toHaveBeenCalledWith(params, deps);
  });

  it('broadcasts the returned generation before launch output', async () => {
    const params: StartPrCommandParams = {
      projectId: 'project-1',
      pullRequestId: 12,
      target: { type: 'command', id: 'web' },
    };
    const events: string[] = [];
    const broadcast = vi.fn((taskId, runCommandId, generation) => {
      events.push(`broadcast:${taskId}:${runCommandId}:${generation}`);
    });
    const resetLogs = vi.fn(() => {
      events.push('reset');
      return 7;
    });
    const deps = {
      resetLogs: () =>
        resetRunCommandLogs({
          params: {
            taskId: 'task-1',
            runCommandId: 'web',
            generation: 0,
          },
          resetLogs,
          broadcast,
        }),
    };
    const startPrCommand = vi.fn(async (_params, receivedDeps: typeof deps) => {
      receivedDeps.resetLogs();
      events.push('launch-output');
      return { started: true };
    });
    let listener:
      | ((event: unknown, params: StartPrCommandParams) => unknown)
      | undefined;
    const ipcMain = {
      handle: vi.fn((_channel, registeredListener) => {
        listener = registeredListener;
      }),
    };

    registerStartPrCommandHandler({ ipcMain, startPrCommand, deps });
    await listener?.({}, params);

    expect(resetLogs).toHaveBeenCalledWith({
      taskId: 'task-1',
      runCommandId: 'web',
      generation: 0,
    });
    expect(broadcast).toHaveBeenCalledWith('task-1', 'web', 7);
    expect(events).toEqual(['reset', 'broadcast:task-1:web:7', 'launch-output']);
  });

  it.each([
    null,
    [],
    {},
    { projectId: '', pullRequestId: 12, target: { type: 'command', id: 'web' } },
    { projectId: 'project-1', pullRequestId: '12', target: { type: 'command', id: 'web' } },
    { projectId: 'project-1', pullRequestId: 0, target: { type: 'command', id: 'web' } },
    { projectId: 'project-1', pullRequestId: 1.5, target: { type: 'command', id: 'web' } },
    { projectId: 'project-1', pullRequestId: Number.MAX_SAFE_INTEGER + 1, target: { type: 'command', id: 'web' } },
    { projectId: 'project-1', pullRequestId: 12, target: null },
    { projectId: 'project-1', pullRequestId: 12, target: { type: 'other', id: 'web' } },
    { projectId: 'project-1', pullRequestId: 12, target: { type: 'command', id: '' } },
  ])('rejects malformed payload %# before service dispatch', async (params) => {
    const startPrCommand = vi.fn();
    let listener: ((event: unknown, params: unknown) => unknown) | undefined;
    registerStartPrCommandHandler({
      ipcMain: {
        handle: vi.fn((_channel, registeredListener) => {
          listener = registeredListener;
        }),
      },
      startPrCommand,
      deps: {},
    });

    expect(() => listener?.({}, params)).toThrow('Invalid');
    expect(startPrCommand).not.toHaveBeenCalled();
  });
});

describe('resolveRunCommandStart', () => {
  const task = {
    id: 'task-1',
    projectId: 'project-1',
    worktreePath: '/repo/.worktrees/task-1',
  } as never;
  const project = { id: 'project-1', path: '/repo' } as never;

  it('derives project and cwd from persisted task despite renderer extras', async () => {
    const params = {
      taskId: 'task-1',
      runCommandId: 'web',
      projectId: 'attacker-project',
      workingDir: '/tmp/attacker',
    };
    const deps = {
      findTaskById: vi.fn().mockResolvedValue(task),
      findProjectById: vi.fn().mockResolvedValue(project),
      findCommandById: vi.fn().mockResolvedValue({
        id: 'web',
        projectId: 'project-1',
      }),
    };

    await expect(resolveRunCommandStart(params, deps)).resolves.toMatchObject({
      taskId: 'task-1',
      runCommandId: 'web',
      projectId: 'project-1',
      workingDir: '/repo/.worktrees/task-1',
    });
  });

  it('rejects foreign and missing group commands without partial launch', async () => {
    const deps = {
      findTaskById: vi.fn().mockResolvedValue(task),
      findProjectById: vi.fn().mockResolvedValue(project),
      findCommandById: vi.fn(async (id: string) =>
        id === 'web' ? { id, projectId: 'project-1' } : undefined,
      ),
    };

    await expect(
      resolveRunCommandStart(
        { taskId: 'task-1', runCommandIds: ['web', 'deleted'] },
        deps as never,
      ),
    ).rejects.toThrow('deleted');
  });
});
