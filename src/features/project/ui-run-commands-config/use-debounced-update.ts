import { useCallback, useEffect, useRef } from 'react';

const DEFAULT_DELAY = 500;

/**
 * Batches partial updates and persists them after `delay` ms of inactivity.
 *
 * Pending fields are merged, so typing in two inputs at once results in one save.
 * After a save is dispatched the field stays "unsettled" until the server echoes
 * the saved value back, which keeps a stale in-flight query result from
 * clobbering what the user is typing.
 */
export function useDebouncedUpdate<T extends object>(
  onUpdate: (data: T) => void,
  delay: number = DEFAULT_DELAY,
) {
  const onUpdateRef = useRef(onUpdate);

  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  // Edits waiting for the debounce timer.
  const pendingRef = useRef<Partial<T>>({});
  // Edits already sent, waiting for the server value to catch up.
  const inFlightRef = useRef<Partial<T>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);

  const flush = useCallback(() => {
    clearTimer();
    const pending = pendingRef.current;
    pendingRef.current = {};
    if (Object.keys(pending).length === 0) return;
    inFlightRef.current = { ...inFlightRef.current, ...pending };
    onUpdateRef.current(pending as T);
  }, [clearTimer]);

  const schedule = useCallback(
    (data: Partial<T>) => {
      pendingRef.current = { ...pendingRef.current, ...data };
      clearTimer();
      timerRef.current = setTimeout(flush, delay);
    },
    [clearTimer, delay, flush],
  );

  /** Drop a buffered edit (value went back to what the server already has). */
  const discard = useCallback(
    (key: keyof T) => {
      if (key in pendingRef.current) {
        const { [key]: _dropped, ...rest } = pendingRef.current;
        pendingRef.current = rest as Partial<T>;
      }
      if (Object.keys(pendingRef.current).length === 0) clearTimer();
    },
    [clearTimer],
  );

  /** Drop everything without saving (e.g. the row is being deleted). */
  const cancel = useCallback(() => {
    clearTimer();
    pendingRef.current = {};
    inFlightRef.current = {};
  }, [clearTimer]);

  /**
   * True while the local value for `key` is newer than the server's.
   * Pass the current server value so a settled field stops being guarded.
   */
  const hasPending = useCallback(<K extends keyof T>(key: K, serverValue: T[K]) => {
    if (key in pendingRef.current) return true;
    if (!(key in inFlightRef.current)) return false;
    if (inFlightRef.current[key] === serverValue) {
      const { [key]: _settled, ...rest } = inFlightRef.current;
      inFlightRef.current = rest as Partial<T>;
      return false;
    }
    return true;
  }, []);

  // Persist whatever is still pending when the row goes away (navigation, close).
  useEffect(() => flush, [flush]);

  return { schedule, flush, discard, cancel, hasPending };
}
