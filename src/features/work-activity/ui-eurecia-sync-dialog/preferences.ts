import { useCallback, useState } from 'react';

const STORAGE_PREFIX = 'jean-claude:eurecia:';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(`${STORAGE_PREFIX}${key}`);
    return raw === null || raw === undefined ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write<T>(key: string, value: T) {
  try {
    globalThis.localStorage?.setItem(
      `${STORAGE_PREFIX}${key}`,
      JSON.stringify(value),
    );
  } catch {
    // Preferences are best-effort; a full or blocked storage must not break sync.
  }
}

/** State mirrored into localStorage so palette choices survive dialog reopens. */
export function usePersistedState<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => read(key, fallback));
  const update = useCallback(
    (next: T | ((current: T) => T)) => {
      setValue((current) => {
        const resolved =
          typeof next === 'function' ? (next as (value: T) => T)(current) : next;
        write(key, resolved);
        return resolved;
      });
    },
    [key],
  );
  return [value, update] as const;
}

export const PINNED_PROJECTS_KEY = 'pinned-projects';
/** Sub-axes adopted for a pinned project when Eurecia offered no choice. */
export const PINNED_SUB_AXES_KEY = 'pinned-project-sub-axes';
/** Axis id to label, so pinned projects stay readable on sheets that do not list them. */
export const AXIS_LABEL_CACHE_KEY = 'axis-label-cache';
export const MAX_CACHED_AXIS_LABELS = 2_000;
export const DEFAULT_ROLE_KEY = 'default-role';
export const PALETTE_WIDTH_KEY = 'palette-width';
export const RAIL_WIDTH_KEY = 'rail-width';
