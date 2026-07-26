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
};

function getBeforeQuitRegistry(): BeforeQuitRegistry {
  const globalWithRegistry = globalThis as Record<symbol, BeforeQuitRegistry>;
  globalWithRegistry[BEFORE_QUIT_REGISTRY] ??= {
    cleanups: new Set<() => Promise<void>>(),
    registered: false,
    cleanupPromise: null,
    isQuittingAfterCleanup: false,
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

  if (registry.registered) return;

  registry.registered = true;
  lifecycle.onBeforeQuit((event) => {
    if (registry.isQuittingAfterCleanup) return;

    event?.preventDefault();

    registry.cleanupPromise ??= Promise.allSettled(
      Array.from(registry.cleanups, (registeredCleanup) => registeredCleanup()),
    )
      .then((results) => {
        results.forEach((result) => {
          if (result.status === 'rejected') {
            logger.error(
              'Failed to stop mobile preview sessions before quit:',
              result.reason,
            );
          }
        });
      })
      .finally(() => {
        registry.cleanupPromise = null;
        registry.isQuittingAfterCleanup = true;
        lifecycle.quitAfterCleanup?.();
      });
  });
}
