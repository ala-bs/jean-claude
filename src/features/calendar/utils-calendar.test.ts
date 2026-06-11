import { describe, expect, it } from 'vitest';

import type { UpcomingMeeting } from '@shared/calendar-types';

import { getTeamsJoinUrl, relativeLabel } from './utils-calendar';

function meetingIn(minutes: number): UpcomingMeeting {
  const now = new Date('2026-05-29T12:00:00.000Z').getTime();
  const startAt = new Date(now + minutes * 60_000).toISOString();
  const endAt = new Date(now + (minutes + 30) * 60_000).toISOString();

  return {
    id: 'meeting-1',
    externalId: 'external-1',
    title: 'Planning',
    startAt,
    endAt,
    location: '',
    calendarName: 'Work',
    notes: '',
    url: '',
  };
}

describe('relativeLabel', () => {
  const now = new Date('2026-05-29T12:00:00.000Z').getTime();

  it('formats multi-day future meetings in whole days', () => {
    expect(relativeLabel(meetingIn(58 * 60), now)).toBe('in 2d');
  });

  it('keeps sub-day future meetings in hours and minutes', () => {
    expect(relativeLabel(meetingIn(90), now)).toBe('in 1h30');
  });
});

describe('getTeamsJoinUrl', () => {
  it('keeps web URL by default', () => {
    const url = 'https://teams.microsoft.com/l/meetup-join/abc?context=xyz';

    expect(getTeamsJoinUrl(url, 'web')).toBe(url);
  });

  it('converts Teams web URL to app deep link', () => {
    expect(
      getTeamsJoinUrl(
        'https://teams.microsoft.com/l/meetup-join/abc?context=xyz',
        'app',
      ),
    ).toBe('msteams://teams.microsoft.com/l/meetup-join/abc?context=xyz');
  });

  it('does not convert non-Teams hosts', () => {
    const url = 'https://teams.evil.example/l/meetup-join/abc';

    expect(getTeamsJoinUrl(url, 'app')).toBe(url);
  });
});
