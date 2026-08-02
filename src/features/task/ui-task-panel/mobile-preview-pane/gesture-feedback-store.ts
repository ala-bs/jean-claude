export const GESTURE_FEEDBACK_FADE_MS = 300;

export type GestureFeedback = {
  id: number;
  points: Array<{ x: number; y: number }>;
  released: boolean;
};

type GestureFeedbackUpdate =
  | GestureFeedback
  | null
  | ((current: GestureFeedback | null) => GestureFeedback | null);

export type GestureFeedbackStore = {
  get: () => GestureFeedback | null;
  set: (update: GestureFeedbackUpdate) => void;
  subscribe: (listener: () => void) => () => void;
};

/**
 * Gesture feedback updates on every pointermove. Keeping it in an external
 * store (instead of React state on the pane) means only the memoized overlay
 * re-renders while dragging, never the preview surface or the tab bodies.
 */
export function createGestureFeedbackStore(): GestureFeedbackStore {
  let value: GestureFeedback | null = null;
  const listeners = new Set<() => void>();

  return {
    get: () => value,
    set: (update) => {
      const nextValue =
        typeof update === 'function' ? update(value) : update;
      if (nextValue === value) return;
      value = nextValue;
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
