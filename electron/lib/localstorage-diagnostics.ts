import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

import { app } from 'electron';

import { dbg } from './debug';

/**
 * On-disk breadcrumbs for diagnosing "Saved settings could not be read".
 *
 * The boot guard (`src/lib/local-storage-boot-guard.ts`) can tell that the
 * LevelDB bucket came up empty, but not *why*. The leading theory is LOCK
 * contention: a relaunch wins Electron's single-instance lock while the
 * outgoing process still holds `Local Storage/leveldb/LOCK`, so the new
 * renderer opens an empty store. Proving that needs facts from the *previous*
 * process, which by definition are gone from memory by the time the guard
 * fires — hence a file.
 *
 * Two files under `userData`:
 *
 *   lifecycle.json          last session's pid and phase timestamps (overwritten)
 *   localstorage-diag.log   append-only history, one line per boot / block
 *
 * Everything here is synchronous and best-effort: it runs on the quit path and
 * from `process.on('exit')`, where async work does not complete, and a
 * diagnostics failure must never affect the app.
 */

type LifecycleRecord = {
  pid: number;
  startedAt: string;
  quitStartedAt?: string;
  cleanupDoneAt?: string;
  exitedAt?: string;
};

const LIFECYCLE_FILE = 'lifecycle.json';
const LOG_FILE = 'localstorage-diag.log';
const MAX_LOG_BYTES = 512 * 1024;

let current: LifecycleRecord | null = null;
/** Read once at boot, before we overwrite the file with this session's record. */
let previous: LifecycleRecord | null = null;

function lifecyclePath(): string {
  return join(app.getPath('userData'), LIFECYCLE_FILE);
}

function logPath(): string {
  return join(app.getPath('userData'), LOG_FILE);
}

/** Appends one timestamped line, truncating the file if it has grown large. */
export function logLocalStorageDiagnostic(message: string): void {
  dbg.main('[ls-diag] %s', message);
  try {
    const path = logPath();
    if (existsSync(path) && statSync(path).size > MAX_LOG_BYTES) {
      writeFileSync(path, '');
    }
    appendFileSync(path, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Diagnostics must never break the app.
  }
}

function writeLifecycle(): void {
  if (!current) return;
  try {
    writeFileSync(lifecyclePath(), JSON.stringify(current));
  } catch {
    // Ignore.
  }
}

/** Whether a pid is still alive. Signal 0 checks existence without signalling. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readPrevious(): LifecycleRecord | null {
  try {
    const path = lifecyclePath();
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as LifecycleRecord;
  } catch {
    return null;
  }
}

function lockInfo(): string {
  const lock = join(app.getPath('userData'), 'Local Storage', 'leveldb', 'LOCK');
  if (!existsSync(lock)) return 'lock=absent';
  try {
    return `lock=present mtime=${statSync(lock).mtime.toISOString()}`;
  } catch {
    return 'lock=present mtime=unknown';
  }
}

/**
 * Records this session's start and reports what the previous session left
 * behind. Must run after `applyUserDataDirOverride()` and before the first
 * window loads, so the LOCK/bucket state described is the one the renderer
 * will actually meet.
 */
export function recordBootDiagnostics({
  bucketExists,
}: {
  bucketExists: boolean;
}): void {
  previous = readPrevious();
  current = { pid: process.pid, startedAt: new Date().toISOString() };
  writeLifecycle();

  const parts = [
    `BOOT pid=${process.pid}`,
    `bucket=${bucketExists ? 'present' : 'absent'}`,
    lockInfo(),
  ];

  if (!previous) {
    parts.push('prev=none');
  } else {
    const alive = isAlive(previous.pid);
    // The smoking gun: the previous process is *still running* while we boot,
    // so both processes want the same single-writer LevelDB.
    parts.push(`prev.pid=${previous.pid}`, `prev.alive=${alive}`);
    parts.push(`prev.quitStartedAt=${previous.quitStartedAt ?? 'never'}`);
    parts.push(`prev.exitedAt=${previous.exitedAt ?? 'never'}`);
    if (previous.exitedAt) {
      const gapMs = Date.now() - new Date(previous.exitedAt).getTime();
      parts.push(`gapSincePrevExitMs=${gapMs}`);
    } else {
      parts.push('prev.cleanExit=false');
    }
    if (previous.quitStartedAt && previous.exitedAt) {
      const shutdownMs =
        new Date(previous.exitedAt).getTime() -
        new Date(previous.quitStartedAt).getTime();
      parts.push(`prev.shutdownDurationMs=${shutdownMs}`);
    }
  }

  logLocalStorageDiagnostic(parts.join(' '));
}

export function recordQuitStarted(): void {
  if (!current) return;
  current.quitStartedAt = new Date().toISOString();
  writeLifecycle();
  logLocalStorageDiagnostic(`QUIT_START pid=${process.pid}`);
}

export function recordCleanupDone(): void {
  if (!current) return;
  current.cleanupDoneAt = new Date().toISOString();
  writeLifecycle();
  const startedAt = current.quitStartedAt;
  const ms = startedAt ? Date.now() - new Date(startedAt).getTime() : -1;
  logLocalStorageDiagnostic(
    `QUIT_CLEANUP_DONE pid=${process.pid} durationMs=${ms}`,
  );
}

/** Called from `process.on('exit')` — synchronous only. */
export function recordProcessExit(): void {
  if (!current) return;
  current.exitedAt = new Date().toISOString();
  writeLifecycle();
  const startedAt = current.quitStartedAt;
  const ms = startedAt ? Date.now() - new Date(startedAt).getTime() : -1;
  logLocalStorageDiagnostic(
    `EXIT pid=${process.pid} sinceQuitStartMs=${ms} ` +
      `graceful=${startedAt ? 'yes' : 'no'}`,
  );
}

/**
 * Called from the renderer when the boot guard blocks writes. Correlates the
 * failure with what the previous session left behind, so a single log line
 * answers "was another process holding the lock?".
 */
export function recordBootGuardBlocked(): void {
  const parts = [`GUARD_BLOCKED pid=${process.pid}`, lockInfo()];
  if (previous) {
    parts.push(
      `prev.pid=${previous.pid}`,
      `prev.aliveNow=${isAlive(previous.pid)}`,
      `prev.exitedAt=${previous.exitedAt ?? 'never'}`,
    );
  } else {
    parts.push('prev=none');
  }
  // Any other Electron process on this profile is a contender for the lock,
  // whether or not it is the one we recorded.
  logLocalStorageDiagnostic(parts.join(' '));
}

export function getLocalStorageDiagnosticsLogPath(): string {
  return logPath();
}
