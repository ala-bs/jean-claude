// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { useMemoryUsage } from './use-memory-usage';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('useMemoryUsage', () => {
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

  it('keeps high-frequency overlay samples out of shared header history', async () => {
    const getMemoryUsage = vi
      .spyOn(api.system, 'getMemoryUsage')
      .mockResolvedValue({
        logicalCpuCount: 8,
        totalRssBytes: 300,
        mainProcess: { heapUsedBytes: 50, rssBytes: 100, cpuPercent: 2 },
        rendererProcess: {
          rssBytes: 200,
          privateBytes: 150,
          cpuPercent: 3,
        },
      });

    function OverlayHarness() {
      useMemoryUsage({ pollIntervalMs: 500, isolatedHistory: true });
      return null;
    }

    const queryClient = new QueryClient();
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(OverlayHarness),
        ),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    act(() => root.unmount());
    root = createRoot(container);
    getMemoryUsage.mockImplementation(() => new Promise(() => {}));
    let sharedHistoryLength = -1;

    function HeaderHarness() {
      sharedHistoryLength = useMemoryUsage().history.length;
      return null;
    }

    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(HeaderHarness),
        ),
      );
    });

    expect(sharedHistoryLength).toBe(0);
  });

  it('polls app metrics at the requested interval', async () => {
    const getMemoryUsage = vi
      .spyOn(api.system, 'getMemoryUsage')
      .mockResolvedValue({
        logicalCpuCount: 8,
        totalRssBytes: 300,
        mainProcess: { heapUsedBytes: 50, rssBytes: 100, cpuPercent: 2 },
        rendererProcess: {
          rssBytes: 200,
          privateBytes: 150,
          cpuPercent: 3,
        },
      });

    function Harness() {
      useMemoryUsage({ pollIntervalMs: 500 });
      return null;
    }

    const queryClient = new QueryClient();
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

    expect(getMemoryUsage).toHaveBeenCalledTimes(3);
  });
});
