import { useCallback, useEffect } from 'react';
import { create } from 'zustand';

import { api } from '@/lib/api';

/**
 * Per-session auto-accept flags, keyed by step id.
 *
 * Purely in-memory on both sides of the bridge: the main process holds the
 * authoritative set and this store mirrors it for the UI. Both are cleared
 * when the app restarts, which is what makes the mode "session only".
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

  // Main owns the flag and drops it when the step's session is torn down, so
  // re-read it instead of trusting a mirror that can outlive the session (or be
  // reset by a renderer reload).
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
