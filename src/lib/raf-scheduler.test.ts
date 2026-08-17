import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRafScheduler } from './raf-scheduler';

describe('createRafScheduler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('coalesces updates into one animation frame', () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const callback = vi.fn();
    const scheduler = createRafScheduler(callback);

    scheduler.schedule(1);
    scheduler.schedule(2);
    frame?.(0);

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(2);
  });

  it('flushes pending update and cancels scheduled frame', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);
    const callback = vi.fn();
    const scheduler = createRafScheduler(callback);

    scheduler.schedule(3);
    scheduler.flush();

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(callback).toHaveBeenCalledWith(3);
  });

  it('cancels pending update without invoking callback', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const callback = vi.fn();
    const scheduler = createRafScheduler(callback);

    scheduler.schedule(4);
    scheduler.cancel();
    scheduler.flush();

    expect(callback).not.toHaveBeenCalled();
  });
});
