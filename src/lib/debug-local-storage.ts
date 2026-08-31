/**
 * Guard rail for "persisted state disappears after restart".
 *
 * The `background-jobs` store once grew to 4.6MB of the ~5MB localStorage origin
 * quota. Zustand's persist middleware does not catch `setItem` failures, so the
 * QuotaExceededError escaped through whichever action triggered the write and the
 * data was simply never written — silently, from the user's point of view.
 *
 * Always on: a loud console error when a write fails, so the next offender is
 * obvious instead of mysterious. Rethrows, preserving existing behaviour.
 *
 * Verbose mode (dev builds, or `localStorage['jc:debug-ls'] = '1'` in a packaged
 * build followed by a reload) additionally reports per-key sizes at boot, keys
 * that shrink drastically, and every removeItem/clear with a stack.
 */

const PREFIX = '[ls-debug]';
const VERBOSE_KEY = 'jc:debug-ls';
const QUOTA_WARN_BYTES = 4_000_000;

/**
 * Keys that legitimately shrink and would otherwise spam the warning:
 * react-scan rewrites its own settings, and `background-jobs` now prunes itself
 * (including one large drop on the first launch after the quota fix).
 * Trade-off: a genuine `background-jobs` reset would go unreported here.
 */
const SHRINK_WARN_IGNORE = [/^react-scan/, /^background-jobs$/];

function byteSize(value: string): number {
  return value.length * 2; // UTF-16 code units, matching how browsers bill quota
}

function isVerbose(): boolean {
  // Never verbose under Vitest: `DEV` is true there, and the console.table plus
  // stack-carrying warnings would pollute any suite that imports this module.
  if (import.meta.env.MODE === 'test') return false;
  if (import.meta.env.DEV) return true;
  try {
    return localStorage.getItem(VERBOSE_KEY) === '1';
  } catch {
    return false;
  }
}

function snapshot(): { key: string; bytes: number }[] {
  const entries: { key: string; bytes: number }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    entries.push({ key, bytes: byteSize(localStorage.getItem(key) ?? '') });
  }
  return entries.sort((a, b) => b.bytes - a.bytes);
}

function logSnapshot(label: string): void {
  const entries = snapshot();
  const total = entries.reduce((sum, e) => sum + e.bytes, 0);
  console.log(
    `${PREFIX} ${label} origin=${window.location.origin} keys=${entries.length} total=${(total / 1024).toFixed(1)}KB`,
  );
  console.table(
    entries.map((e) => ({ key: e.key, KB: +(e.bytes / 1024).toFixed(1) })),
  );
  if (total > QUOTA_WARN_BYTES) {
    console.warn(
      `${PREFIX} localStorage usage ${(total / 1024 / 1024).toFixed(2)}MB is near the ~5MB quota — writes are about to start failing`,
    );
  }
}

