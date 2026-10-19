import { type RefObject, useCallback, useRef } from 'react';

import {
  type NewTaskDraft,
  useNewTaskDraftStore,
} from '@/stores/new-task-draft';

type DraftUpdate = Partial<NewTaskDraft>;

type ActivationState = {
  pending: number;
  hadSuccess: boolean;
  previousDraft: DraftUpdate | undefined;
  wasTouched: boolean;
};

/**
 * Owns model-profile activation for the New Task overlay.
 *
 * Activations are serialized on one queue so a fast burst of ⌘J presses is
 * persisted in the order it was typed, and the draft's step-level model
 * override is rolled back only when the whole burst failed.
 */
export function useProfileActivation({
  draftKey,
  updateDraft,
  activate,
  addToast,
  userTouchedSelectionRef,
}: {
  draftKey: string;
  updateDraft: (update: DraftUpdate) => void;
  activate: (profileId: string) => Promise<unknown>;
  addToast: (toast: { message: string; type: 'error' | 'success' }) => void;
  userTouchedSelectionRef: RefObject<boolean>;
}) {
  const pendingProfileRef = useRef<{
    draftKey: string;
    profileId: string;
  } | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingCountRef = useRef(0);
  const activationStateRef = useRef<Record<string, ActivationState>>({});

  const handleProfileActivated = useCallback(() => {
    // A profile choice supersedes a previous step-only model override.
    // Keep rate-limit suggestions from replacing this explicit choice.
    userTouchedSelectionRef.current = true;
    updateDraft({
      agentBackend: undefined,
      modelPreference: undefined,
      thinkingEffort: undefined,
      backendModelPresetId: null,
      shouldAutoSelectBackendModelPreset: false,
    });
  }, [updateDraft, userTouchedSelectionRef]);

  const selectProfile = useCallback(
    (profileId: string) => {
      const activation = activationStateRef.current[draftKey] ?? {
        pending: 0,
        hadSuccess: false,
        previousDraft: useNewTaskDraftStore.getState().drafts[draftKey],
        wasTouched: userTouchedSelectionRef.current,
      };
      activation.pending += 1;
      pendingCountRef.current += 1;
      activationStateRef.current[draftKey] = activation;
      pendingProfileRef.current = { draftKey, profileId };
      handleProfileActivated();
      const runActivation = queueRef.current.then(() => activate(profileId));
      queueRef.current = runActivation.then(
        () => {
          activation.pending -= 1;
          pendingCountRef.current -= 1;
          activation.hadSuccess = true;
          if (activation.pending === 0) {
            delete activationStateRef.current[draftKey];
          }
        },
        () => {
          activation.pending -= 1;
          pendingCountRef.current -= 1;
          addToast({
            message: 'Could not switch model profile.',
            type: 'error',
          });
          if (activation.pending === 0) {
            delete activationStateRef.current[draftKey];
            const currentDraft =
              useNewTaskDraftStore.getState().drafts[draftKey];
            // Preserve a newer manual model choice made while activation ran.
            if (
              !activation.hadSuccess &&
              currentDraft?.agentBackend === undefined &&
              currentDraft?.modelPreference === undefined &&
              currentDraft?.thinkingEffort === undefined &&
              currentDraft?.backendModelPresetId === null &&
              currentDraft?.shouldAutoSelectBackendModelPreset === false
            ) {
              updateDraft({
                agentBackend: activation.previousDraft?.agentBackend,
                modelPreference: activation.previousDraft?.modelPreference,
                thinkingEffort: activation.previousDraft?.thinkingEffort,
                backendModelPresetId:
                  activation.previousDraft?.backendModelPresetId,
                shouldAutoSelectBackendModelPreset:
                  activation.previousDraft?.shouldAutoSelectBackendModelPreset,
              });
              if (
                useNewTaskDraftStore.getState().selectedProjectId ===
                (draftKey === 'all' ? null : draftKey)
              ) {
                userTouchedSelectionRef.current = activation.wasTouched;
              }
            }
          }
          if (
            pendingProfileRef.current?.draftKey === draftKey &&
            pendingProfileRef.current.profileId === profileId
          ) {
            pendingProfileRef.current = null;
          }
        },
      );
    },
    [
      activate,
      addToast,
      draftKey,
      handleProfileActivated,
      updateDraft,
      userTouchedSelectionRef,
    ],
  );

  /**
   * A fast ⌘J, ⌘Enter sequence must wait for the selected profile to be
   * persisted before the task is submitted.
   */
  const waitForPendingActivations = useCallback(async () => {
    const wasPending = pendingCountRef.current > 0;
    if (wasPending) {
      await queueRef.current;
    }
    return wasPending;
  }, []);

  const clearPendingProfile = useCallback(() => {
    pendingProfileRef.current = null;
  }, []);

  return {
    selectProfile,
    pendingProfileRef,
    waitForPendingActivations,
    clearPendingProfile,
  };
}
