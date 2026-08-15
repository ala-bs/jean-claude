import { describe, expect, it, vi } from 'vitest';

import { waitForDevToolsReattach } from './utils-devtools-reattach';

const noSleep = () => Promise.resolve();

describe('waitForDevToolsReattach', () => {
  it('waits for the app to come back before reporting reattachment', async () => {
    const pollTargetIds = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['old'])
      .mockResolvedValueOnce(['new']);

    const result = await waitForDevToolsReattach({
      previousTargetIds: ['old'],
      pollTargetIds,
      sleep: noSleep,
    });

    expect(result).toBe('reattached');
    expect(pollTargetIds).toHaveBeenCalledTimes(3);
  });

  it('gives the app a grace period before the first poll', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    await waitForDevToolsReattach({
      previousTargetIds: [],
      pollTargetIds: async () => ['new'],
      sleep,
      initialDelayMs: 1234,
    });

    expect(sleep).toHaveBeenCalledWith(1234);
  });

  it('sleeps between attempts but not after the final one', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    await waitForDevToolsReattach({
      previousTargetIds: ['old'],
      pollTargetIds: async () => ['old'],
      sleep,
      initialDelayMs: 10,
      intervalMs: 20,
      maxAttempts: 3,
    });

    // one grace delay + two inter-attempt delays, none trailing the last poll
    expect(sleep.mock.calls).toEqual([[10], [20], [20]]);
  });

  it('stops after the attempt budget when no new target appears', async () => {
    const pollTargetIds = vi.fn().mockResolvedValue(['old']);

    const result = await waitForDevToolsReattach({
      previousTargetIds: ['old'],
      pollTargetIds,
      sleep: noSleep,
      maxAttempts: 3,
    });

    expect(result).toBe('timeout');
    expect(pollTargetIds).toHaveBeenCalledTimes(3);
  });

  it('treats any target as new when nothing was attached before the restart', async () => {
    const result = await waitForDevToolsReattach({
      previousTargetIds: [],
      pollTargetIds: async () => ['page-1'],
      sleep: noSleep,
    });

    expect(result).toBe('reattached');
  });

  it('keeps polling when a probe throws', async () => {
    const pollTargetIds = vi
      .fn()
      .mockRejectedValueOnce(new Error('metro down'))
      .mockResolvedValueOnce(['new']);

    const result = await waitForDevToolsReattach({
      previousTargetIds: [],
      pollTargetIds,
      sleep: noSleep,
    });

    expect(result).toBe('reattached');
  });

  it('bails out when cancelled before the first poll', async () => {
    const pollTargetIds = vi.fn().mockResolvedValue([]);

    const result = await waitForDevToolsReattach({
      previousTargetIds: [],
      pollTargetIds,
      sleep: noSleep,
      isCancelled: () => true,
    });

    expect(result).toBe('cancelled');
    expect(pollTargetIds).not.toHaveBeenCalled();
  });

  it('bails out mid-loop when a newer restart supersedes it', async () => {
    let cancelled = false;
    const pollTargetIds = vi.fn().mockImplementation(async () => {
      cancelled = true;
      return ['old'];
    });

    const result = await waitForDevToolsReattach({
      previousTargetIds: ['old'],
      pollTargetIds,
      sleep: noSleep,
      isCancelled: () => cancelled,
    });

    expect(result).toBe('cancelled');
    expect(pollTargetIds).toHaveBeenCalledTimes(1);
  });
});
