// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import type { AgentUIEvent } from '@shared/agent-ui-events';
import { createRoot } from 'react-dom/client';
import type { RunStatus } from '@shared/run-command-types';

import { cache$, resetCache } from '@/cache/cache-store';
import { stepResourceKey, taskStepsResourceKey } from '@/cache/domains/steps';
import { api } from '@/lib/api';
import { setResourceSuccess } from '@/cache/cache-actions';
import { taskResourceKey } from '@/cache/domains/tasks';
import { useTaskMessagesStore } from '@/stores/task-messages';

import { TaskMessageManager } from '.';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  agentEventHandler: null as ((event: AgentUIEvent) => void) | null,
  runCommandStatusHandler: null as
    | ((taskId: string, status: RunStatus) => void)
    | null,
}));

vi.mock('@/lib/api', () => ({
  api: {
    agent: {
      onEvent: vi.fn((handler: (event: AgentUIEvent) => void) => {
        apiMocks.agentEventHandler = handler;
        return vi.fn();
      }),
    },
    runCommands: {
      getTaskIdsWithRunningCommands: vi.fn().mockResolvedValue([]),
      getStatus: vi.fn(),
      onLog: vi.fn(() => vi.fn()),
      onLogsReset: vi.fn(() => vi.fn()),
      onStatusChange: vi.fn(
        (handler: (taskId: string, status: RunStatus) => void) => {
          apiMocks.runCommandStatusHandler = handler;
          return vi.fn();
        },
      ),
    },
  },
}));

describe('TaskMessageManager', () => {
  beforeEach(() => {
    resetCache();
    apiMocks.agentEventHandler = null;
    apiMocks.runCommandStatusHandler = null;
    useTaskMessagesStore.setState({
      areRunCommandStatusesHydrated: false,
      runCommandRunning: {},
    });
    vi.mocked(api.runCommands.getTaskIdsWithRunningCommands).mockReset();
    vi.mocked(api.runCommands.getTaskIdsWithRunningCommands).mockResolvedValue(
      [],
    );
    vi.mocked(api.runCommands.getStatus).mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('invalidates normalized status resources on agent status events', async () => {
    const resourceKeys = [
      taskResourceKey('task-1'),
      taskStepsResourceKey('task-1'),
      stepResourceKey('step-1'),
    ];
    resourceKeys.forEach(setResourceSuccess);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <TaskMessageManager />
        </QueryClientProvider>,
      );
    });

    act(() => {
      apiMocks.agentEventHandler?.({
        type: 'status',
        taskId: 'task-1',
        stepId: 'step-1',
        status: 'interrupted',
      });
    });

    for (const resourceKey of resourceKeys) {
      expect(cache$.resources[resourceKey].get()?.stale).toBe(true);
    }

    await act(async () => root.unmount());
  });

  it('invalidates worktree changes on turn boundary but not on waiting', async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TaskMessageManager />
        </QueryClientProvider>,
      );
    });

    const diffInvalidations = () =>
      invalidateSpy.mock.calls.filter(
        (call) =>
          Array.isArray(call[0]?.queryKey) &&
          call[0].queryKey[0] === 'worktree-diff',
      ).length;

    act(() => {
      apiMocks.agentEventHandler?.({
        type: 'status',
        taskId: 'task-1',
        stepId: 'step-1',
        status: 'waiting',
      });
    });
    expect(diffInvalidations()).toBe(0);

    act(() => {
      apiMocks.agentEventHandler?.({
        type: 'status',
        taskId: 'task-1',
        stepId: 'step-1',
        status: 'completed',
      });
    });
    expect(diffInvalidations()).toBe(1);

    await act(async () => root.unmount());
  });

  it('marks run-command statuses hydrated only after delayed status fetch settles', async () => {
    let resolveStatus!: (status: {
      isRunning: boolean;
      commands: [];
    }) => void;
    const statusPromise = new Promise<{
      isRunning: boolean;
      commands: [];
    }>((resolve) => {
      resolveStatus = resolve;
    });
    vi.mocked(api.runCommands.getTaskIdsWithRunningCommands).mockResolvedValue([
      'task-1',
    ]);
    vi.mocked(api.runCommands.getStatus).mockReturnValue(statusPromise);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <TaskMessageManager />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    expect(
      useTaskMessagesStore.getState().areRunCommandStatusesHydrated,
    ).toBe(false);

    await act(async () => {
      resolveStatus({ isRunning: false, commands: [] });
      await statusPromise;
      await Promise.resolve();
    });

    expect(
      useTaskMessagesStore.getState().areRunCommandStatusesHydrated,
    ).toBe(true);
    await act(async () => root.unmount());
  });

  it('marks run-command statuses hydrated when initialization fails', async () => {
    vi.mocked(api.runCommands.getTaskIdsWithRunningCommands).mockRejectedValue(
      new Error('shutdown'),
    );
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <TaskMessageManager />
        </QueryClientProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      useTaskMessagesStore.getState().areRunCommandStatusesHydrated,
    ).toBe(true);
    await act(async () => root.unmount());
  });

  it('does not re-add stale running status after a newer stop event', async () => {
    const runningStatus = (port: number): RunStatus => ({
      isRunning: true,
      commands: [
        {
          id: 'mobile-dev-server:app',
          name: 'Metro',
          command: 'pnpm start',
          ports: [port],
          status: 'running',
        },
      ],
    });
    let resolveSlowStatus!: (status: RunStatus) => void;
    const slowStatusPromise = new Promise<RunStatus>((resolve) => {
      resolveSlowStatus = resolve;
    });
    vi.mocked(api.runCommands.getTaskIdsWithRunningCommands).mockResolvedValue([
      'slow-task',
      'fast-task',
    ]);
    vi.mocked(api.runCommands.getStatus).mockImplementation((taskId) =>
      taskId === 'slow-task'
        ? slowStatusPromise
        : Promise.resolve(runningStatus(8082)),
    );
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <TaskMessageManager />
        </QueryClientProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      useTaskMessagesStore.getState().runCommandRunning['fast-task'],
    ).toEqual(runningStatus(8082));
    expect(
      useTaskMessagesStore.getState().areRunCommandStatusesHydrated,
    ).toBe(false);

    act(() => {
      apiMocks.runCommandStatusHandler?.('slow-task', {
        isRunning: false,
        commands: [
          {
            ...runningStatus(8081).commands[0],
            status: 'stopped',
          },
        ],
      });
    });

    await act(async () => {
      resolveSlowStatus(runningStatus(8081));
      await slowStatusPromise;
      await Promise.resolve();
    });

    expect(
      useTaskMessagesStore.getState().runCommandRunning['slow-task'],
    ).toBeUndefined();
    expect(
      useTaskMessagesStore.getState().runCommandRunning['fast-task'],
    ).toEqual(runningStatus(8082));
    expect(
      useTaskMessagesStore.getState().areRunCommandStatusesHydrated,
    ).toBe(true);
    await act(async () => root.unmount());
  });
});
