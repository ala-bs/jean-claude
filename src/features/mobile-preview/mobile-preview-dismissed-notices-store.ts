/**
 * Tracks which mobile preview error notices the user dismissed.
 *
 * This lives at module scope on purpose, for the same reason as
 * `mobile-preview-expo-launch-store`: the mobile preview pane unmounts when the
 * workspace is closed and remounts when it is reopened (or when the runtime
 * `key` changes). Component-local dismissal state is destroyed by that unmount,
 * while the thing that *produces* the error — the Expo launch effect, the
 * retained main-process session — is not. The dismissed
 * banner therefore came straight back on reopen.
 *
 * Keys already encode the attempt identity (device, dev server pid, port,
 * retry counter, message), so a genuinely new failure produces a new key and
 * still surfaces. Only the exact notice the user dismissed stays hidden.
 */
const dismissedNoticeKeys = new Set<string>();

export function isNoticeDismissed(key: string | null): boolean {
  return key != null && dismissedNoticeKeys.has(key);
}

export function markNoticeDismissed(key: string | null): void {
  if (key != null) dismissedNoticeKeys.add(key);
}

export function clearDismissedNotice(key: string | null): void {
  if (key != null) dismissedNoticeKeys.delete(key);
}

export function clearAllDismissedNotices(): void {
  dismissedNoticeKeys.clear();
}
