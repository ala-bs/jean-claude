import { describe, expect, it, vi } from 'vitest';

import { createGestureFeedbackStore } from './gesture-feedback-store';

describe('createGestureFeedbackStore', () => {
  it('notifies subscribers on value changes', () => {
    const store = createGestureFeedbackStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.set({ id: 1, points: [{ x: 1, y: 2 }], released: false });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual({
      id: 1,
      points: [{ x: 1, y: 2 }],
      released: false,
    });

    unsubscribe();
    store.set(null);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('supports updater functions and skips identical values', () => {
    const store = createGestureFeedbackStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.set({ id: 1, points: [], released: false });
    store.set((current) => current);

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
