import { describe, expect, it } from 'vitest';

import {
  isWorkItemTitleParserSetting,
  STARTER_WORK_ITEM_TITLE_PARSER_SETTING,
  WORK_ITEM_TITLE_PARSER_MAX_MATCHES_PER_RULE,
  WORK_ITEM_TITLE_PARSER_MAX_PATTERN_LENGTH,
  WORK_ITEM_TITLE_PARSER_MAX_RULE_ID_LENGTH,
  WORK_ITEM_TITLE_PARSER_MAX_RULES,
  WORK_ITEM_TITLE_PARSER_MAX_TITLE_LENGTH,
  type WorkItemTitleParserRule,
  type WorkItemTitleParserSetting,
} from '@shared/work-item-title-parser-types';

import { parseWorkItemTitle } from './work-item-title-parser';

function setting(
  rules: WorkItemTitleParserRule[],
): WorkItemTitleParserSetting {
  return { version: 1, enabled: true, rules };
}

function rule(
  pattern: string,
  overrides: Partial<WorkItemTitleParserRule> = {},
): WorkItemTitleParserRule {
  return {
    id: 'rule-1',
    enabled: true,
    pattern,
    caseInsensitive: false,
    ...overrides,
  };
}

describe('work item title parser setting validation', () => {
  it('accepts starter setting', () => {
    expect(isWorkItemTitleParserSetting(STARTER_WORK_ITEM_TITLE_PARSER_SETTING)).toBe(
      true,
    );
    expect(STARTER_WORK_ITEM_TITLE_PARSER_SETTING.enabled).toBe(false);
    expect(STARTER_WORK_ITEM_TITLE_PARSER_SETTING.rules[0].enabled).toBe(false);
  });

  it.each([
    null,
    {},
    { version: 2, enabled: false, rules: [] },
    { version: 1, enabled: 'yes', rules: [] },
    { version: 1, enabled: false, rules: 'none' },
  ])('rejects malformed setting %#', (value) => {
    expect(isWorkItemTitleParserSetting(value)).toBe(false);
  });

  it('enforces rule count, ID, and pattern bounds', () => {
    expect(
      isWorkItemTitleParserSetting(
        setting(
          Array.from({ length: WORK_ITEM_TITLE_PARSER_MAX_RULES + 1 }, (_, index) =>
            rule('(?<label>x)', { id: String(index) }),
          ),
        ),
      ),
    ).toBe(false);
    expect(isWorkItemTitleParserSetting(setting([rule('(?<label>x)', { id: '' })]))).toBe(
      false,
    );
    expect(
      isWorkItemTitleParserSetting(
        setting([
          rule('(?<label>x)', {
            id: 'x'.repeat(WORK_ITEM_TITLE_PARSER_MAX_RULE_ID_LENGTH + 1),
          }),
        ]),
      ),
    ).toBe(false);
    expect(
      isWorkItemTitleParserSetting(
        setting([
          rule('x'.repeat(WORK_ITEM_TITLE_PARSER_MAX_PATTERN_LENGTH + 1)),
        ]),
      ),
    ).toBe(false);
  });

  it('rejects sparse rules arrays', () => {
    const rules = Array<WorkItemTitleParserRule>(1);
    expect(isWorkItemTitleParserSetting(setting(rules))).toBe(false);
  });

  it('rejects duplicate rule IDs', () => {
    expect(
      isWorkItemTitleParserSetting(
        setting([
          rule('(?<label>x)', { id: 'duplicate' }),
          rule('(?<label>y)', { id: 'duplicate' }),
        ]),
      ),
    ).toBe(false);
  });

  it('rejects enabled invalid regex and missing named label capture', () => {
    expect(isWorkItemTitleParserSetting(setting([rule('[')]))).toBe(false);
    expect(isWorkItemTitleParserSetting(setting([rule('(label)')]))).toBe(false);
    expect(isWorkItemTitleParserSetting(setting([rule('(?<other>label)')]))).toBe(
      false,
    );
  });

  it('allows a disabled incomplete rule for editing', () => {
    expect(
      isWorkItemTitleParserSetting(setting([rule('[', { enabled: false })])),
    ).toBe(true);
  });
});

