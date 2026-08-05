import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOARD_COLOR_SETTINGS,
  getBoardColumnApplyMode,
  getBoardColumnTone,
  getBoardTagTone,
  matchBoardTagRule,
  sanitizeBoardColorSettings,
} from './utils-board-colors';

const rules = [
  { id: '1', type: 'exact' as const, match: 'blocked', color: 'rose' as const },
  { id: '2', type: 'prefix' as const, match: 'sprint', color: 'grey' as const },
  {
    id: '3',
    type: 'contains' as const,
    match: 'bug',
    color: 'amber' as const,
    label: 'bugish',
  },
];

describe('board colors', () => {
  it('matches the first rule, case-insensitively', () => {
    expect(matchBoardTagRule('Blocked', rules)?.id).toBe('1');
    expect(matchBoardTagRule('sprint-12', rules)?.id).toBe('2');
    expect(matchBoardTagRule('true-bug', rules)?.id).toBe('3');
    expect(matchBoardTagRule('whatever', rules)).toBeNull();
  });

  it('ignores empty match patterns', () => {
    expect(matchBoardTagRule('anything', [
      { id: 'x', type: 'contains', match: '  ', color: 'violet' },
    ])).toBeNull();
  });

  it('treats grey rules as no signal', () => {
    expect(getBoardTagTone('sprint-12', rules)).toBeNull();
    expect(getBoardTagTone('true-bug', rules)?.label).toBe('bugish');
    expect(getBoardTagTone('Blocked', rules)?.label).toBe('Blocked');
  });

  it('falls back to built-in column colours and apply mode', () => {
    expect(getBoardColumnTone('Done', DEFAULT_BOARD_COLOR_SETTINGS)).toBe(
      'var(--color-status-done)',
    );
    expect(getBoardColumnApplyMode('Done', DEFAULT_BOARD_COLOR_SETTINGS)).toBe('both');
  });

  it('honours per-column overrides', () => {
    const settings = {
      ...DEFAULT_BOARD_COLOR_SETTINGS,
      columnColors: { done: 'violet' as const },
      columnApply: { done: 'none' as const },
    };
    expect(getBoardColumnTone('Done ', settings)).toBe('var(--color-acc)');
    expect(getBoardColumnApplyMode('DONE', settings)).toBe('none');
  });

  it('sanitizes missing, partial and malformed persisted settings', () => {
    expect(sanitizeBoardColorSettings(undefined)).toEqual(
      DEFAULT_BOARD_COLOR_SETTINGS,
    );
    expect(sanitizeBoardColorSettings({ apply: 'nope' }).apply).toBe('both');
    expect(sanitizeBoardColorSettings({ rules: 'oops' }).rules).toEqual(
      DEFAULT_BOARD_COLOR_SETTINGS.rules,
    );
    const sanitized = sanitizeBoardColorSettings({
      rules: [
        { id: 'a', type: 'exact', match: 'x', color: 'rose' },
        { id: 'b', type: 'bogus', match: 'y', color: 'rose' },
        { id: 'c', type: 'exact', match: 'z', color: 'chartreuse' },
      ],
      columnColors: { done: 'green', todo: 'nope' },
      columnApply: { done: 'tint', todo: 'nope' },
    });
    expect(sanitized.rules.map((rule) => rule.id)).toEqual(['a']);
    expect(sanitized.columnColors).toEqual({ done: 'green' });
    expect(sanitized.columnApply).toEqual({ done: 'tint' });
  });

  it('defaults showPriority to false unless persisted as a boolean', () => {
    expect(sanitizeBoardColorSettings(undefined).showPriority).toBe(false);
    expect(sanitizeBoardColorSettings({}).showPriority).toBe(false);
    expect(
      sanitizeBoardColorSettings({ showPriority: 'yes' }).showPriority,
    ).toBe(false);
    expect(sanitizeBoardColorSettings({ showPriority: true }).showPriority).toBe(
      true,
    );
  });
});
