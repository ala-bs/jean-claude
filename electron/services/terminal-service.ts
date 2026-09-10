import * as nodePty from 'node-pty';

import {
  TERMINAL_FLUSH_BYTES,
  TERMINAL_FLUSH_INTERVAL_MS,
  TERMINAL_REPLAY_RESET,
  TERMINAL_SCROLLBACK_LIMIT,
  type TerminalSnapshot,
} from '@shared/terminal-types';
import { dbg } from '../lib/debug';
import { getChildProcessEnv } from '../lib/child-process-env';

type TerminalSession = {
  sessionId: string;
  pty: nodePty.IPty;
  cwd: string;
  cols: number;
  rows: number;
  /** Retained output for replay into a freshly mounted xterm. */
  backlog: string;
  /**
   * Total characters ever emitted, including those trimmed from the backlog.
   * Monotonic, so it can be used to align a replayed snapshot with the live
   * stream. Counted in JS string units, not bytes — node-pty hands us decoded
   * strings, and both ends of the protocol measure the same way.
   */
  totalChars: number;
  isRunning: boolean;
  exitCode: number | null;
  /** Coalesced output not yet sent to the renderer. */
  pending: string;
  /** Stream offset of `pending`'s first character. */
  pendingOffset: number;
  flushTimer: NodeJS.Timeout | null;
};

type DataListener = (event: {
  sessionId: string;
  data: string;
  offset: number;
}) => void;
type ExitListener = (event: { sessionId: string; exitCode: number }) => void;

/**
 * Owns the long-lived interactive shells shown in the project panel.
 *
 * One pty per session id; `ensureSession` is idempotent so remounting the pane
 * reattaches to the running shell instead of spawning a second one.
 */
class TerminalService {
  private sessions = new Map<string, TerminalSession>();
  private dataListeners = new Set<DataListener>();
  private exitListeners = new Set<ExitListener>();

  onData(listener: DataListener): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /**
   * Returns the existing session's scrollback, or spawns a shell if there is
   * none. `cwd` is only honoured on spawn: a live shell may have been `cd`-ed
   * elsewhere by the user, and yanking it back would be surprising.
   */
  ensureSession({
    sessionId,
    cwd,
    cols,
    rows,
  }: {
    sessionId: string;
    cwd: string;
    cols: number;
    rows: number;
  }): TerminalSnapshot {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      // The pane may have remounted at a different size while detached.
      this.resize({ sessionId, cols, rows });
      return {
        sessionId,
        backlog: existing.backlog,
        offset: existing.totalChars,
        isRunning: existing.isRunning,
        exitCode: existing.exitCode,
      };
    }

    const shell =
      process.platform === 'win32' ? 'cmd.exe' : process.env.SHELL || '/bin/sh';
    // Login+interactive so the user's rc files (aliases, prompt, nvm/rbenv
    // shims) are sourced. Without this the terminal has a different PATH than
    // the one the user sees in their own terminal, which is the single most
    // confusing way an embedded shell can differ.
    const shellArgs = process.platform === 'win32' ? [] : ['-l', '-i'];

    dbg.terminal('Spawning terminal session %s in %s (%s)', sessionId, cwd, shell);

