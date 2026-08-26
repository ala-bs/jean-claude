import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useCallback } from 'react';


const EMPTY_FAVORITES: string[] = [];

interface BacklogOverlayDraftState {
  selectedProjectId?: string;
  drafts: Record<string, string>;
  favoriteProjectIds: string[];
  setSelectedProjectId: (projectId: string) => void;
  setDraft: (projectId: string, value: string) => void;
  clearDraft: (projectId: string) => void;
  toggleFavoriteProject: (projectId: string) => void;
}

const useStore = create<BacklogOverlayDraftState>()(
  persist(
    (set) => ({
      selectedProjectId: undefined,
      drafts: {},
      favoriteProjectIds: EMPTY_FAVORITES,

      setSelectedProjectId: (projectId) => {
        set({ selectedProjectId: projectId });
      },

      toggleFavoriteProject: (projectId) => {
        if (!projectId) return;
        set((state) => {
          const current = state.favoriteProjectIds ?? EMPTY_FAVORITES;
          return {
            favoriteProjectIds: current.includes(projectId)
              ? current.filter((id) => id !== projectId)
              : [...current, projectId],
          };
        });
      },

      setDraft: (projectId, value) => {
        set((state) => ({
          drafts: {
            ...state.drafts,
            [projectId]: value,
          },
        }));
      },

      clearDraft: (projectId) => {
        set((state) => {
          const { [projectId]: _, ...rest } = state.drafts;
          return { drafts: rest };
        });
      },
    }),
    { name: 'backlog-overlay-draft' },
  ),
);

export const useBacklogSelectedProjectId = () =>
  useStore((state) => state.selectedProjectId);

export const useSetBacklogSelectedProjectId = () =>
  useStore((state) => state.setSelectedProjectId);

export const useBacklogFavoriteProjectIds = () =>
  useStore((state) => state.favoriteProjectIds ?? EMPTY_FAVORITES);

export const useToggleBacklogFavoriteProject = () =>
  useStore((state) => state.toggleFavoriteProject);

export const getBacklogOverlayDraft =(projectId: string) =>
  useStore.getState().drafts[projectId] ?? '';

export const clearBacklogOverlayDraft = (projectId: string) => {
  useStore.getState().clearDraft(projectId);
};

export function useBacklogOverlayDraftStore(projectId: string) {
  const draft = useStore((state) => state.drafts[projectId] ?? '');
  const setDraftAction = useStore((state) => state.setDraft);
  const clearDraftAction = useStore((state) => state.clearDraft);

  const setDraft = useCallback(
    (value: string) => setDraftAction(projectId, value),
    [projectId, setDraftAction],
  );

  const clearDraft = useCallback(
    () => clearDraftAction(projectId),
    [projectId, clearDraftAction],
  );

  return { draft, setDraft, clearDraft };
}
