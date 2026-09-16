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
  /** Collapsed/expanded state of the inline log tail, per task. */
  logsExpandedByTaskId: Record<string, boolean>;
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
  setLogsExpanded: (taskId: string, expanded: boolean) => void;
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

function sanitizeBooleanRecord(value: unknown) {
  if (!value || typeof value !== 'object') return {};
  return Object.entries(value as Record<string, unknown>).reduce<
    Record<string, boolean>
  >((accumulator, [taskId, entry]) => {
    if (typeof entry === 'boolean') accumulator[taskId] = entry;
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
    logsExpandedByTaskId: sanitizeBooleanRecord(stored.logsExpandedByTaskId),
    // Drops entries whose key no longer matches their payload, so a renamed or
    // hand-edited key cannot produce a favorite that never matches a device.
    favoriteDevices: Object.fromEntries(
      Object.entries(sanitizeDeviceRecord(stored.favoriteDevices)).filter(
        ([key, device]) => key === makeMobileDevDeviceKey(device),
      ),
    ),
  };
}

export const useMobileDevPaneStore = create<MobileDevPaneState>()(
  persist(
    (set) => ({
      deviceByTaskId: {},
      logsExpandedByTaskId: {},
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

      setLogsExpanded: (taskId, expanded) =>
        set((state) => ({
          logsExpandedByTaskId: capRecord({
            ...omitKey(state.logsExpandedByTaskId, taskId),
            [taskId]: expanded,
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
          logsExpandedByTaskId: omitKey(state.logsExpandedByTaskId, taskId),
        })),
    }),
    {
      name: 'mobile-dev-pane',
      version: 1,
      merge: mergePersistedMobileDevPaneState,
      partialize: (state) => ({
        deviceByTaskId: state.deviceByTaskId,
        logsExpandedByTaskId: state.logsExpandedByTaskId,
        favoriteDevices: state.favoriteDevices,
      }),
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

const DEFAULT_LOGS_EXPANDED = true;

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
  const logsExpanded = useMobileDevPaneStore(
    (state) => state.logsExpandedByTaskId[taskId] ?? DEFAULT_LOGS_EXPANDED,
  );
  const selectDeviceAction = useMobileDevPaneStore(
    (state) => state.selectDevice,
  );
  const setLogsExpandedAction = useMobileDevPaneStore(
    (state) => state.setLogsExpanded,
  );

  const selectDevice = useCallback(
    (device: MobileDevPaneDeviceSelection | null) =>
      selectDeviceAction(taskId, device),
    [taskId, selectDeviceAction],
  );
  const setLogsExpanded = useCallback(
    (expanded: boolean) => setLogsExpandedAction(taskId, expanded),
    [taskId, setLogsExpandedAction],
  );

  return { selectedDevice, logsExpanded, selectDevice, setLogsExpanded };
}
