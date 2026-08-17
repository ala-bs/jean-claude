import { describe, expect, it } from 'vitest';

import {
  getPrStateColor,
  getPrStatusLabel,
  resolvePrStatus,
} from './feed-pr-state';

describe('getPrStateColor', () => {
  it.each([
    ['completed', false, true, true, 'var(--color-status-done)'],
    ['abandoned', false, true, true, 'var(--color-ink-4)'],
    ['active', false, true, true, 'var(--color-status-fail)'],
    ['active', false, false, true, 'var(--color-status-run)'],
    ['active', true, false, false, 'var(--color-ink-3)'],
    ['active', false, false, false, 'var(--color-status-azure)'],
  ] as const)(
    'maps %s PR state to %s',
    (status, isDraft, hasConflicts, hasOpenComments, expected) => {
      expect(
        getPrStateColor({
          status,
          isDraft,
          hasConflicts,
          hasOpenComments,
        }),
      ).toBe(expected);
    },
  );
});

describe('resolvePrStatus', () => {
  it('keeps fresh active feed status when cached status is abandoned', () => {
    expect(
      resolvePrStatus({ cachedStatus: 'abandoned', feedStatus: 'active' }),
    ).toBe('active');
  });

  it('uses cached status when feed has no status', () => {
    expect(
      resolvePrStatus({ cachedStatus: 'completed', feedStatus: undefined }),
    ).toBe('completed');
  });
});

describe('getPrStatusLabel', () => {
  it.each([
    ['active', 'open'],
    ['completed', 'merged'],
    ['abandoned', 'abandoned'],
  ] as const)('labels %s PR as %s', (status, label) => {
    expect(getPrStatusLabel(status)).toBe(label);
  });
});
