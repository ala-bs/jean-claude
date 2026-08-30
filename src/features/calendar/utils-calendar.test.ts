import { describe, expect, it } from 'vitest';

import type { UpcomingMeeting } from '@shared/calendar-types';

import {
  blockDensity,
  blockHeight,
  getTeamsJoinUrl,
  nextTopByMeetingId,
  relativeLabel,
} from './utils-calendar';

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

describe('blockHeight', () => {
  it('never extends past the next block when bumped to minHeight', () => {
    // 15-min meeting at 56px/hour = 14px, below the 20px minimum
    const top = 112;
    const nextTop = 126;
    const h = blockHeight({ top, bottom: 126, nextTop, minHeight: 20 });

    expect(top + h).toBeLessThanOrEqual(nextTop);
    expect(h).toBe(12);
  });

  it('keeps a gap between back-to-back blocks', () => {
    const h = blockHeight({ top: 0, bottom: 56, nextTop: 56, minHeight: 20 });

    expect(h).toBe(54);
  });

  it('applies minHeight verbatim when there is room below', () => {
    expect(blockHeight({ top: 0, bottom: 8, minHeight: 20 })).toBe(20);
  });

  it('ignores a next block collapsed onto the same y', () => {
    // Two out-of-window meetings both clamp to y=0; neither should
    // shrink the other to an unreadable sliver.
    expect(blockHeight({ top: 0, bottom: 0, nextTop: 0, minHeight: 20 })).toBe(
      20,
    );
  });
});

describe('blockDensity', () => {
  it('uses micro text for slivers that cannot fit padded text', () => {
    expect(blockDensity(12)).toBe('micro');
  });

  it('uses compact text for half-hour-ish blocks', () => {
    expect(blockDensity(26)).toBe('compact');
  });

  it('uses regular text when there is room for a time line', () => {
    expect(blockDensity(56)).toBe('regular');
  });
});

describe('nextTopByMeetingId', () => {
  function block(id: string, startAt: string, col: number, totalCols: number) {
    return {
      meeting: { id, startAt } as unknown as UpcomingMeeting,
      col,
      totalCols,
    };
  }

  const toY = (s: string) => Number(s);

  it('clamps against a wider block from the next cluster', () => {
    // cluster A: two half-width blocks; cluster B: one full-width block
    const laid = [
      block('a', '0', 0, 2),
      block('b', '5', 1, 2),
      block('c', '20', 0, 1),
    ];

    const tops = nextTopByMeetingId(laid, toY);

    // 'b' is alone in col 1, but the full-width 'c' still overlaps it in x
    expect(tops.get('b')).toBe(20);
    expect(tops.get('a')).toBe(20);
    expect(tops.get('c')).toBeUndefined();
  });

  it('ignores blocks that never share horizontal space', () => {
    const laid = [block('a', '0', 0, 2), block('b', '10', 1, 2)];

    const tops = nextTopByMeetingId(laid, toY);

    expect(tops.get('a')).toBeUndefined();
  });

  it('ignores ties so equal-y blocks do not clamp each other', () => {
    const laid = [block('a', '0', 0, 1), block('b', '0', 0, 1)];

    const tops = nextTopByMeetingId(laid, toY);

    expect(tops.get('a')).toBeUndefined();
    expect(tops.get('b')).toBeUndefined();
  });

  it('picks the nearest following overlapping block', () => {
    const laid = [
      block('a', '0', 0, 1),
      block('far', '40', 0, 1),
      block('near', '20', 0, 1),
    ];

    expect(nextTopByMeetingId(laid, toY).get('a')).toBe(20);
  });
});
