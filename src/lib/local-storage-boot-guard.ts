/**
 * Stops a *transient* localStorage read failure from becoming permanent loss.
 *
 * Chromium keeps localStorage in a LevelDB store under `Local Storage/leveldb`,
 * guarded by a `LOCK` file that admits one process at a time. That lock is
 * independent of Electron's single-instance lock, so a relaunch can win the app
 * lock while the outgoing process still holds `LOCK` — and a process that cannot
 * open the store comes up with an *empty* one. Every persisted store then
 * rehydrates to its defaults, and the first state change writes those defaults
 * back over data that was still intact on disk. A recoverable bad read turns
 * into an unrecoverable overwrite.
 *
 * The guard closes that window:
 *
 *   localStorage empty at boot?
 *     no  -> pass through, zero overhead, no behaviour change (the common case)
 *     yes -> hold every write in memory until we can tell which case this is:
 *              no projects in SQLite -> genuine first run  -> replay the writes
 *              projects in SQLite    -> the bucket failed  -> keep blocking
 *
 * SQLite is the signal because it is a wholly separate store from the LevelDB
 * bucket: when the bucket fails, the database still answers. A user with
 * projects cannot be on a first run, so an empty bucket alongside them is proof
 * of a failed read rather than a fresh profile.
 *
 * Deliberately fail-closed. If the check never resolves (IPC hangs), writes stay
 * queued: this session does not persist, which is recoverable on next launch —
 * unlike overwriting good data, which is not.
 */

const PREFIX = '[ls-guard]';

type GuardState =
  | 'pass-through' // Bucket looked healthy at boot, or a first run was confirmed.
  | 'suspect' // Empty at boot, still waiting to learn which case this is.
  | 'blocked'; // Empty at boot with prior data on record — the read failed.

let state: GuardState = 'pass-through';

/**
 * Writes withheld while `suspect`, newest-wins per key. Replayed in insertion
 * order if the first run is confirmed. A Map (not an array) so a store that
 * writes on every keystroke cannot grow this without bound.
 */
const withheldWrites = new Map<string, string>();

/** Keys whose deletion was withheld, replayed alongside `withheldWrites`. */
const withheldRemovals = new Set<string>();

let passThroughSetItem: ((key: string, value: string) => void) | null = null;
let passThroughRemoveItem: ((key: string) => void) | null = null;
let passThroughClear: (() => void) | null = null;
const listeners = new Set<(next: GuardState) => void>();

function notify() {
  for (const listener of listeners) listener(state);
}

export function getLocalStorageBootGuardState(): GuardState {
  return state;
}

