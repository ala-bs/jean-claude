export type MobilePreviewLifecycle = {
  onBeforeQuit: (
    callback: (event?: { preventDefault: () => void }) => void,
  ) => void;
  quitAfterCleanup?: () => void;
};

const BEFORE_QUIT_REGISTRY = Symbol.for(
  'jean-claude.mobile-preview.before-quit-registry',
);

type BeforeQuitRegistry = {
  cleanups: Set<() => Promise<void>>;
  registered: boolean;
  cleanupPromise: Promise<void> | null;
  isQuittingAfterCleanup: boolean;
  logger: Pick<typeof console, 'error'> | null;
};

function getBeforeQuitRegistry(): BeforeQuitRegistry {
  const globalWithRegistry = globalThis as Record<symbol, BeforeQuitRegistry>;
  globalWithRegistry[BEFORE_QUIT_REGISTRY] ??= {
    cleanups: new Set<() => Promise<void>>(),
    registered: false,
    cleanupPromise: null,
    isQuittingAfterCleanup: false,
    logger: null,
  };

  return globalWithRegistry[BEFORE_QUIT_REGISTRY];
}

export function registerBeforeQuitCleanup({
  cleanup,
  lifecycle,
  logger,
}: {
  cleanup: () => Promise<void>;
  lifecycle: MobilePreviewLifecycle;
  logger: Pick<typeof console, 'error'>;
}): void {
  const registry = getBeforeQuitRegistry();
  registry.cleanups.add(cleanup);
  registry.logger ??= logger;

  if (registry.registered) return;

  registry.registered = true;
  lifecycle.onBeforeQuit((event) => {
    if (registry.isQuittingAfterCleanup) return;

    event?.preventDefault();

    void runBeforeQuitCleanups().finally(() => {
      lifecycle.quitAfterCleanup?.();
    });
  });
}

/**
 * Runs (once) every registered mobile-preview cleanup. The main process awaits
 * this inside its own quit sequence so there is a single owner of `app.quit()`:
 * the registry must never quit on its own, or it can exit the app while agent
 * shutdown and database writes are still in flight.
 */
export function runBeforeQuitCleanups(): Promise<void> {
  const registry = getBeforeQuitRegistry();
  registry.cleanupPromise ??= Promise.allSettled(
    Array.from(registry.cleanups, (registeredCleanup) => registeredCleanup()),
  )
    .then((results) => {
      results.forEach((result) => {
        if (result.status === 'rejected') {
          registry.logger?.error(
            'Failed to stop mobile preview sessions before quit:',
            result.reason,
          );
        }
      });
    })
    .finally(() => {
      registry.cleanupPromise = null;
      registry.isQuittingAfterCleanup = true;
    });

  return registry.cleanupPromise;
}

/**
 * Stops the registry from vetoing further quits, so a timed-out or failed
 * cleanup can never wedge the app in a non-quittable state.
 */
export function stopVetoingQuit(): void {
  getBeforeQuitRegistry().isQuittingAfterCleanup = true;
}
