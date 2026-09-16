/**
 * Interactive shell sessions hosted in the project panel.
 *
 * Unlike run commands — which are one pty per configured command, torn down on
 * exit — a terminal session is long lived and keyed only by project. It
 * survives closing the pane and navigating away so shell history, the current
 * directory and any running foreground process are still there on reopen.
 */

/** Main → renderer: a chunk of pty output. */
export const TERMINAL_DATA_CHANNEL = 'project:terminal:data';
/** Main → renderer: the shell exited (user typed `exit`, or it crashed). */
export const TERMINAL_EXIT_CHANNEL = 'project:terminal:exit';

export type TerminalDataEvent = {
  sessionId: string;
  /** Raw pty output, escape sequences included. Feed straight to xterm. */
  data: string;
  /**
   * Index of this chunk's first character within the session's whole output
   * stream. Lets a client that just replayed a snapshot discard the chunks the
   * snapshot already covers instead of printing them twice.
   */
  offset: number;
};

export type TerminalExitEvent = {
  sessionId: string;
  exitCode: number;
};

export type TerminalSnapshot = {
  sessionId: string;
  /**
   * Replayed scrollback so a reopened pane is not blank. Bounded by
   * {@link TERMINAL_SCROLLBACK_LIMIT}; the oldest bytes are dropped first.
   */
  backlog: string;
  /**
   * Total characters the session had emitted when this snapshot was taken, i.e.
   * the stream offset one past the end of `backlog`. Any {@link
   * TerminalDataEvent} starting at or before this has already been replayed.
   */
  offset: number;
  /** False once the shell has exited but before the session is disposed. */
  isRunning: boolean;
  /** The dead shell's exit code; null while it is still running. */
  exitCode: number | null;
  /**
   * Set when the shell could not be started at all (a `cwd` that no longer
   * exists, a missing `$SHELL`). The pane shows this instead of sitting blank.
   */
  error?: string;
};

/**
 * How much output we retain per session for replay. A pty streaming a build log
 * would otherwise grow the main process heap without bound, since nothing
 * consumes the buffer until the pane is reopened.
 */
export const TERMINAL_SCROLLBACK_LIMIT = 256_000;

/**
 * Output is coalesced before crossing IPC. A shell echoing a large file emits
 * many tiny chunks, and one IPC message per chunk starves the renderer.
 */
export const TERMINAL_FLUSH_INTERVAL_MS = 16;
export const TERMINAL_FLUSH_BYTES = 8_192;

/**
 * Prefix a trimmed backlog carries: reset SGR attributes, then leave the
 * alternate screen. Trimming always resumes mid-stream, so whatever set
 * bold/colour/alt-screen before the cut is gone — without this a replay can
 * come back inverted, or painted into a screen it never entered.
 */
export const TERMINAL_REPLAY_RESET = '\x1b[0m\x1b[?1049l';

/** Terminal sessions are keyed by project, one per project. */
export function getProjectTerminalSessionId(projectId: string): string {
  return `project:${projectId}`;
}
