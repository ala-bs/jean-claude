// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';

import { clearPendingResources, useCacheResource } from './use-cache-resource';
import { markResourceStale } from './cache-actions';
import { resetCache } from './cache-store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** Minimal renderHook: no testing-library in this repo. */
function renderHook<R>(useHook: () => R) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  function Harness() {
    useHook();
    return null;
  }

  act(() => {
    root.render(createElement(Harness, {}));
  });

  return {
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** Lets queued promise callbacks run while fake timers are installed. */
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useCacheResource staleReloadDelayMs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetCache();
    clearPendingResources();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapses a burst of invalidations into a single reload', async () => {
    const load = vi.fn(async () => ['item']);
    renderHook(() =>
      useCacheResource({
        key: 'feed:tasks',
        load,
        staleReloadDelayMs: 2000,
      }),
    );

    // The initial mount load is immediate; only invalidations are delayed.
    await flushMicrotasks();
    expect(load).toHaveBeenCalledTimes(1);

    // A running agent marks the feed stale repeatedly. Before the fix each of
    // these was a full reload costing seconds of git subprocesses.
    for (let index = 0; index < 5; index += 1) {
      act(() => {
        markResourceStale('feed:tasks');
        vi.advanceTimersByTime(300);
      });
      await flushMicrotasks();
    }

    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    await flushMicrotasks();

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('reloads immediately when no delay is configured', async () => {
    const load = vi.fn(async () => ['item']);
    renderHook(() => useCacheResource({ key: 'feed:notes', load }));

    await flushMicrotasks();
    expect(load).toHaveBeenCalledTimes(1);

    act(() => {
      markResourceStale('feed:notes');
    });
    await flushMicrotasks();

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('abandons a pending reload when the resource unmounts', async () => {
    const load = vi.fn(async () => ['item']);
    const { unmount } = renderHook(() =>
      useCacheResource({
        key: 'feed:tasks',
        load,
        staleReloadDelayMs: 2000,
      }),
    );

    await flushMicrotasks();
    act(() => {
      markResourceStale('feed:tasks');
    });

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await flushMicrotasks();

    expect(load).toHaveBeenCalledTimes(1);
  });
});
