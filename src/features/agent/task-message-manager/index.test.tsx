// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import type { AgentUIEvent } from '@shared/agent-ui-events';
import { createRoot } from 'react-dom/client';

import { cache$, resetCache } from '@/cache/cache-store';
import { stepResourceKey, taskStepsResourceKey } from '@/cache/domains/steps';
import { setResourceSuccess } from '@/cache/cache-actions';
import { taskResourceKey } from '@/cache/domains/tasks';

import { TaskMessageManager } from '.';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  agentEventHandler: null as ((event: AgentUIEvent) => void) | null,
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
      onLog: vi.fn(() => vi.fn()),
      onLogsReset: vi.fn(() => vi.fn()),
      onStatusChange: vi.fn(() => vi.fn()),
    },
  },
}));

describe('TaskMessageManager', () => {
  beforeEach(() => {
    resetCache();
    apiMocks.agentEventHandler = null;
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
});
