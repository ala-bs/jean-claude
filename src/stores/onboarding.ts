import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type OnboardingState = {
  hasSeenWelcome: boolean;
  setupWizardCompleted: boolean;
  setupWizardSkipped: boolean;
  setupBackendSelected: boolean;
  dismissedGuideIds: Record<string, number>;
  markWelcomeSeen: () => void;
  completeSetupWizard: () => void;
  skipSetupWizard: () => void;
  markSetupBackendSelected: () => void;
  dismissGuide: (id: string, version: number) => void;
  resetOnboarding: () => void;
};

export const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set) => ({
      hasSeenWelcome: false,
      setupWizardCompleted: false,
      setupWizardSkipped: false,
      setupBackendSelected: false,
      dismissedGuideIds: {},
      markWelcomeSeen: () => set({ hasSeenWelcome: true }),
      completeSetupWizard: () =>
        set({ hasSeenWelcome: true, setupWizardCompleted: true }),
      skipSetupWizard: () =>
        set({ hasSeenWelcome: true, setupWizardSkipped: true }),
      markSetupBackendSelected: () => set({ setupBackendSelected: true }),
      dismissGuide: (id, version) =>
        set((state) => ({
          dismissedGuideIds: {
            ...state.dismissedGuideIds,
            [id]: version,
          },
        })),
      resetOnboarding: () =>
        set({
          hasSeenWelcome: false,
          setupWizardCompleted: false,
          setupWizardSkipped: false,
          setupBackendSelected: false,
          dismissedGuideIds: {},
        }),
    }),
    {
      name: 'onboarding-store',
      partialize: (state) => ({
        hasSeenWelcome: state.hasSeenWelcome,
        setupWizardCompleted: state.setupWizardCompleted,
        setupWizardSkipped: state.setupWizardSkipped,
        setupBackendSelected: state.setupBackendSelected,
        dismissedGuideIds: state.dismissedGuideIds,
      }),
    },
  ),
);
