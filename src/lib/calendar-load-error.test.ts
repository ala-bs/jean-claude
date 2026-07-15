import { beforeEach, describe, expect, it } from 'vitest';

import {
  beginCalendarLoad,
  markCalendarLoadSucceeded,
  shouldNotifyCalendarLoadError,
} from './calendar-load-error';

const ACCESS_DENIED_ERROR = new Error(
  "Error invoking remote method 'calendar:listUpcomingMeetings': Error: Calendar access not granted. Enable it in System Settings > Privacy & Security > Calendars.",
);

describe('shouldNotifyCalendarLoadError', () => {
  beforeEach(() => markCalendarLoadSucceeded(beginCalendarLoad()));

  it('notifies once while calendar access remains denied', () => {
    expect(
      shouldNotifyCalendarLoadError(ACCESS_DENIED_ERROR, beginCalendarLoad()),
    ).toBe(true);
    expect(
      shouldNotifyCalendarLoadError(ACCESS_DENIED_ERROR, beginCalendarLoad()),
    ).toBe(false);
  });

  it('notifies again after a successful calendar load', () => {
    expect(
      shouldNotifyCalendarLoadError(ACCESS_DENIED_ERROR, beginCalendarLoad()),
    ).toBe(true);

    markCalendarLoadSucceeded(beginCalendarLoad());

    expect(
      shouldNotifyCalendarLoadError(ACCESS_DENIED_ERROR, beginCalendarLoad()),
    ).toBe(true);
  });

  it('ignores stale success after a newer access denial', () => {
    const staleSuccess = beginCalendarLoad();
    const denied = beginCalendarLoad();

    expect(shouldNotifyCalendarLoadError(ACCESS_DENIED_ERROR, denied)).toBe(true);
    markCalendarLoadSucceeded(staleSuccess);

    expect(
      shouldNotifyCalendarLoadError(ACCESS_DENIED_ERROR, beginCalendarLoad()),
    ).toBe(false);
  });

  it('does not suppress other calendar errors', () => {
    const error = new Error('Calendar process timed out');

    expect(shouldNotifyCalendarLoadError(error, beginCalendarLoad())).toBe(true);
    expect(shouldNotifyCalendarLoadError(error, beginCalendarLoad())).toBe(true);
  });
});
