import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';

import { app } from 'electron';

/**
 * Gives lock-skipping dev instances their own Chromium profile.
 *
 * `dev:tmp` and friends set `JC_SKIP_INSTANCE_LOCK=1` so several instances can
 * run side by side, and point `JEAN_CLAUDE_DB_PATH` at a throwaway SQLite file.
 * But that only isolates *our* database — `userData` was left alone, so every
 * instance still shared one Chromium profile with the packaged app, and
 * therefore one `Local Storage/leveldb` directory:
 *
 *     ~/Library/Application Support/jean-claude/Local Storage/leveldb/
 *      ├── LOCK                       <- one advisory lock, shared
 *      ├── _file://...                <- packaged app's keys
 *      └── _http://localhost:5173...  <- dev instance's keys
 *
 * That LevelDB admits one process at a time. The lock is not "stale" after a
 * crash — the kernel drops it when the holder dies — but two *live* processes
 * genuinely contend, and the loser opens an **empty** store. Every persisted
 * zustand store then rehydrates to defaults, which reads to the user as "none of
 * my settings survived the restart". Running `pnpm dev` next to the packaged app
 * is enough to trigger it.
 *
 * So: an instance that opts out of the single-instance lock also opts out of the
 * shared profile. Nothing changes for the packaged app, which keeps the default
 * path and is the only writer of it again.
 */

/** Explicit override, mostly for tests and one-off experiments. */
const USER_DATA_DIR_ENV = 'JC_USER_DATA_DIR';

export function resolveUserDataDir({
  defaultUserDataDir,
  explicitUserDataDir,
  skipInstanceLock,
  dbPath,
}: {
  defaultUserDataDir: string;
  explicitUserDataDir?: string;
  skipInstanceLock: boolean;
  dbPath?: string;
}): string {
  if (explicitUserDataDir) return explicitUserDataDir;

  // The packaged app, and any dev run that still takes the single-instance
  // lock, keep the default profile — nothing to isolate them from.
  if (!skipInstanceLock) return defaultUserDataDir;

  // Keyed off the database so an instance's Chromium state travels with its
  // data: `dev-tmp.sh` uses `<worktree>/db-tmp/jean-claude.db`, which is stable
  // across restarts (so dev keeps its localStorage) and distinct per worktree
  // (so two worktrees do not contend either).
  if (dbPath) return join(dirname(dbPath), 'chromium-user-data');

  // No database override to key off, so leave `userData` alone.
  //
  // Isolating it here would look safer than it is: `electron/database/index.ts`
  // derives the default SQLite path *from* `userData`, so moving the profile
  // would silently hand this instance a brand-new empty database — no projects,
  // no tasks, which reads exactly like the data loss this module exists to
  // prevent. No shipped script takes this path (both dev scripts set
  // `JEAN_CLAUDE_DB_PATH`), so the only reachable case is someone setting the
  // env var by hand, and for them a shared profile is far less alarming than an
  // apparently wiped app. Set `JC_USER_DATA_DIR` to isolate deliberately.
  return defaultUserDataDir;
}

/**
 * Must run before anything reads `userData`. `electron/database/index.ts`
 * resolves its default path at *module scope*, and module bodies run after their
 * imports, so this has to be a side-effect import ordered ahead of it rather
 * than a call from `main.ts`'s body — by then the database module has already
 * captured the old path.
 */
export function applyUserDataDirOverride(): void {
  const resolved = resolveUserDataDir({
    defaultUserDataDir: app.getPath('userData'),
    explicitUserDataDir: process.env[USER_DATA_DIR_ENV],
    skipInstanceLock: !!process.env.JC_SKIP_INSTANCE_LOCK,
    dbPath: process.env.JEAN_CLAUDE_DB_PATH,
  });

  if (resolved === app.getPath('userData')) return;

  // Electron's `setPath` rejects a directory that does not exist yet.
  mkdirSync(resolved, { recursive: true });
  app.setPath('userData', resolved);
}

/**
 * Whether this profile has ever had a localStorage bucket on disk.
 *
 * The renderer's boot guard cannot tell "first run" from "the bucket failed to
 * open" — `getItem` returns `null` either way — so it needs an answer from
 * outside the bucket. Chromium only creates `Local Storage/leveldb` once
 * something has been stored, so its absence is proof of a genuine first run for
 * this profile, and its presence means an empty read is suspicious.
 *
 * Must be sampled BEFORE the first window loads, since loading one creates the
 * directory. Note this is a per-*profile* question, not a per-user one: a fresh
 * dev worktree has projects (its SQLite is a copy) but no bucket yet, and would
 * otherwise look exactly like a failed read.
 */
export function hasExistingLocalStorageBucket(): boolean {
  return existsSync(join(app.getPath('userData'), 'Local Storage', 'leveldb'));
}

applyUserDataDirOverride();
