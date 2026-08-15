import { describe, expect, it } from 'vitest';

import { getTeamsJoinUrl, isValidTeamsJoinUrl } from './teams-url';

describe('getTeamsJoinUrl', () => {
  const httpsUrl =
    'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%3a%22t%22%7d';

  it('keeps the https url when target is web', () => {
    expect(getTeamsJoinUrl(httpsUrl, 'web')).toBe(httpsUrl);
  });

  it('keeps the https url when target is undefined', () => {
    expect(getTeamsJoinUrl(httpsUrl, undefined)).toBe(httpsUrl);
  });

  it('rewrites to the msteams scheme when target is app', () => {
    const result = getTeamsJoinUrl(httpsUrl, 'app');

    expect(result).toBe(`msteams://${httpsUrl.slice('https://'.length)}`);
    expect(isValidTeamsJoinUrl(result)).toBe(true);
  });

  it.each([
    'https://teams.live.com/l/meetup-join/abc',
    'https://teams.cloud.microsoft/l/meetup-join/abc',
    'https://emea.teams.microsoft.com/l/meetup-join/abc',
  ])('rewrites every supported Teams host: %s', (url) => {
    const result = getTeamsJoinUrl(url, 'app');

    expect(result).toBe(`msteams://${url.slice('https://'.length)}`);
    expect(isValidTeamsJoinUrl(result)).toBe(true);
  });

  it('returns malformed input unchanged instead of throwing', () => {
    expect(getTeamsJoinUrl('not a url', 'app')).toBe('not a url');
  });

  it('leaves non-teams urls untouched', () => {
    expect(getTeamsJoinUrl('https://example.com/x', 'app')).toBe(
      'https://example.com/x',
    );
  });

  it('leaves already-msteams urls untouched', () => {
    const deep = 'msteams://teams.microsoft.com/l/meetup-join/abc';
    expect(getTeamsJoinUrl(deep, 'app')).toBe(deep);
  });
});
