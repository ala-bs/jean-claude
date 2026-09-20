import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useCallback } from 'react';

import type { MobilePlatform } from '../../shared/mobile-simulator-types';

export type MobileDevPaneDeviceSelection = {
  platform: MobilePlatform;
  deviceId: string;
  /** Cached for display so the pane can label the device before it lists. */
  deviceName: string;
};

/** Stable key for a device across platforms. */
export function makeMobileDevDeviceKey({
  platform,
  deviceId,
}: {
  platform: MobilePlatform;
  deviceId: string;
}): string {
  return `${platform}:${deviceId}`;
}

export type MobileDevPaneState = {
  /**
   * Device selection is per task: two tasks on the same project routinely target
   * different simulators, and the pane is scoped to a task.
   */
  deviceByTaskId: Record<string, MobileDevPaneDeviceSelection>;
  /** Which run command's logs are shown in the log tab strip, per task. */
  selectedLogTabByTaskId: Record<string, string>;
  /**
   * Starred devices, keyed by `platform:deviceId`. Global rather than per task:
   * the handful of simulators someone actually uses is a property of their
   * machine, not of whichever task is open.
   */
  favoriteDevices: Record<string, MobileDevPaneDeviceSelection>;
  selectDevice: (
    taskId: string,
    device: MobileDevPaneDeviceSelection | null,
  ) => void;
  setSelectedLogTab: (taskId: string, commandId: string) => void;
  toggleFavoriteDevice: (device: MobileDevPaneDeviceSelection) => void;
  clearTask: (taskId: string) => void;
};

/**
 * One entry per task the pane was ever used on would otherwise grow forever in
 * localStorage. Tasks are deleted without always notifying this store, so the
 * record is capped rather than relying on `clearTask`.
 */
const MAX_TASK_ENTRIES = 100;

/**
 * Favorites are a deliberate, manual list. The cap is a corrupt-payload
 * backstop, not an eviction policy anyone should hit by starring devices.
 */
const MAX_FAVORITE_ENTRIES = 50;

function capRecord<Value>(
  record: Record<string, Value>,
  max = MAX_TASK_ENTRIES,
) {
  const keys = Object.keys(record);
  if (keys.length <= max) return record;
  // Object key order is insertion order, so the oldest entries are first.
  return Object.fromEntries(
    keys.slice(keys.length - max).map((key) => [key, record[key] as Value]),
  );
}

function omitKey<Value>(record: Record<string, Value>, key: string) {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
}

function isValidDeviceSelection(
  value: unknown,
): value is MobileDevPaneDeviceSelection {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.platform === 'ios' || candidate.platform === 'android') &&
    typeof candidate.deviceId === 'string' &&
    candidate.deviceId.length > 0 &&
    typeof candidate.deviceName === 'string'
  );
}

function sanitizeDeviceRecord(value: unknown) {
  if (!value || typeof value !== 'object') return {};
  return Object.entries(value as Record<string, unknown>).reduce<
    Record<string, MobileDevPaneDeviceSelection>
  >((accumulator, [taskId, entry]) => {
    if (isValidDeviceSelection(entry)) accumulator[taskId] = entry;
    return accumulator;
  }, {});
}

function sanitizeStringRecord(value: unknown) {
  if (!value || typeof value !== 'object') return {};
  return Object.entries(value as Record<string, unknown>).reduce<
    Record<string, string>
  >((accumulator, [taskId, entry]) => {
    if (typeof entry === 'string' && entry.length > 0)
      accumulator[taskId] = entry;
    return accumulator;
  }, {});
}

/**
 * Rebuilds store state from whatever is in localStorage. Exported so the
 * sanitizers can be tested directly: they are the only guard against a corrupt
 * or stale persisted payload, and the persist middleware is inert under test.
 */
export function mergePersistedMobileDevPaneState(
  persisted: unknown,
  current: MobileDevPaneState,
): MobileDevPaneState {
  const stored = (
    persisted && typeof persisted === 'object' ? persisted : {}
  ) as Partial<MobileDevPaneState>;
  return {
    ...current,
    deviceByTaskId: sanitizeDeviceRecord(stored.deviceByTaskId),
    selectedLogTabByTaskId: capRecord(
      sanitizeStringRecord(stored.selectedLogTabByTaskId),
    ),
    // Drops entries whose key no longer matches their payload, so a renamed or
    // hand-edited key cannot produce a favorite that never matches a device.
    favoriteDevices: Object.fromEntries(
      Object.entries(sanitizeDeviceRecord(stored.favoriteDevices)).filter(
        ([key, device]) => key === makeMobileDevDeviceKey(device),
      ),
    ),
  };
}

/**
 * v1 stored a boolean `logsExpandedByTaskId`; the log tail is now a tab strip,
 * so the old record is dropped rather than translated. Exported for tests: the
 * persist middleware is inert under test.
 */
