export function createRafScheduler<T>(callback: (value: T) => void) {
  let frameId: number | null = null;
  let pendingValue: T | undefined;
  let hasPendingValue = false;

  const flush = () => {
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    if (!hasPendingValue) return;

    const value = pendingValue as T;
    pendingValue = undefined;
    hasPendingValue = false;
    callback(value);
  };

  return {
    schedule(value: T) {
      pendingValue = value;
      hasPendingValue = true;
      if (frameId === null) {
        frameId = requestAnimationFrame(() => {
          frameId = null;
          flush();
        });
      }
    },
    flush,
    cancel() {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null;
      pendingValue = undefined;
      hasPendingValue = false;
    },
  };
}
