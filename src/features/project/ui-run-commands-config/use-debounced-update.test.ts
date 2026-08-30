// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { useDebouncedUpdate } from './use-debounced-update';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

type Update = { name: string | null; command: string };

/** Minimal renderHook: no testing-library in this repo. */
function renderHook<P, R>(
  useHook: (props: P) => R,
  options?: { initialProps: P },
) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const result = { current: undefined as R };

  function Harness(props: { hookProps: P }) {
    result.current = useHook(props.hookProps);
    return null;
  }

  const render = (hookProps: P) => {
    act(() => {
      root.render(createElement(Harness, { hookProps }));
    });
  };

  render((options?.initialProps ?? ({} as P)) as P);

  return {
    result,
    rerender: (hookProps: P) => render(hookProps),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('useDebouncedUpdate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves after the delay instead of on every keystroke', () => {
    const onUpdate = vi.fn();
    const { result } = renderHook(() =>
      useDebouncedUpdate<Update>(onUpdate, 500),
    );

    act(() => result.current.schedule({ command: 'p' }));
    act(() => result.current.schedule({ command: 'pn' }));
    act(() => vi.advanceTimersByTime(499));
    expect(onUpdate).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({ command: 'pn' });
  });

  it('merges fields edited within one window into a single save', () => {
    const onUpdate = vi.fn();
    const { result } = renderHook(() =>
      useDebouncedUpdate<Update>(onUpdate, 500),
    );

    act(() => result.current.schedule({ name: 'dev' }));
    act(() => result.current.schedule({ command: 'pnpm dev' }));
    act(() => vi.advanceTimersByTime(500));

    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({
      name: 'dev',
      command: 'pnpm dev',
    });
  });

  it('flushes pending edits immediately and only once', () => {
    const onUpdate = vi.fn();
    const { result } = renderHook(() =>
      useDebouncedUpdate<Update>(onUpdate, 500),
    );

    act(() => result.current.schedule({ command: 'pnpm dev' }));
    act(() => result.current.flush());
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({ command: 'pnpm dev' });

    act(() => vi.advanceTimersByTime(500));
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('does not save when there is nothing pending', () => {
    const onUpdate = vi.fn();
    const { result } = renderHook(() =>
      useDebouncedUpdate<Update>(onUpdate, 500),
    );

    act(() => result.current.flush());
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('discard drops a buffered field without saving it', () => {
    const onUpdate = vi.fn();
    const { result } = renderHook(() =>
      useDebouncedUpdate<Update>(onUpdate, 500),
    );

    act(() => result.current.schedule({ name: 'typo' }));
    act(() => result.current.discard('name'));
    act(() => vi.advanceTimersByTime(500));

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('cancel abandons pending edits (row deleted)', () => {
    const onUpdate = vi.fn();
    const { result, unmount } = renderHook(() =>
      useDebouncedUpdate<Update>(onUpdate, 500),
    );

    act(() => result.current.schedule({ command: 'pnpm dev' }));
    act(() => result.current.cancel());
    unmount();
    act(() => vi.advanceTimersByTime(500));

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('flushes pending edits on unmount', () => {
    const onUpdate = vi.fn();
    const { result, unmount } = renderHook(() =>
      useDebouncedUpdate<Update>(onUpdate, 500),
    );

    act(() => result.current.schedule({ command: 'pnpm dev' }));
    unmount();

    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({ command: 'pnpm dev' });
  });

  it('reports a field as pending until the server value catches up', () => {
    const onUpdate = vi.fn();
    const { result } = renderHook(() =>
      useDebouncedUpdate<Update>(onUpdate, 500),
    );

    expect(result.current.hasPending('command', 'old')).toBe(false);

    act(() => result.current.schedule({ command: 'new' }));
    expect(result.current.hasPending('command', 'old')).toBe(true);

    act(() => result.current.flush());
    // Save dispatched but a stale query result may still arrive: stay guarded.
    expect(result.current.hasPending('command', 'old')).toBe(true);

    // Server echoes the saved value: the field settles.
    expect(result.current.hasPending('command', 'new')).toBe(false);
    expect(result.current.hasPending('command', 'old')).toBe(false);
  });

  it('uses the latest callback when flushing', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(
      ({ onUpdate }) => useDebouncedUpdate<Update>(onUpdate, 500),
      { initialProps: { onUpdate: first } },
    );

    act(() => result.current.schedule({ command: 'pnpm dev' }));
    rerender({ onUpdate: second });
    act(() => vi.advanceTimersByTime(500));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith({ command: 'pnpm dev' });
  });
});
