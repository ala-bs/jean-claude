const CALENDAR_ACCESS_DENIED_MESSAGE = 'Calendar access not granted.';

/**
 * Electron prefixes IPC failures with
 * `Error invoking remote method 'x': Error: `, which is noise in a toast.
 */
export function formatCalendarLoadError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(Error|UnhandledSchemeError):\s*/, '')
    .trim();
  return message || 'Could not read your calendar.';
}

let hasNotifiedCalendarAccessDenied = false;
let nextCalendarLoadId = 0;
let lastSettledCalendarLoadId = 0;

export function beginCalendarLoad(): number {
  nextCalendarLoadId += 1;
  return nextCalendarLoadId;
}

export function shouldNotifyCalendarLoadError(
  error: unknown,
  loadId: number,
): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes(CALENDAR_ACCESS_DENIED_MESSAGE)) {
    lastSettledCalendarLoadId = Math.max(lastSettledCalendarLoadId, loadId);
    return true;
  }

  if (loadId < lastSettledCalendarLoadId) {
    return false;
  }
  lastSettledCalendarLoadId = loadId;

  if (hasNotifiedCalendarAccessDenied) {
    return false;
  }

  hasNotifiedCalendarAccessDenied = true;
  return true;
}

export function markCalendarLoadSucceeded(loadId: number): void {
  if (loadId < lastSettledCalendarLoadId) {
    return;
  }
  lastSettledCalendarLoadId = loadId;
  hasNotifiedCalendarAccessDenied = false;
}
