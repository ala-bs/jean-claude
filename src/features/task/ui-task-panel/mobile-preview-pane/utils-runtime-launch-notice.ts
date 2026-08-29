/**
 * Visibility rules for the runtime-launch notice in the mobile preview pane.
 *
 * The notice is dismissable, but a dismissal must never hide a *later* failure.
 * Dismissals are therefore keyed by launch attempt + message: any input that
 * makes the launch hook try again (retry, device switch, dev server restart,
 * port change) produces a new attempt key, so the banner comes back even when
 * the failure message is identical.
 */
export type RuntimeLaunchNoticeStatus =
  | 'idle'
  | 'ready'
  | 'waiting'
  | 'launching'
  | 'unsupported'
  | 'error';

/** Terminal statuses: they never resolve on their own, so offer a dismiss. */
export function isRuntimeLaunchNoticeDismissable(
  status: RuntimeLaunchNoticeStatus,
): boolean {
  return status === 'error' || status === 'unsupported';
}

export function getRuntimeLaunchAttemptKey(
  parts: Array<string | number | null | undefined>,
): string {
  return parts.map((part) => part ?? '-').join('\0');
}

/** Identity of a dismissed notice: same launch attempt *and* same message. */
export function getRuntimeLaunchDismissKey({
  attemptKey,
  message,
}: {
  attemptKey: string;
  message: string;
}): string {
  return `${attemptKey}\0${message}`;
}

export function shouldShowRuntimeLaunchNotice({
  status,
  message,
  attemptKey,
  dismissedKey,
}: {
  status: RuntimeLaunchNoticeStatus;
  message: string;
  attemptKey: string;
  dismissedKey: string | null;
}): boolean {
  if (status === 'idle' || status === 'ready') return false;
  if (!isRuntimeLaunchNoticeDismissable(status)) return true;
  return dismissedKey !== getRuntimeLaunchDismissKey({ attemptKey, message });
}
