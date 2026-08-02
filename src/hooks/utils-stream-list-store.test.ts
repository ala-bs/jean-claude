import { describe, expect, it, vi } from 'vitest';

import { createStreamListStore } from './utils-stream-list-store';

describe('createStreamListStore', () => {
  it('appends items and trims to the max size', () => {
    const store = createStreamListStore<number>();
    const listener = vi.fn();
    store.subscribe(listener);

    store.append([1, 2, 3], 2);

    expect(store.get()).toEqual([2, 3]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('ignores empty appends and redundant clears', () => {
    const store = createStreamListStore<number>();
    const listener = vi.fn();
    store.subscribe(listener);

    store.append([], 10);
    store.clear();

    expect(listener).not.toHaveBeenCalled();

    store.append([1], 10);
    store.clear();

    expect(store.get()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('stops notifying after unsubscribe', () => {
    const store = createStreamListStore<number>();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    unsubscribe();
    store.append([1], 10);

    expect(listener).not.toHaveBeenCalled();
  });
});