export function subscribeLocalStorageBootGuard(
  listener: (next: GuardState) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Must run before any persisted store is imported — a zustand `persist` store
 * with sync storage hydrates during module evaluation, so a later install would
 * miss both the snapshot and the first writes.
 */
export function installLocalStorageBootGuard(): void {
  if (typeof window === 'undefined') return;

  // A non-empty bucket read fine. Never touch `setItem` in that case, so the
  // overwhelmingly common path keeps its exact current behaviour.
  if (window.localStorage.length > 0) return;

  state = 'suspect';

  // Define an *own* property on the `localStorage` instance.
  //
  // Two rejected alternatives, both verified against happy-dom rather than
  // assumed. Plain assignment (`localStorage.setItem = fn`) is unsafe because
  // `Storage` is a legacy platform object with a named-property setter, so on
  // some engines it stores a key literally called "setItem" instead of shadowing
  // the method — the hazard `debug-local-storage` documents and asserts against.
  // Patching `Storage.prototype` avoids that, but then localStorage and
  // sessionStorage share one function and have to be told apart by receiver —
  // and happy-dom passes a *different* receiver to `getItem` than to `setItem`
  // once the bucket has been cleared, so any such check silently fails open and
  // the guard never engages.
  //
  // `defineProperty` on the instance sidesteps both: it does not go through the
  // named-property setter, and it touches only this one object, so
  // `sessionStorage` — which holds the onboarding skip flags — is untouched by
  // construction rather than by a comparison that might be wrong.
  const realSetItem = window.localStorage.setItem.bind(window.localStorage);
  passThroughSetItem = realSetItem;

  const guardedSetItem = (key: string, value: string) => {
    if (state === 'pass-through') {
      realSetItem(key, value);
      return;
    }
    withheldWrites.set(key, value);
  };

  Object.defineProperty(window.localStorage, 'setItem', {
    value: guardedSetItem,
    configurable: true,
    writable: true,
  });

  // Deletions need the same treatment as writes. Guarding only `setItem` would
  // make the promise at the top of this file false: `main-renderer.tsx` and
  // `__root.tsx` both call `removeItem('react-scan-options')` unconditionally at
  // boot, so a destructive call would reach a bucket we are otherwise refusing
  // to touch. Withheld deletions are modelled as withheld writes of a tombstone
  // so ordering against `setItem` is preserved on replay.
  const realRemoveItem = window.localStorage.removeItem.bind(
    window.localStorage,
  );
  const realClear = window.localStorage.clear.bind(window.localStorage);

  Object.defineProperty(window.localStorage, 'removeItem', {
    value: (key: string) => {
      if (state === 'pass-through') {
        realRemoveItem(key);
        return;
      }
      withheldRemovals.add(key);
      withheldWrites.delete(key);
    },
    configurable: true,
    writable: true,
  });

  Object.defineProperty(window.localStorage, 'clear', {
    value: () => {
      if (state === 'pass-through') {
        realClear();
        return;
      }
      // Nothing was written yet, so there is nothing to clear — and a real
      // `clear()` here would be the single most destructive thing possible
      // against a bucket we cannot read.
      withheldWrites.clear();
    },
    configurable: true,
    writable: true,
  });

  passThroughRemoveItem = realRemoveItem;
  passThroughClear = realClear;

  // Verify rather than assume, for the same reason `debug-local-storage` does:
  // a guard that silently failed to install is worse than none, because it
  // reports protection it is not providing.
  if (window.localStorage.setItem !== guardedSetItem) {
    state = 'pass-through';
    passThroughSetItem = null;
    console.warn(
      `${PREFIX} could not patch localStorage.setItem on this engine — running unguarded`,
    );
    return;
  }

  console.warn(
    `${PREFIX} localStorage is empty at boot — holding writes until a first run is confirmed`,
  );
}

/**
 * Resolves the `suspect` state once the caller knows whether this profile has
 * used the app before. Safe to call repeatedly; only the first call decides.
 */
export function resolveLocalStorageBootGuard({
  hadPriorData,
}: {
  hadPriorData: boolean;
}): void {
  if (state !== 'suspect') return;

  if (hadPriorData) {
    state = 'blocked';
    console.error(
      `${PREFIX} localStorage came up EMPTY but this profile has existing projects — ` +
        `the LevelDB bucket failed to open (likely a stale 'Local Storage/leveldb/LOCK' ` +
        `from the previous process). Writes are blocked for this session so the on-disk ` +
        `data is not overwritten with defaults. Restart the app to recover.`,
    );
    notify();
    return;
  }

  state = 'pass-through';
  const write = passThroughSetItem;
  const remove = passThroughRemoveItem;
  for (const key of withheldRemovals) {
    try {
      remove?.(key);
    } catch (error) {
      console.error(`${PREFIX} replaying withheld removal failed`, key, error);
    }
  }
  if (write) {
    for (const [key, value] of withheldWrites) {
      try {
        write(key, value);
      } catch (error) {
        console.error(`${PREFIX} replaying withheld write failed`, key, error);
      }
    }
  }
  withheldWrites.clear();
  withheldRemovals.clear();
  notify();
}

/**
 * Test seam: restores module state and un-patches `setItem` between cases.
 *
 * Restores by redefining rather than `delete`-ing the own property: happy-dom's
 * `localStorage` is a proxy whose `deleteProperty` trap refuses, which throws.
 */
export function resetLocalStorageBootGuardForTests(): void {
  const restore = (name: string, value: unknown) => {
    if (!value) return;
    Object.defineProperty(window.localStorage, name, {
      value,
      configurable: true,
      writable: true,
    });
  };
  restore('setItem', passThroughSetItem);
  restore('removeItem', passThroughRemoveItem);
  restore('clear', passThroughClear);

  state = 'pass-through';
  withheldWrites.clear();
  withheldRemovals.clear();
  passThroughSetItem = null;
  passThroughRemoveItem = null;
  passThroughClear = null;
  listeners.clear();
}

// Installed at import time rather than from the entry point's body, for the same
// reason as `debug-local-storage`: ES module bodies run after all their imports,
// so a call site in `main-renderer.tsx` would land *after* the persisted stores
// have already hydrated and taken their first writes.
//
// Never under Vitest: the guard patches a module-global `localStorage` and would
// leak across every suite that transitively imports a persisted store.
//
// Wrapped, because a throw here would abort the entry chunk and blank the window.
// A guard that fails to install must degrade to today's behaviour, not to no app.
if (import.meta.env.MODE !== 'test') {
  try {
    installLocalStorageBootGuard();
  } catch (error) {
    console.warn(`${PREFIX} install failed, continuing unguarded`, error);
  }
}
