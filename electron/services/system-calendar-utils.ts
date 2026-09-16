const CALENDAR_FIELD_DELIMITER = String.fromCharCode(31);
const CALENDAR_RECORD_DELIMITER = String.fromCharCode(30);
const CALENDAR_ACCESS_DENIED_SIGNATURE =
  'Error Domain=JeanClaudeCalendar Code=1 "Calendar access not granted"';

export interface CalendarEventRecord {
  externalId: string;
  subject: string;
  startAt: string;
  endAt: string;
  startLabel: string;
  location: string;
  calendarName: string;
  organizer: string;
  organizerEmail: string;
  notes: string;
  url: string;
  recurring: boolean;
}

export function isCalendarAccessDeniedError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('stderr' in error)) {
    return false;
  }

  return (
    typeof error.stderr === 'string' &&
    error.stderr.includes(CALENDAR_ACCESS_DENIED_SIGNATURE)
  );
}

const XCODE_LICENSE_SIGNATURE = 'You have not agreed to the Xcode license';

export function isXcodeLicenseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const { stderr, message } = error as { stderr?: unknown; message?: unknown };
  return [stderr, message].some(
    (value) =>
      typeof value === 'string' && value.includes(XCODE_LICENSE_SIGNATURE),
  );
}

const MAX_CALENDAR_ERROR_LENGTH = 300;

/**
 * Turns a raw `execFile` failure from the Swift helper into a short, readable
 * message. Node puts the entire `xcrun swift -e <script>` command line into
 * `error.message`, which makes the unsanitized error unreadable in a toast.
 */
export function summarizeCalendarCommandError(
  error: unknown,
  script = '',
): string {
  const { stderr, message } = (error ?? {}) as {
    stderr?: unknown;
    message?: unknown;
  };

  const detail = [stderr, message]
    .map((value) => (typeof value === 'string' ? value : ''))
    .map((value) => {
      let cleaned = value.replace(/\s+/g, ' ').trim();
      const normalizedScript = script.replace(/\s+/g, ' ').trim();
      if (normalizedScript) {
        cleaned = cleaned.split(normalizedScript).join(' ');
      }
      return cleaned.replace(/^Command failed:\s*(xcrun swift -e)?/, '').trim();
    })
    .find((value) => value.length > 0);

  if (!detail) {
    return 'Could not read your calendar.';
  }

  const truncated =
    detail.length > MAX_CALENDAR_ERROR_LENGTH
      ? `${detail.slice(0, MAX_CALENDAR_ERROR_LENGTH).trimEnd()}…`
      : detail;

  return `Could not read your calendar: ${truncated}`;
}

export function parseCalendarEventRecords(
  rawOutput: string,
): CalendarEventRecord[] {
  if (!rawOutput.trim()) {
    return [];
  }

  return rawOutput
    .split(CALENDAR_RECORD_DELIMITER)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [
        externalId = '',
        subject = '',
        startAt = '',
        endAt = '',
        startLabel = '',
        location = '',
        calendarName = '',
        notes = '',
        url = '',
        recurring = 'false',
        organizer = '',
        organizerEmail = '',
      ] = record.split(CALENDAR_FIELD_DELIMITER);

      return {
        externalId,
        subject,
        startAt,
        endAt,
        startLabel,
        location,
        calendarName,
        organizer,
        organizerEmail,
        notes,
        url,
        recurring: recurring === 'true',
      };
    })
    .filter(
      (event) =>
        !!event.subject &&
        !!event.startAt &&
        !!event.endAt &&
        !!event.startLabel,
    );
}

export function buildCalendarNotificationKey(
  event: Pick<CalendarEventRecord, 'externalId' | 'startAt' | 'subject'>,
): string {
  const baseId = event.externalId || event.subject;
  return `${baseId}:${event.startAt}`;
}

export function shouldSuppressCalendarMeetingAlert({
  hasReceivedIgnoredMeetingIds,
  ignoredMeetingIds,
  notificationKey,
}: {
  hasReceivedIgnoredMeetingIds: boolean;
  ignoredMeetingIds: ReadonlySet<string>;
  notificationKey: string;
}): boolean {
  return (
    !hasReceivedIgnoredMeetingIds || ignoredMeetingIds.has(notificationKey)
  );
}

export function clampCalendarLeadTimeMinutes(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 1), 60);
}

export function isLikelyAllDayCalendarEvent(
  event: Pick<CalendarEventRecord, 'startAt' | 'endAt'>,
): boolean {
  const startAt = new Date(event.startAt);
  const endAt = new Date(event.endAt);

  if (
    Number.isNaN(startAt.getTime()) ||
    Number.isNaN(endAt.getTime()) ||
    endAt <= startAt
  ) {
    return false;
  }

  const durationMs = endAt.getTime() - startAt.getTime();
  const startsAtMidnight =
    startAt.getHours() === 0 &&
    startAt.getMinutes() === 0 &&
    startAt.getSeconds() === 0;

  return startsAtMidnight && durationMs >= 23 * 60 * 60 * 1000;
}

export { CALENDAR_FIELD_DELIMITER, CALENDAR_RECORD_DELIMITER };
