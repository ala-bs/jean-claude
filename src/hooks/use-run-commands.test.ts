// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { RunStatus } from '@shared/run-command-types';

import { useRunCommands } from './use-run-commands';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  confirmKillPorts: vi.fn(),
  getStatus: vi.fn(),
  killPortsForCommand: vi.fn(),
  resetLogs: vi.fn(),
  startCommand: vi.fn(),
  startGroup: vi.fn(),
  statusHandlers: [] as Array<(taskId: string, status: RunStatus) => void>,
  stopCommand: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    runCommands: {
      getStatus: apiMocks.getStatus,
      killPortsForCommand: apiMocks.killPortsForCommand,
      onStatusChange: vi.fn((handler) => {
        apiMocks.statusHandlers.push(handler);
        return vi.fn();
      }),
      resetLogs: apiMocks.resetLogs,
      startCommand: apiMocks.startCommand,
      startGroup: apiMocks.startGroup,
      stopCommand: apiMocks.stopCommand,
    },
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function status(id: string): RunStatus {
  return {
    isRunning: true,
    commands: [{ id, name: id, command: id, status: 'running' }],
  };
}

describe('useRunCommands task switching', () => {
  let container: HTMLDivElement;
  let root: Root;
  let currentStatus: RunStatus | null = null;
  let controls: ReturnType<typeof useRunCommands>;

  function Harness({ taskId }: { taskId: string }) {
    controls = useRunCommands({
      taskId,
      projectId: 'project-1',
      workingDir: '/repo',
    });
    currentStatus = controls.status;
    return null;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    apiMocks.getStatus.mockReset();
    apiMocks.killPortsForCommand.mockReset().mockResolvedValue(undefined);
    apiMocks.resetLogs.mockReset().mockResolvedValue(undefined);
    apiMocks.startCommand.mockReset();
    apiMocks.startGroup.mockReset();
    apiMocks.statusHandlers = [];
    apiMocks.stopCommand.mockReset().mockResolvedValue(undefined);
    currentStatus = null;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
  });

  it('clears status and ignores old responses and subscriptions after a task switch', async () => {
    const first = deferred<RunStatus>();
    const second = deferred<RunStatus>();
    apiMocks.getStatus
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    await act(async () => root.render(createElement(Harness, { taskId: 'task-1' })));
    const oldStatusHandler = apiMocks.statusHandlers[0]!;
    await act(async () => oldStatusHandler('task-1', status('existing-command')));
    expect(currentStatus?.commands[0]?.id).toBe('existing-command');

    await act(async () => root.render(createElement(Harness, { taskId: 'task-2' })));

    expect(currentStatus).toBeNull();

    await act(async () => {
      first.resolve(status('old-command'));
      oldStatusHandler('task-1', status('old-subscription-command'));
      await first.promise;
    });
    expect(currentStatus).toBeNull();

    await act(async () => {
      second.resolve(status('new-command'));
      await second.promise;
    });
    expect(currentStatus?.commands[0]?.id).toBe('new-command');
  });

  it('keeps a newer subscription event over a pending initial status response', async () => {
    const initial = deferred<RunStatus>();
    apiMocks.getStatus.mockReturnValue(initial.promise);
    await act(async () => root.render(createElement(Harness, { taskId: 'task-1' })));

    await act(async () =>
      apiMocks.statusHandlers[0]!('task-1', status('event-command')),
    );
    initial.resolve(status('stale-initial-command'));
    await act(async () => initial.promise);

    expect(currentStatus?.commands[0]?.id).toBe('event-command');
  });

  it.each(['success', 'error', 'ports'] as const)(
    'ignores old start %s and finally state after switching tasks',
    async (outcome) => {
      apiMocks.getStatus.mockResolvedValue({ isRunning: false, commands: [] });
      const oldStart = deferred<RunStatus>();
      const newStart = deferred<RunStatus>();
      apiMocks.startCommand
        .mockReturnValueOnce(oldStart.promise)
        .mockReturnValueOnce(newStart.promise);

      await act(async () => root.render(createElement(Harness, { taskId: 'task-1' })));
      let oldPromise!: Promise<unknown>;
      await act(async () => {
        oldPromise = controls.startCommand('command-1').catch(() => undefined);
        await flushPromises();
      });

      await act(async () => root.render(createElement(Harness, { taskId: 'task-2' })));
      let newPromise!: Promise<unknown>;
      await act(async () => {
        newPromise = controls.startCommand('command-1');
        await flushPromises();
      });
      expect(controls.isCommandStarting('command-1')).toBe(true);

      await act(async () => {
        if (outcome === 'success') oldStart.resolve(status('old-command'));
        if (outcome === 'error') oldStart.reject(new Error('old failure'));
        if (outcome === 'ports') {
          oldStart.resolve({
            type: 'PortsInUseError',
            message: 'old conflict',
            portsInUse: [
              { port: 3000, commandId: 'command-1', command: 'pnpm dev' },
            ],
          } as never);
        }
        await oldPromise;
      });

      expect(controls.isCommandStarting('command-1')).toBe(true);
      expect(controls.portsInUseError).toBeNull();
      expect(controls.status?.commands.some((entry) => entry.id === 'old-command')).toBe(false);

      newStart.resolve(status('new-command'));
      await act(async () => newPromise);
      expect(controls.isCommandStarting('command-1')).toBe(false);
    },
  );

  it('does not let an old stop finally clear a new task stop', async () => {
    apiMocks.getStatus.mockResolvedValue({ isRunning: false, commands: [] });
    const oldStop = deferred<void>();
    const newStop = deferred<void>();
    apiMocks.stopCommand
      .mockReturnValueOnce(oldStop.promise)
      .mockReturnValueOnce(newStop.promise);

    await act(async () => root.render(createElement(Harness, { taskId: 'task-1' })));
    let oldPromise!: Promise<void>;
    await act(async () => {
      oldPromise = controls.stopCommand('command-1');
    });
    await act(async () => root.render(createElement(Harness, { taskId: 'task-2' })));
    let newPromise!: Promise<void>;
    await act(async () => {
      newPromise = controls.stopCommand('command-1');
    });
    expect(controls.isCommandStopping('command-1')).toBe(true);

    oldStop.resolve();
    await act(async () => oldPromise);
    expect(controls.isCommandStopping('command-1')).toBe(true);

    newStop.resolve();
    await act(async () => newPromise);
    expect(controls.isCommandStopping('command-1')).toBe(false);
  });

  it('tracks concurrent different-command starts independently', async () => {
    apiMocks.getStatus.mockResolvedValue({ isRunning: false, commands: [] });
    const first = deferred<RunStatus>();
    const second = deferred<RunStatus>();
    apiMocks.startCommand
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    await act(async () => root.render(createElement(Harness, { taskId: 'task-1' })));
    let firstPromise!: Promise<unknown>;
    let secondPromise!: Promise<unknown>;
    await act(async () => {
      firstPromise = controls.startCommand('command-1');
      secondPromise = controls.startCommand('command-2');
      await flushPromises();
    });
    expect(controls.isCommandStarting('command-1')).toBe(true);
    expect(controls.isCommandStarting('command-2')).toBe(true);

    first.resolve(status('command-1'));
    await act(async () => firstPromise);
    expect(controls.isCommandStarting('command-1')).toBe(false);
    expect(controls.isCommandStarting('command-2')).toBe(true);

    second.resolve(status('command-2'));
    await act(async () => secondPromise);
    expect(controls.isCommandStarting('command-2')).toBe(false);
  });

  it('ignores a superseded same-command port conflict and finally', async () => {
    apiMocks.getStatus.mockResolvedValue({ isRunning: false, commands: [] });
    const first = deferred<RunStatus>();
    const second = deferred<RunStatus>();
    apiMocks.startCommand
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    await act(async () => root.render(createElement(Harness, { taskId: 'task-1' })));
    let firstPromise!: Promise<unknown>;
    let secondPromise!: Promise<unknown>;
    await act(async () => {
      firstPromise = controls.startCommand('command-1');
      secondPromise = controls.startCommand('command-1');
      await flushPromises();
    });

    first.resolve({
      type: 'PortsInUseError',
      message: 'superseded conflict',
      portsInUse: [
        { port: 3000, commandId: 'command-1', command: 'pnpm dev' },
      ],
    } as never);
    await act(async () => firstPromise);
    expect(controls.isCommandStarting('command-1')).toBe(true);
    expect(controls.portsInUseError).toBeNull();

    second.resolve(status('command-1'));
    await act(async () => secondPromise);
    expect(controls.isCommandStarting('command-1')).toBe(false);
  });

  it('keeps an out-of-order conflict and retry request from the same operation', async () => {
    apiMocks.getStatus.mockResolvedValue({ isRunning: false, commands: [] });
    const first = deferred<RunStatus>();
    const second = deferred<RunStatus>();
    const retry = deferred<RunStatus>();
    apiMocks.startCommand
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(retry.promise);

    await act(async () => root.render(createElement(Harness, { taskId: 'task-1' })));
    let firstPromise!: Promise<unknown>;
    let secondPromise!: Promise<unknown>;
    await act(async () => {
      firstPromise = controls.startCommand('command-1');
      secondPromise = controls.startCommand('command-2');
      await flushPromises();
    });

    second.resolve({
      type: 'PortsInUseError',
      message: 'second conflict',
      portsInUse: [
        { port: 4000, commandId: 'command-2', command: 'pnpm second' },
      ],
    } as never);
    await act(async () => secondPromise);
    first.resolve({
      type: 'PortsInUseError',
      message: 'first conflict',
      portsInUse: [
        { port: 3000, commandId: 'command-1', command: 'pnpm first' },
      ],
    } as never);
    await act(async () => firstPromise);

    expect(controls.portsInUseError?.message).toBe('first conflict');
    let retryPromise!: Promise<void>;
    await act(async () => {
      retryPromise = controls.confirmKillPorts();
      await flushPromises();
    });

    expect(apiMocks.killPortsForCommand).toHaveBeenCalledWith(
      'project-1',
      'command-1',
    );
    expect(apiMocks.startCommand).toHaveBeenLastCalledWith({
      taskId: 'task-1',
      runCommandId: 'command-1',
    });

    retry.resolve(status('command-1'));
    await act(async () => retryPromise);
  });
});

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}
