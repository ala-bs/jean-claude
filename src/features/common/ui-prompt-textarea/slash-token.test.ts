import { describe, expect, it } from 'vitest';

import { getActiveSlashToken } from './index';

describe('getActiveSlashToken', () => {
  it('keeps slash autocomplete active until whitespace', () => {
    expect(getActiveSlashToken({ text: '/comp', cursorPosition: 5 })).toEqual({
      start: 0,
      end: 5,
      query: 'comp',
    });
  });

  it('leaves slash autocomplete mode after space', () => {
    expect(getActiveSlashToken({ text: '/compact now', cursorPosition: 10 })).toBe(
      null,
    );
  });

  it('opens slash autocomplete anywhere in input', () => {
    expect(
      getActiveSlashToken({ text: 'please use /init', cursorPosition: 16 }),
    ).toEqual({
      start: 11,
      end: 16,
      query: 'init',
    });
  });
});
