import { app, BrowserWindow, dialog } from 'electron';

/**
 * Shared gate for user-initiated quits (cmd+Q / menu Quit).
 *
 * There is more than one `before-quit` listener in this app (main.ts's cleanup
 * sequence, plus the mobile-preview cleanup registry), and Electron runs *all*
 * of them regardless of `preventDefault()` — vetoing a quit does not stop
 * propagation. Every listener that does destructive work must therefore consult
 * this gate before acting, or cancelling the dialog would still kill preview
 * sessions.
 *
 * The decision is memoised for the duration of one quit attempt: all listeners
 * for a single `before-quit` run in the same synchronous dispatch, so one
 * prompt covers them all.
 */

let skipNextConfirmation = false;
let decisionForCurrentEvent: boolean | null = null;

/**
 * Quits without prompting. For internal/programmatic quits (single-instance
 * lock, migration failure, window close on non-macOS) where the user has
 * already made the decision or there is nothing to save.
 */
export function quitWithoutConfirmation(): void {
  skipNextConfirmation = true;
  app.quit();
}

/** Returns true when the quit should proceed. */
export function confirmQuit(): boolean {
  if (decisionForCurrentEvent !== null) return decisionForCurrentEvent;

  const decision = computeDecision();
  decisionForCurrentEvent = decision;
  // Cleared on the next tick so a later quit attempt prompts again. Safe to
  // clear unconditionally: an accepted quit is guarded downstream by
  // `isQuittingAfterCleanup`, not by this cache.
  setTimeout(() => {
    decisionForCurrentEvent = null;
  }, 0);

  return decision;
}

function computeDecision(): boolean {
  // One-shot: consumed here so the flag can never latch on and silently
  // suppress every future prompt.
  if (skipNextConfirmation) {
    skipNextConfirmation = false;
    return true;
  }

  // Too early for a dialog (quit during startup) — a prompt here would be
  // un-dismissable.
  if (!app.isReady()) return true;

  const options = {
    type: 'question' as const,
    buttons: ['Quit', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Quit Jean-Claude?',
    detail: 'Running agents and commands will be stopped.',
  };

  // On macOS the app can legitimately be running with no windows while agents
  // work, so fall back to an app-modal dialog rather than skipping the prompt.
  const parent = BrowserWindow.getFocusedWindow();
  const choice = parent
    ? dialog.showMessageBoxSync(parent, options)
    : dialog.showMessageBoxSync(options);

  return choice === 0;
}
