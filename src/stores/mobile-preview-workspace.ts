import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import {
  createMobilePreviewRuntimeKey,
  parseMobilePreviewRuntimeKey,
} from '@/lib/mobile-preview-runtime';

import type { MobilePreviewPaneTab } from '@/features/task/ui-task-panel/mobile-preview-pane/utils-tabs';

export type MobilePreviewWorkspaceState = {
  isOpen: boolean;
  selectedRuntimeKey: string | null;
  /**
   * Pane tab and DevTools target, keyed by the pane's DevTools view id. The
   * embedded DevTools view now survives the pane closing, so this selection has
   * to survive with it — otherwise reopening lands on Setup and silently
   * detaches from the target whose console/network history was preserved.
   */
  paneTabByViewId: Record<string, MobilePreviewPaneTab>;
  devToolsTargetIdByViewId: Record<string, string>;
  open: (runtimeKey?: string) => void;
  close: () => void;
  toggle: (runtimeKey?: string) => void;
  selectRuntime: (runtimeKey: string | null) => void;
  moveRuntimeSelection: (
    fromRuntimeKey: string,
    toRuntimeKey: string,
  ) => void;
  setPaneTab: (viewId: string, tab: MobilePreviewPaneTab) => void;
  setDevToolsTargetId: (viewId: string, targetId: string) => void;
  clearPaneUiState: (viewId: string) => void;
};

const PANE_TABS: MobilePreviewPaneTab[] = [
  'setup',
  'dev-server',
  'logs',
  'devtools',
];

function getValidPaneTab(value: unknown): MobilePreviewPaneTab | null {
  return PANE_TABS.includes(value as MobilePreviewPaneTab)
    ? (value as MobilePreviewPaneTab)
    : null;
}

/**
 * Pane UI state is keyed by DevTools view id (task + platform + device), so it
 * would otherwise accumulate one permanent localStorage entry per device the
 * user ever previewed. Entries are dropped when their view is disposed, but
 * this bounds the record even if a disposal path is ever missed.
 */
const MAX_PANE_UI_ENTRIES = 50;

function capRecord<Value>(record: Record<string, Value>) {
  const keys = Object.keys(record);
  if (keys.length <= MAX_PANE_UI_ENTRIES) return record;
  // Object key order is insertion order, so the oldest entries are first.
  return Object.fromEntries(
    keys.slice(keys.length - MAX_PANE_UI_ENTRIES).map((key) => [
      key,
      record[key] as Value,
    ]),
  );
}

function sanitizeStringRecord<Value>(
  value: unknown,
  validate: (entry: unknown) => Value | null,
): Record<string, Value> {
  if (!value || typeof value !== 'object') return {};
  return Object.entries(value as Record<string, unknown>).reduce<
    Record<string, Value>
  >((accumulator, [key, entry]) => {
    const validated = validate(entry);
    if (validated !== null) accumulator[key] = validated;
    return accumulator;
  }, {});
}

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
        paneTabByViewId: {},
        devToolsTargetIdByViewId: {},
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
        setPaneTab: (viewId, tab) =>
          set((state) =>
            state.paneTabByViewId[viewId] === tab
              ? state
              : {
                  paneTabByViewId: capRecord({
                    ...state.paneTabByViewId,
                    [viewId]: tab,
                  }),
                },
          ),
        setDevToolsTargetId: (viewId, targetId) =>
          set((state) =>
            state.devToolsTargetIdByViewId[viewId] === targetId
              ? state
              : {
                  devToolsTargetIdByViewId: capRecord({
                    ...state.devToolsTargetIdByViewId,
                    [viewId]: targetId,
                  }),
                },
          ),
        clearPaneUiState: (viewId) =>
          set((state) => {
            if (
              !(viewId in state.paneTabByViewId) &&
              !(viewId in state.devToolsTargetIdByViewId)
            ) {
              return state;
            }
            const paneTabByViewId = { ...state.paneTabByViewId };
            const devToolsTargetIdByViewId = {
              ...state.devToolsTargetIdByViewId,
            };
            delete paneTabByViewId[viewId];
            delete devToolsTargetIdByViewId[viewId];
            return { paneTabByViewId, devToolsTargetIdByViewId };
          }),
      }),
      {
        name: 'mobile-preview-workspace',
        version: 2,
        // v1 payloads only lacked the new pane-UI records, which `merge`
        // defaults to empty. Without this, zustand drops the whole persisted
        // state on the version bump and loses the selected runtime key.
        migrate: (persisted) => persisted as MobilePreviewWorkspaceState,
        partialize: (state) => ({
          selectedRuntimeKey: state.selectedRuntimeKey,
          paneTabByViewId: state.paneTabByViewId,
          devToolsTargetIdByViewId: state.devToolsTargetIdByViewId,
        }),
        merge: (persisted, current) => {
          const persistedState =
            persisted && typeof persisted === 'object'
              ? (persisted as {
                  selectedRuntimeKey?: unknown;
                  paneTabByViewId?: unknown;
                  devToolsTargetIdByViewId?: unknown;
                })
              : null;
          return {
            ...current,
            isOpen: false,
            selectedRuntimeKey: getValidRuntimeKey(
              persistedState?.selectedRuntimeKey,
            ),
            paneTabByViewId: sanitizeStringRecord(
              persistedState?.paneTabByViewId,
              getValidPaneTab,
            ),
            devToolsTargetIdByViewId: sanitizeStringRecord(
              persistedState?.devToolsTargetIdByViewId,
              (entry) => (typeof entry === 'string' ? entry : null),
            ),
          };
        },
      },
    ),
  );
