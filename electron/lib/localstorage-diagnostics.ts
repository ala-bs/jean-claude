import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

import { app } from 'electron';

import { dbg } from './debug';

/**
 * On-disk breadcrumbs for diagnosing "Saved settings could not be read".
 *
 * The boot guard (`src/lib/local-storage-boot-guard.ts`) can tell that the
 * LevelDB bucket came up empty, but not *why*. The theory is LOCK contention:
 * two processes overlap on one profile, and since `Local Storage/leveldb`
 * admits a single writer, the loser opens an empty store. Proving that needs
 * facts from the *other* process, which are gone from memory by the time the
 * guard fires — hence a file.
 *
 * The prime suspect is the reload-preview restart handoff, whose own doc
 * comment already names this as a known residual gap
 * (`reload-preview-service.ts`): it releases the single-instance lock and waits
 * for the replacement to finish booting *before* exiting the outgoing process,
 * so both are alive at once and only the LevelDB LOCK still separates them.
 * Note this means an affected process is the single-instance-lock **winner** —
 * do not read a BOOT line as proof that no one else was running.
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

function leveldbDir(): string {
  return join(app.getPath('userData'), 'Local Storage', 'leveldb');
}

/**
 * Who actually holds `Local Storage/leveldb/LOCK`, by pid.
 *
 * The previous version of this stat'd the file and reported its mtime, which
 * was worse than useless: LevelDB creates LOCK once and then holds it with
 * `fcntl(F_SETLK)`, never writing to it. The mtime is therefore the profile's
 * *creation* date — a real log line read `lock=present mtime=2026-01-27` during
 * an August failure, which looks like evidence and is noise.
 *
 * `lsof` answers the question that actually matters ("is another process
 * holding it, and which?"), and names a contender that `prev.pid` cannot see:
 * lifecycle.json only records the last session we ourselves wrote, so a
 * concurrent instance we did not spawn shows up as `prev=none`.
 *
 * Caveat for whoever reads the output: `lsof` reports processes with the file
 * *open*, which is not identical to holding the `fcntl` lock. LevelDB does
 * both, so in practice the distinction does not arise here — but a pid in this
 * list is evidence, not proof.
 *
 * Only called from the GUARD_BLOCKED path, never on a healthy boot: `lsof`
 * walks every process's fd table and measured ~143ms on a real profile, which
 * is not a cost worth paying on every launch for a line nobody reads.
 */
function lockInfo(): string {
  const lock = join(leveldbDir(), 'LOCK');
  if (!existsSync(lock)) return 'lock=absent';
  if (process.platform === 'win32') return 'lock=present holders=unsupported';

  // `spawnSync` rather than `execFileSync` so a non-zero exit is a value to
  // inspect rather than a throw: `lsof -t` exits 1 when *nothing* has the file
  // open, and that is the single most informative outcome here — it rules
  // contention out. Collapsing it into the same catch as "lsof is missing"
  // would throw away the answer.
  const result = spawnSync('lsof', ['-t', lock], {
    encoding: 'utf8',
    timeout: 2_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (result.error) {
    // Distinguish the two, since telling causes apart is this line's whole job:
    // a timeout means the answer exists and we gave up, a missing binary means
    // there was never going to be one.
    const timedOut =
      (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ||
      result.signal !== null;
    return `lock=present holders=unknown (lsof ${
      timedOut ? 'timed out' : 'unavailable'
    })`;
  }

  const pids = (result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const others = pids.filter((pid) => pid !== String(process.pid));
  if (others.length === 0) {
    return pids.length > 0
      ? 'lock=present holders=self-only'
      : 'lock=present holders=none';
  }
  return `lock=present holders=${others.join(',')}${
    pids.includes(String(process.pid)) ? ' (incl. self)' : ''
  }`;
}

/**
 * LevelDB's own log, which distinguishes the two failure modes the app-level
 * breadcrumbs cannot.
 *
 * `SanitizeOptions` (from the `DBImpl` constructor) rotates LOG to LOG.old and
 * creates a fresh LOG; `DBImpl::Recover` then calls `env_->LockFile()` and only
 * afterwards writes "Recovering log #N". Creation precedes locking, so an
 * **empty** LOG means the open never got past its first fallible step — the
 * file lock. That distinguishes "another process holds the bucket" from "the
 * bucket is corrupt", which the renderer cannot tell apart: `getItem` returns
 * `null` either way.
 *
 * Note the artifact is single-shot. A failed open still performs the rotation,
 * so a loser overwrites the *winner's* LOG with an empty one and pushes the
 * winner's history into LOG.old. Read it as "the most recent open attempt",
 * never as a running history.
 */
function leveldbLogTail(): string {
  try {
    const contents = readFileSync(join(leveldbDir(), 'LOG'), 'utf8').trim();
    if (!contents) {
      return 'leveldbLog=EMPTY (open never reached recovery — lock acquisition failed)';
    }
    const lines = contents.split('\n');
    return `leveldbLog=${JSON.stringify(lines.slice(-3).join(' | '))}`;
  } catch {
    return 'leveldbLog=unreadable';
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
    // Presence only, not `lockInfo()`: this runs before the first window on
    // every launch, and the `lsof` probe is too slow to belong on that path.
    // The holder question only matters once something has actually gone wrong,
    // and GUARD_BLOCKED asks it there.
    existsSync(join(leveldbDir(), 'LOCK')) ? 'lock=present' : 'lock=absent',
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
  const parts = [
    `GUARD_BLOCKED pid=${process.pid}`,
    lockInfo(),
    leveldbLogTail(),
  ];
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
