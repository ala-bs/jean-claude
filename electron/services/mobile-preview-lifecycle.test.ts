import { setTimeout as sleep } from 'node:timers/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  registerBeforeQuitCleanup,
  runBeforeQuitCleanups,
  stopVetoingQuit,
} from './mobile-preview-lifecycle';

const BEFORE_QUIT_REGISTRY = Symbol.for(
  'jean-claude.mobile-preview.before-quit-registry',
);

describe('mobile preview lifecycle', () => {
  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[BEFORE_QUIT_REGISTRY];
  });

  it('completes cleanup without owning quit and allows the next quit through', async () => {
    let beforeQuit: ((event?: { preventDefault: () => void }) => void) | null =
      null;
    const cleanup = vi.fn(async () => {});
    const firstPreventDefault = vi.fn();
    const secondPreventDefault = vi.fn();
    const appQuit = vi.fn(() => {
      (beforeQuit as unknown as (
        event: { preventDefault: () => void },
      ) => void)({ preventDefault: secondPreventDefault });
    });

    registerBeforeQuitCleanup({
      cleanup,
      lifecycle: {
        onBeforeQuit: (callback) => {
          beforeQuit = callback;
        },
      },
      logger: { error: vi.fn() },
    });

    expect(beforeQuit).toBeTypeOf('function');
    (beforeQuit as unknown as (event: { preventDefault: () => void }) => void)({
      preventDefault: firstPreventDefault,
    });
    await sleep(0);

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(appQuit).not.toHaveBeenCalled();
    expect(firstPreventDefault).toHaveBeenCalledTimes(1);

    appQuit();

    expect(appQuit).toHaveBeenCalledTimes(1);
    expect(secondPreventDefault).not.toHaveBeenCalled();
  });

  it('runs every registered cleanup and dedupes concurrent runs', async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    const logger = { error: vi.fn() };
    const lifecycle = { onBeforeQuit: () => {} };

    registerBeforeQuitCleanup({ cleanup: first, lifecycle, logger });
    registerBeforeQuitCleanup({ cleanup: second, lifecycle, logger });

    // The before-quit listener and the main process quit sequence can both ask
    // for cleanup; overlapping calls must share one run.
    await Promise.all([runBeforeQuitCleanups(), runBeforeQuitCleanups()]);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('logs a failing cleanup instead of rejecting, and stops vetoing quit', async () => {
    let beforeQuit: ((event?: { preventDefault: () => void }) => void) | null =
      null;
    const logger = { error: vi.fn() };

    registerBeforeQuitCleanup({
      cleanup: async () => {
        throw new Error('stop failed');
      },
      lifecycle: {
        onBeforeQuit: (callback) => {
          beforeQuit = callback;
        },
      },
      logger,
    });

    await expect(runBeforeQuitCleanups()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);

    const preventDefault = vi.fn();
    (beforeQuit as unknown as (event: { preventDefault: () => void }) => void)({
      preventDefault,
    });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('stopVetoingQuit lets a later quit through even if cleanup never ran', () => {
    let beforeQuit: ((event?: { preventDefault: () => void }) => void) | null =
      null;

    registerBeforeQuitCleanup({
      cleanup: async () => {
        await sleep(10_000);
      },
      lifecycle: {
        onBeforeQuit: (callback) => {
          beforeQuit = callback;
        },
      },
      logger: { error: vi.fn() },
    });

    stopVetoingQuit();

    const preventDefault = vi.fn();
    (beforeQuit as unknown as (event: { preventDefault: () => void }) => void)({
      preventDefault,
    });
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
