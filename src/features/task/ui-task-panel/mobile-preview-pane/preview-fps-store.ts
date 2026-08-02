export type PreviewFpsStore = {
  get: () => number;
  set: (nextFps: number) => void;
  subscribe: (listener: () => void) => () => void;
};

/**
 * Preview FPS refreshes once per second (and per decoded H264 batch). Keeping
 * it out of React state stops a fps readout from re-rendering the whole pane.
 */
export function createPreviewFpsStore(): PreviewFpsStore {
  let value = 0;
  const listeners = new Set<() => void>();

  return {
    get: () => value,
    set: (nextFps) => {
      if (nextFps === value) return;
      value = nextFps;
      listeners.forEach((listener) => {
        listener();
      });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
