import { describe, expect, it, vi } from 'vitest';

import {
  STARTER_WORK_ITEM_TITLE_PARSER_SETTING,
  type WorkItemTitleParserSetting,
} from '@shared/work-item-title-parser-types';

vi.mock('../index', () => ({ db: {} }));

import {
  parseWorkItemTitleParser,
  serializeWorkItemTitleParser,
  serializeWorkItemTitleParserUpdate,
} from './projects';

describe('project work item title parser persistence', () => {
  it('serializes and parses a valid setting', () => {
    const serialized = serializeWorkItemTitleParser(
      STARTER_WORK_ITEM_TITLE_PARSER_SETTING,
    );

    expect(serialized).toBe(
      JSON.stringify(STARTER_WORK_ITEM_TITLE_PARSER_SETTING),
    );
    expect(parseWorkItemTitleParser(serialized)).toEqual(
      STARTER_WORK_ITEM_TITLE_PARSER_SETTING,
    );
  });

  it.each(['{', '{}', '{"version":2,"enabled":false,"rules":[]}'])(
    'falls back to null for malformed or invalid JSON: %s',
    (value) => {
      expect(parseWorkItemTitleParser(value)).toBeNull();
    },
  );

  it('rejects invalid non-null writes', () => {
    const invalid = {
      ...STARTER_WORK_ITEM_TITLE_PARSER_SETTING,
      version: 2,
    } as unknown as WorkItemTitleParserSetting;

    expect(() => serializeWorkItemTitleParser(invalid)).toThrow(
      'Invalid work item title parser setting',
    );
  });

  it('round trips null', () => {
    expect(serializeWorkItemTitleParser(null)).toBeNull();
    expect(parseWorkItemTitleParser(null)).toBeNull();
    expect(serializeWorkItemTitleParserUpdate(null)).toEqual({
      workItemTitleParser: null,
    });
  });

  it('omits undefined updates', () => {
    expect(serializeWorkItemTitleParserUpdate(undefined)).toEqual({});
  });
});
