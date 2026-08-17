import { describe, expect, it } from 'vitest';

import { validateWorkItemTitleParserDraft } from './utils-work-item-title-parser-settings';
import type { WorkItemTitleParserSetting } from '@shared/work-item-title-parser-types';

function setting({
  enabled,
  pattern,
}: {
  enabled: boolean;
  pattern: string;
}): WorkItemTitleParserSetting {
  return {
    version: 1,
    enabled: true,
    rules: [
      {
        id: 'rule-1',
        enabled,
        pattern,
        caseInsensitive: false,
      },
    ],
  };
}

describe('validateWorkItemTitleParserDraft', () => {
  it.each(['', '['])('accepts incomplete disabled pattern %j', (pattern) => {
    expect(
      validateWorkItemTitleParserDraft(setting({ enabled: false, pattern })),
    ).toMatchObject({ isValid: true });
  });

  it.each(['', '['])('rejects incomplete enabled pattern %j', (pattern) => {
    expect(
      validateWorkItemTitleParserDraft(setting({ enabled: true, pattern })),
    ).toMatchObject({ isValid: false });
  });

  it('keeps structural errors mapped to disabled rule positions', () => {
    const result = validateWorkItemTitleParserDraft({
      version: 1,
      enabled: false,
      rules: [
        { id: '', enabled: false, pattern: '', caseInsensitive: false },
        {
          id: 'duplicate',
          enabled: false,
          pattern: '',
          caseInsensitive: false,
        },
        {
          id: 'duplicate',
          enabled: false,
          pattern: '',
          caseInsensitive: false,
        },
        {
          id: 'long-pattern',
          enabled: false,
          pattern: 'x'.repeat(501),
          caseInsensitive: false,
        },
      ],
    });

    expect(result.isValid).toBe(false);
    expect([...result.ruleErrors]).toEqual([
      [0, 'Rule ID must be 1-100 characters.'],
      [2, 'Rule IDs must be unique.'],
      [3, 'Pattern must be 500 characters or fewer.'],
    ]);
  });
});