export function migrateMobileDevPaneState(persisted: unknown, version: number) {
  if (version >= 2 || !persisted || typeof persisted !== 'object') {
    return persisted as MobileDevPaneState;
  }
  const { logsExpandedByTaskId: _dropped, ...rest } = persisted as Record<
    string,
    unknown
  >;
  return {
    ...rest,
    selectedLogTabByTaskId: {},
  } as unknown as MobileDevPaneState;
}

export const useMobileDevPaneStore = create<MobileDevPaneState>()(
  persist(
    (set) => ({
      deviceByTaskId: {},
      selectedLogTabByTaskId: {},
      favoriteDevices: {},

      selectDevice: (taskId, device) =>
        set((state) => ({
          deviceByTaskId: device
            ? capRecord({
                // Re-insert the key so the most recently used task sorts last
                // and survives capping.
                ...omitKey(state.deviceByTaskId, taskId),
                [taskId]: device,
              })
            : omitKey(state.deviceByTaskId, taskId),
        })),

      setSelectedLogTab: (taskId, commandId) =>
        set((state) => ({
          selectedLogTabByTaskId: capRecord({
            // Re-insert the key so the most recently used task sorts last
            // and survives capping.
            ...omitKey(state.selectedLogTabByTaskId, taskId),
            [taskId]: commandId,
          }),
        })),

      toggleFavoriteDevice: (device) =>
        set((state) => {
          const key = makeMobileDevDeviceKey(device);
          if (state.favoriteDevices[key]) {
            return { favoriteDevices: omitKey(state.favoriteDevices, key) };
          }
          return {
            favoriteDevices: capRecord(
              { ...state.favoriteDevices, [key]: device },
              MAX_FAVORITE_ENTRIES,
            ),
          };
        }),

      clearTask: (taskId) =>
        set((state) => ({
          deviceByTaskId: omitKey(state.deviceByTaskId, taskId),
          selectedLogTabByTaskId: omitKey(state.selectedLogTabByTaskId, taskId),
        })),
    }),
    {
      name: 'mobile-dev-pane',
      version: 2,
      merge: mergePersistedMobileDevPaneState,
      partialize: (state) => ({
        deviceByTaskId: state.deviceByTaskId,
        selectedLogTabByTaskId: state.selectedLogTabByTaskId,
        favoriteDevices: state.favoriteDevices,
      }),
      migrate: migrateMobileDevPaneState,
    },
  ),
);

/**
 * Drops a task's pane state. Called from `clearTaskNavHistoryState`, the
 * established per-task cleanup hook, when a task is deleted.
 */
export function clearMobileDevPaneStateForTask(taskId: string) {
  useMobileDevPaneStore.getState().clearTask(taskId);
}

/**
 * Imperative log-tab setter for callers outside React (e.g. a command that
 * focuses a run's logs when it starts).
 */
export function setMobileDevPaneSelectedLogTab({
  taskId,
  commandId,
}: {
  taskId: string;
  commandId: string;
}) {
  useMobileDevPaneStore.getState().setSelectedLogTab(taskId, commandId);
}

/**
 * Favorites accessor. Returns the raw record (a stable reference) rather than a
 * derived array, so callers can memoize their own shaping without tripping the
 * unstable-selector re-render loop.
 */
export function useMobileDevPaneFavorites() {
  const favoriteDevices = useMobileDevPaneStore(
    (state) => state.favoriteDevices,
  );
  const toggleFavoriteDevice = useMobileDevPaneStore(
    (state) => state.toggleFavoriteDevice,
  );
  return { favoriteDevices, toggleFavoriteDevice };
}

/**
 * Task-bound accessor, following the repo's keyed-store convention so callers
 * never build a new object inside a selector.
 */
export function useMobileDevPaneTaskState(taskId: string) {
  const selectedDevice = useMobileDevPaneStore(
    (state) => state.deviceByTaskId[taskId] ?? null,
  );
  const selectedLogTab = useMobileDevPaneStore(
    (state) => state.selectedLogTabByTaskId[taskId] ?? null,
  );
  const selectDeviceAction = useMobileDevPaneStore(
    (state) => state.selectDevice,
  );
  const setSelectedLogTabAction = useMobileDevPaneStore(
    (state) => state.setSelectedLogTab,
  );

  const selectDevice = useCallback(
    (device: MobileDevPaneDeviceSelection | null) =>
      selectDeviceAction(taskId, device),
    [taskId, selectDeviceAction],
  );
  const setSelectedLogTab = useCallback(
    (commandId: string) => setSelectedLogTabAction(taskId, commandId),
    [taskId, setSelectedLogTabAction],
  );

  return { selectedDevice, selectedLogTab, selectDevice, setSelectedLogTab };
}