describe('parseWorkItemTitle', () => {
  it('globally extracts labels and removes complete matches', () => {
    expect(
      parseWorkItemTitle({
        title: '[API] Build endpoint [Urgent]',
        setting: setting([rule(String.raw`\[(?<label>[^\]]+)\]\s*`)]),
      }),
    ).toEqual({
      displayTitle: 'Build endpoint',
      labels: ['API', 'Urgent'],
      matched: true,
    });
  });

  it('runs ordered rules against prior output', () => {
    expect(
      parseWorkItemTitle({
        title: '[Area: API] Ship fix',
        setting: setting([
          rule(String.raw`\[Area:\s*(?<label>[^\]]+)\]\s*`, { id: 'area' }),
          rule('(?<label>Ship)\\s*', { id: 'verb' }),
        ]),
      }),
    ).toEqual({ displayTitle: 'fix', labels: ['API', 'Ship'], matched: true });
  });

  it('honors case-insensitive matching and label deduplication', () => {
    expect(
      parseWorkItemTitle({
        title: '[API] [api] [Api] Work',
        setting: setting([
          rule(String.raw`\[(?<label>api)\]\s*`, { caseInsensitive: true }),
        ]),
      }),
    ).toEqual({ displayTitle: 'Work', labels: ['API'], matched: true });
  });

  it('trims labels and only outer display whitespace', () => {
    expect(
      parseWorkItemTitle({
        title: '  [  Platform  ] Build   the thing  ',
        setting: setting([rule(String.raw`\[(?<label>[^\]]+)\]`)]),
      }),
    ).toEqual({
      displayTitle: 'Build   the thing',
      labels: ['Platform'],
      matched: true,
    });
  });

  it.each([
    { setting: null, title: '[API] Work' },
    {
      setting: {
        version: 1,
        enabled: false,
        rules: [],
      } satisfies WorkItemTitleParserSetting,
      title: ' Work ',
    },
    { setting: setting([rule('(?<label>x)', { enabled: false })]), title: 'x Work' },
    { setting: setting([rule('(?<label>x)')]), title: 'Work' },
  ])('returns raw title when parser is inactive or unmatched %#', (input) => {
    expect(parseWorkItemTitle(input)).toEqual({
      displayTitle: input.title,
      labels: [],
      matched: false,
    });
  });

  it('uses Untitled when matches remove full title', () => {
    expect(
      parseWorkItemTitle({
        title: '[API]',
        setting: setting([rule(String.raw`\[(?<label>[^\]]+)\]`)]),
      }),
    ).toEqual({ displayTitle: 'Untitled', labels: ['API'], matched: true });
  });

  it('aborts to raw when a runtime capture is missing or empty', () => {
    const optionalCapture = setting([rule('(?:x(?<label>y)|z)')]);
    expect(parseWorkItemTitle({ title: 'z title', setting: optionalCapture })).toEqual({
      displayTitle: 'z title',
      labels: [],
      matched: false,
    });
    expect(
      parseWorkItemTitle({
        title: '[] title',
        setting: setting([rule(String.raw`\[(?<label>[^\]]*)\]`)]),
      }),
    ).toEqual({ displayTitle: '[] title', labels: [], matched: false });
  });

  it('aborts to raw on zero-length matches', () => {
    expect(
      parseWorkItemTitle({
        title: 'title',
        setting: setting([rule('(?<label>(?=t))')]),
      }),
    ).toEqual({ displayTitle: 'title', labels: [], matched: false });
  });

  it('falls back for oversized titles', () => {
    const title = 'x'.repeat(WORK_ITEM_TITLE_PARSER_MAX_TITLE_LENGTH + 1);
    expect(
      parseWorkItemTitle({ title, setting: setting([rule('(?<label>x)')]) }),
    ).toEqual({ displayTitle: title, labels: [], matched: false });
  });

  it('allows match limit and aborts when it is exceeded', () => {
    const parserSetting = setting([rule('(?<label>x)')]);
    const atLimit = 'x'.repeat(WORK_ITEM_TITLE_PARSER_MAX_MATCHES_PER_RULE);
    expect(parseWorkItemTitle({ title: atLimit, setting: parserSetting })).toEqual({
      displayTitle: 'Untitled',
      labels: ['x'],
      matched: true,
    });

    const overLimit = `${atLimit}x`;
    expect(parseWorkItemTitle({ title: overLimit, setting: parserSetting })).toEqual({
      displayTitle: overLimit,
      labels: [],
      matched: false,
    });
  });

  it('defensively rejects malformed runtime settings', () => {
    const malformed = setting([rule('(?<label>x)')]);
    malformed.rules[0].pattern = '[';
    expect(parseWorkItemTitle({ title: 'x', setting: malformed })).toEqual({
      displayTitle: 'x',
      labels: [],
      matched: false,
    });
  });
});
