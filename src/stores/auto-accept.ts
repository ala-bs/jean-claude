import { useCallback, useEffect } from 'react';
import { create } from 'zustand';

import { api } from '@/lib/api';

/**
 * Auto-accept flags, keyed by step id.
 *
 * Purely in-memory on both sides of the bridge: the main process holds the
 * authoritative set and this store mirrors it for the UI. The flag stays on
 * across turns — it is dropped only when the user toggles it off or the app
 * restarts.
 */
type AutoAcceptState = {
  enabledByStepId: Record<string, boolean>;
  setEnabled: (stepId: string, enabled: boolean) => void;
};

const useAutoAcceptStore = create<AutoAcceptState>((set) => ({
  enabledByStepId: {},
  setEnabled: (stepId, enabled) =>
    set((state) => ({
      enabledByStepId: { ...state.enabledByStepId, [stepId]: enabled },
    })),
}));

export function useAutoAccept(stepId: string | undefined) {
  const enabled = useAutoAcceptStore((state) =>
    stepId ? (state.enabledByStepId[stepId] ?? false) : false,
  );
  const setEnabledAction = useAutoAcceptStore((state) => state.setEnabled);

  // Main owns the flag, so re-read it rather than trusting a mirror that a
  // renderer reload can reset independently of the main-process value.
  useEffect(() => {
    if (!stepId) return;
    let cancelled = false;
    void Promise.resolve()
      .then(() => api.steps.getAutoAccept(stepId))
      .then((value) => {
        if (!cancelled) setEnabledAction(stepId, value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [stepId, setEnabledAction]);

  const setEnabled = useCallback(
    async (next: boolean) => {
      if (!stepId) return;
      // Optimistic: the toggle is a UI affordance, the main process is truth.
      setEnabledAction(stepId, next);
      try {
        const applied = await api.steps.setAutoAccept(stepId, next);
        setEnabledAction(stepId, applied);
      } catch {
        setEnabledAction(stepId, !next);
      }
    },
    [stepId, setEnabledAction],
  );

  const toggle = useCallback(() => setEnabled(!enabled), [enabled, setEnabled]);

  return { enabled, setEnabled, toggle };
}
