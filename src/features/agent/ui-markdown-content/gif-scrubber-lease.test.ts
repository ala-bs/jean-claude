import { describe, expect, it, vi } from 'vitest';

import { createGifScrubberLeaseCoordinator } from './gif-scrubber-lease';

describe('GIF scrubber lease', () => {
  it('revokes previous scrubber before granting next lease', () => {
    const coordinator = createGifScrubberLeaseCoordinator();
    const revokeA = vi.fn();
    const releaseA = coordinator.acquire(revokeA);
    const revokeB = vi.fn();
    const releaseB = coordinator.acquire(revokeB);

    expect(revokeA).toHaveBeenCalledOnce();
    expect(revokeB).not.toHaveBeenCalled();
    releaseA();
    coordinator.acquire(vi.fn());
    expect(revokeB).toHaveBeenCalledOnce();
    releaseB();
  });

  it('does not revoke a released scrubber', () => {
    const coordinator = createGifScrubberLeaseCoordinator();
    const revoke = vi.fn();
    coordinator.acquire(revoke)();
    coordinator.acquire(vi.fn());
    expect(revoke).not.toHaveBeenCalled();
  });
});
