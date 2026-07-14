// @vitest-environment happy-dom

import { act, createElement, Fragment } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { AgentResourceSnapshot } from '@shared/agent-resource-types';
import { api } from '@/lib/api';
import { useAgentResourceSnapshots } from './use-agent-resource-snapshots';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('useAgentResourceSnapshots', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('polls latest snapshots without repeatedly fetching full history', async () => {
    const getResourceSnapshots = vi
      .spyOn(api.agent, 'getResourceSnapshots')
      .mockResolvedValue([]);
    const getResourceHistory = vi
      .spyOn(api.agent, 'getResourceHistory')
      .mockResolvedValue({});

    function Harness() {
      useAgentResourceSnapshots({ refetchIntervalMs: 500 });
      return null;
    }

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness),
        ),
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(getResourceSnapshots).toHaveBeenCalledTimes(3);
    expect(getResourceHistory).toHaveBeenCalledTimes(1);
  });

  it('keeps history synchronized across hook consumers', async () => {
    const snapshot: AgentResourceSnapshot = {
      stepId: 'step-1',
      taskId: 'task-1',
      backend: 'opencode',
      rootPid: 10,
      pids: [10],
      sampledAt: new Date().toISOString(),
      cpuPercent: 2,
      rssBytes: 100,
      peakCpuPercent: 2,
      peakRssBytes: 100,
      sampleCount: 1,
    };
    let resolveFirst!: (snapshots: AgentResourceSnapshot[]) => void;
    let resolveSecond!: (snapshots: AgentResourceSnapshot[]) => void;
    vi.spyOn(api.agent, 'getResourceSnapshots')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    vi.spyOn(api.agent, 'getResourceHistory').mockResolvedValue({});
    let firstHistory: AgentResourceSnapshot[] = [];
    let secondHistory: AgentResourceSnapshot[] = [];

    function FirstConsumer() {
      const first = useAgentResourceSnapshots({ refetchIntervalMs: 500 });
      firstHistory = first.historyByStepId['step-1'] ?? [];
      return null;
    }

    function SecondConsumer() {
      const second = useAgentResourceSnapshots({ refetchIntervalMs: 500 });
      secondHistory = second.historyByStepId['step-1'] ?? [];
      return null;
    }

    const firstQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const secondQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    act(() => {
      root.render(
        createElement(
          Fragment,
          null,
          createElement(
            QueryClientProvider,
            { client: firstQueryClient },
            createElement(FirstConsumer),
          ),
          createElement(
            QueryClientProvider,
            { client: secondQueryClient },
            createElement(SecondConsumer),
          ),
        ),
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      resolveFirst([snapshot]);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(firstHistory).toEqual([snapshot]);
    expect(secondHistory).toEqual([snapshot]);

    resolveSecond([snapshot]);
  });
});
