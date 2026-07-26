import { setTimeout as sleep } from 'node:timers/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerBeforeQuitCleanup } from './mobile-preview-lifecycle';

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
});
