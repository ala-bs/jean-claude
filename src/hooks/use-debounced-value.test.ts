import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDebouncedPublisher } from './use-debounced-value';

describe('createDebouncedPublisher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes only the latest scheduled value after the delay', () => {
    const publish = vi.fn();
    const publisher = createDebouncedPublisher(250, publish);

    publisher.schedule('a');
    vi.advanceTimersByTime(100);
    publisher.schedule('azure');
    vi.advanceTimersByTime(249);

    expect(publish).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith('azure');
  });

  it('cancels pending publication', () => {
    const publish = vi.fn();
    const publisher = createDebouncedPublisher(250, publish);

    publisher.schedule('stale');
    publisher.cancel();
    vi.advanceTimersByTime(250);

    expect(publish).not.toHaveBeenCalled();
  });
});
