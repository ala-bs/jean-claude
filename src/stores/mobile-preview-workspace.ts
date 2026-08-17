import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import {
  createMobilePreviewRuntimeKey,
  parseMobilePreviewRuntimeKey,
} from '@/lib/mobile-preview-runtime';

export type MobilePreviewWorkspaceState = {
  isOpen: boolean;
  selectedRuntimeKey: string | null;
  open: (runtimeKey?: string) => void;
  close: () => void;
  toggle: (runtimeKey?: string) => void;
  selectRuntime: (runtimeKey: string | null) => void;
  moveRuntimeSelection: (
    fromRuntimeKey: string,
    toRuntimeKey: string,
  ) => void;
};

function getValidRuntimeKey(value: unknown) {
  if (typeof value !== 'string') return null;
  const runtime = parseMobilePreviewRuntimeKey(value);
  return runtime ? createMobilePreviewRuntimeKey(runtime) : null;
}

export const selectMobilePreviewWorkspaceIsOpen = (
  state: MobilePreviewWorkspaceState,
) => state.isOpen;

export const selectMobilePreviewWorkspaceRuntimeKey = (
  state: MobilePreviewWorkspaceState,
) => state.selectedRuntimeKey;

export const useMobilePreviewWorkspaceStore =
  create<MobilePreviewWorkspaceState>()(
    persist(
      (set) => ({
        isOpen: false,
        selectedRuntimeKey: null,
        open: (runtimeKey) =>
          set((state) => {
            const selectedRuntimeKey = runtimeKey
              ? getValidRuntimeKey(runtimeKey)
              : state.selectedRuntimeKey;
            if (
              state.isOpen &&
              selectedRuntimeKey === state.selectedRuntimeKey
            ) {
              return state;
            }
            return { isOpen: true, selectedRuntimeKey };
          }),
        close: () => set((state) => (state.isOpen ? { isOpen: false } : state)),
        toggle: (runtimeKey) =>
          set((state) => {
            if (state.isOpen) return { isOpen: false };
            return {
              isOpen: true,
              selectedRuntimeKey: runtimeKey
                ? getValidRuntimeKey(runtimeKey)
                : state.selectedRuntimeKey,
            };
          }),
        selectRuntime: (runtimeKey) =>
          set((state) => {
            const selectedRuntimeKey = getValidRuntimeKey(runtimeKey);
            return selectedRuntimeKey === state.selectedRuntimeKey
              ? state
              : { selectedRuntimeKey };
          }),
        moveRuntimeSelection: (fromRuntimeKey, toRuntimeKey) =>
          set((state) => {
            const validFromRuntimeKey = getValidRuntimeKey(fromRuntimeKey);
            const validToRuntimeKey = getValidRuntimeKey(toRuntimeKey);
            if (
              !validFromRuntimeKey ||
              !validToRuntimeKey ||
              state.selectedRuntimeKey !== validFromRuntimeKey
            ) {
              return state;
            }
            return { selectedRuntimeKey: validToRuntimeKey };
          }),
      }),
      {
        name: 'mobile-preview-workspace',
        version: 1,
        partialize: (state) => ({
          selectedRuntimeKey: state.selectedRuntimeKey,
        }),
        merge: (persisted, current) => {
          const persistedState =
            persisted && typeof persisted === 'object'
              ? (persisted as { selectedRuntimeKey?: unknown })
              : null;
          return {
            ...current,
            isOpen: false,
            selectedRuntimeKey: getValidRuntimeKey(
              persistedState?.selectedRuntimeKey,
            ),
          };
        },
      },
    ),
  );