function installLocalStorageDebug(): void {
  if (typeof window === 'undefined') return;
  const flags = window as unknown as {
    __lsDebug?: boolean;
    dumpLocalStorage?: () => void;
  };
  if (flags.__lsDebug) return;
  flags.__lsDebug = true;

  const verbose = isVerbose();
  const lastSize = new Map<string, number>();
  for (const e of snapshot()) lastSize.set(e.key, e.bytes);

  if (verbose) logSnapshot('boot');

  /**
   * Every persisted store coming up empty at once points at the bucket, not at
   * the stores. Two very different causes, so name the likely one per origin:
   * on `file://` (packaged / `pnpm preview`) the bucket is stable, so an empty
   * one means the last session's writes never reached disk — e.g. a hard
   * `app.exit()` that skipped Chromium's DOMStorage commit. On `http://` (dev)
   * the far more common cause is the dev server moving to another port, since
   * localStorage is keyed by origin.
   */
  if (lastSize.size === 0) {
    const cause =
      window.location.protocol === 'file:'
        ? 'first run, or the previous session exited before its writes were committed to disk'
        : 'first run, or the origin changed (dev server port moved) and previously persisted state lives under the old origin';
    console.warn(
      `${PREFIX} localStorage is empty at boot for origin=${window.location.origin} — ${cause}`,
    );
  }

  const rawSetItem = localStorage.setItem.bind(localStorage);
  const rawRemoveItem = localStorage.removeItem.bind(localStorage);
  const rawClear = localStorage.clear.bind(localStorage);

  /**
   * `Storage` is a legacy platform object with a named-property setter, so in
   * some engines `localStorage.setItem = fn` stores a *key* named "setItem"
   * instead of shadowing the method. Chromium (what Electron runs) shadows it
   * correctly, but verify rather than assume: a wrong guess here would either
   * write junk keys into the very storage this module protects, or make
   * `setItem` a string and break the whole app.
   */
  const assertShadowed = (name: 'setItem' | 'removeItem' | 'clear') => {
    if (typeof localStorage[name] === 'function' && !localStorage.getItem(name))
      return true;
    rawRemoveItem(name);
    console.warn(
      `${PREFIX} cannot patch localStorage.${name} on this engine — diagnostics disabled`,
    );
    return false;
  };

  localStorage.setItem = (key: string, value: string) => {
    const bytes = byteSize(value);
    const previous = lastSize.get(key);
    try {
      rawSetItem(key, value);
      lastSize.set(key, bytes);
      if (
        verbose &&
        previous !== undefined &&
        bytes < previous * 0.5 &&
        !SHRINK_WARN_IGNORE.some((pattern) => pattern.test(key))
      ) {
        // Never log the value itself — persisted stores can hold tokens.
        console.warn(
          `${PREFIX} key "${key}" shrank ${(previous / 1024).toFixed(1)}KB -> ${(bytes / 1024).toFixed(1)}KB (state reset / failed migration?)`,
          new Error('stack').stack,
        );
      }
    } catch (error) {
      // Use the cached sizes: the origin is already at its limit, so re-reading
      // every key here would allocate megabytes at the worst possible moment.
      const totals = [...lastSize.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([k, b]) => `${k}=${(b / 1024).toFixed(0)}KB`)
        .join(' ');
      console.error(
        `${PREFIX} WRITE FAILED key="${key}" bytes=${bytes} — this write is lost. Largest keys: ${totals}`,
        error,
      );
      throw error;
    }
  };
  if (!assertShadowed('setItem')) {
    localStorage.setItem = rawSetItem;
    return;
  }

  if (verbose) {
    localStorage.removeItem = (key: string) => {
      console.warn(`${PREFIX} removeItem("${key}")`, new Error('stack').stack);
      lastSize.delete(key);
      rawRemoveItem(key);
    };
    localStorage.clear = () => {
      console.warn(`${PREFIX} clear() called`, new Error('stack').stack);
      lastSize.clear();
      rawClear();
    };
    flags.dumpLocalStorage = () => logSnapshot('manual');
    console.log(
      `${PREFIX} verbose mode — run dumpLocalStorage() anytime; disable with localStorage.removeItem('${VERBOSE_KEY}')`,
    );
  } else {
    // Still tracked, without the noise: `lastSize` feeds the "largest keys"
    // line on a failed write, and would go stale if these bypassed the wrapper.
    localStorage.removeItem = (key: string) => {
      lastSize.delete(key);
      rawRemoveItem(key);
    };
    localStorage.clear = () => {
      lastSize.clear();
      rawClear();
    };
  }

  assertShadowed('removeItem');
  assertShadowed('clear');
}

// Installed at import time rather than from the entry point's body: ES module
// bodies run after all their imports, so a call site in `main-renderer.tsx`
// would land *after* the persisted stores have already hydrated.
//
// Wrapped: this is the first import of the renderer entry, so an unguarded throw
// (localStorage disabled by a session/partition change, SecurityError on access)
// would abort the whole entry chunk and produce a blank window. Diagnostics are
// never worth taking the app down.
try {
  installLocalStorageDebug();
} catch (error) {
  console.warn(`${PREFIX} install failed, continuing without diagnostics`, error);
}