    let pty: nodePty.IPty;
    try {
      pty = nodePty.spawn(shell, shellArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: getChildProcessEnv({
          overrides: {
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
          },
        }),
      });
    } catch (error) {
      // A project directory that has since been deleted or renamed is the
      // common case. Report it as a snapshot rather than rejecting the IPC
      // call, so the pane can show the reason instead of staying blank.
      const message = error instanceof Error ? error.message : String(error);
      dbg.terminal('Failed to spawn session %s: %s', sessionId, message);
      return {
        sessionId,
        backlog: '',
        offset: 0,
        isRunning: false,
        exitCode: null,
        error: message,
      };
    }

    const session: TerminalSession = {
      sessionId,
      pty,
      cwd,
      cols,
      rows,
      backlog: '',
      totalChars: 0,
      isRunning: true,
      exitCode: null,
      pending: '',
      pendingOffset: 0,
      flushTimer: null,
    };
    this.sessions.set(sessionId, session);

    // `kill()` is asynchronous, so a closed pty's handlers can still fire after
    // its session id has been reused by a replacement (exactly what the pane's
    // Restart button does). Without this guard the dead shell's output and exit
    // would be broadcast under the live session's id.
    const isCurrent = () => this.sessions.get(sessionId) === session;

    pty.onData((data) => {
      if (!isCurrent()) return;
      session.backlog = truncateBacklog(session.backlog + data);
      if (!session.pending) session.pendingOffset = session.totalChars;
      session.totalChars += data.length;
      session.pending += data;
      this.scheduleFlush(session);
    });

    pty.onExit(({ exitCode }) => {
      if (!isCurrent()) return;
      dbg.terminal(
        'Terminal session %s exited with code %d',
        sessionId,
        exitCode,
      );
      this.flush(session);
      session.isRunning = false;
      session.exitCode = exitCode;
      // The session object is kept so the pane can show the exit and offer a
      // restart; only `close` removes it from the map.
      this.exitListeners.forEach((listener) =>
        listener({ sessionId, exitCode }),
      );
    });

    return {
      sessionId,
      backlog: '',
      offset: 0,
      isRunning: true,
      exitCode: null,
    };
  }

  write({ sessionId, data }: { sessionId: string; data: string }): void {
    const session = this.sessions.get(sessionId);
    if (!session?.isRunning) return;
    session.pty.write(data);
  }

  resize({
    sessionId,
    cols,
    rows,
  }: {
    sessionId: string;
    cols: number;
    rows: number;
  }): void {
    const session = this.sessions.get(sessionId);
    if (!session?.isRunning) return;
    // node-pty throws on non-positive dimensions, which a hidden (display:none)
    // container measures as.
    if (cols < 1 || rows < 1) return;
    if (session.cols === cols && session.rows === rows) return;
    session.cols = cols;
    session.rows = rows;
    try {
      session.pty.resize(cols, rows);
    } catch (error) {
      dbg.terminal('Failed to resize session %s: %o', sessionId, error);
    }
  }

  /** Terminates the shell and forgets the session. */
  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    dbg.terminal('Closing terminal session %s', sessionId);
    this.clearFlushTimer(session);
    this.sessions.delete(sessionId);
    if (!session.isRunning) return;
    try {
      session.pty.kill();
    } catch (error) {
      dbg.terminal('Failed to kill session %s: %o', sessionId, error);
    }
  }

  /** Kills every shell. Called on app quit so no pty outlives the window. */
  closeAll(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.close(sessionId);
    }
  }

  private scheduleFlush(session: TerminalSession): void {
    if (session.pending.length >= TERMINAL_FLUSH_BYTES) {
      this.flush(session);
      return;
    }
    if (session.flushTimer) return;
    session.flushTimer = setTimeout(
      () => this.flush(session),
      TERMINAL_FLUSH_INTERVAL_MS,
    );
  }

  private flush(session: TerminalSession): void {
    this.clearFlushTimer(session);
    if (!session.pending) return;
    const data = session.pending;
    const offset = session.pendingOffset;
    session.pending = '';
    this.dataListeners.forEach((listener) =>
      listener({ sessionId: session.sessionId, data, offset }),
    );
  }

  private clearFlushTimer(session: TerminalSession): void {
    if (!session.flushTimer) return;
    clearTimeout(session.flushTimer);
    session.flushTimer = null;
  }
}

/**
 * Drops the oldest characters once the buffer exceeds the limit.
 *
 * Best effort, not exact: we prefer to resume just after a newline, since a cut
 * there cannot land inside an escape sequence. Output with no newline at all is
 * routine though — a full-screen TUI repaints with carriage returns and cursor
 * moves — so the fallback is an arbitrary cut, and the reset prefix is what
 * keeps that safe rather than the cut position.
 */
function truncateBacklog(backlog: string): string {
  if (backlog.length <= TERMINAL_SCROLLBACK_LIMIT) return backlog;
  const excess = backlog.length - TERMINAL_SCROLLBACK_LIMIT;
  const newlineIndex = backlog.indexOf('\n', excess);
  const body =
    newlineIndex === -1
      ? backlog.slice(excess + TERMINAL_REPLAY_RESET.length)
      : backlog.slice(newlineIndex + 1);
  return `${TERMINAL_REPLAY_RESET}${body}`;
}

export const terminalService = new TerminalService();
