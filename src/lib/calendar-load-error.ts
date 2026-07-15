const CALENDAR_ACCESS_DENIED_MESSAGE = 'Calendar access not granted.';

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
