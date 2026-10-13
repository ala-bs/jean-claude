import { describe, expect, it } from 'vitest';

import {
  CORE_FIELD_METADATA,
  CORE_FIELD_REFNAMES,
  EDITABLE_FIELD_REFNAMES,
  FIELD_ACCEPTANCE_CRITERIA,
  FIELD_ASSIGNED_TO,
  FIELD_BOARD_COLUMN,
  FIELD_BOARD_COLUMN_DONE,
  FIELD_CHANGED_DATE,
  FIELD_DESCRIPTION,
  FIELD_ITERATION_PATH,
  FIELD_PRIORITY,
  FIELD_REPRO_STEPS,
  FIELD_STACK_RANK,
  FIELD_STATE,
  FIELD_STORY_POINTS,
  FIELD_TAGS,
  FIELD_TEAM_PROJECT,
  FIELD_TITLE,
  FIELD_WORK_ITEM_TYPE,
  formatAssignedToValue,
  getAcceptanceCriteriaHtml,
  getAssignee,
  getBoardColumn,
  getBoardColumnDone,
  getBooleanField,
  getChangedDate,
  getDescriptionHtml,
  getFieldValue,
  getIdentityField,
  getIterationPath,
  getNumberField,
  getPriority,
  getReproStepsHtml,
  getStackRank,
  getState,
  getStoryPoints,
  getStringField,
  getTags,
  getTeamProject,
  getTitle,
  getWorkItemType,
  normalizeFieldValue,
  type WorkItemFieldsHolder,
  type WorkItemFieldValue,
} from './work-item-field-types';

function item(
  fields: Record<string, WorkItemFieldValue> = {},
): WorkItemFieldsHolder {
  return { fields };
}

const EMPTY = item();

describe('normalizeFieldValue', () => {
  it('passes strings, numbers and booleans through unchanged', () => {
    expect(normalizeFieldValue('Active')).toBe('Active');
    expect(normalizeFieldValue('')).toBe('');
    expect(normalizeFieldValue(3)).toBe(3);
    expect(normalizeFieldValue(0)).toBe(0);
    expect(normalizeFieldValue(1.5)).toBe(1.5);
    expect(normalizeFieldValue(true)).toBe(true);
    expect(normalizeFieldValue(false)).toBe(false);
  });

  it('maps null and undefined to null', () => {
    expect(normalizeFieldValue(null)).toBeNull();
    expect(normalizeFieldValue(undefined)).toBeNull();
  });

  it('normalizes an identity object and keeps only known identity keys', () => {
    expect(
      normalizeFieldValue({
        displayName: 'Ada Lovelace',
        uniqueName: 'ada@example.com',
        imageUrl: 'https://example.com/ada.png',
        id: 'guid-1',
        descriptor: 'aad.xyz',
      }),
    ).toEqual({
      displayName: 'Ada Lovelace',
      uniqueName: 'ada@example.com',
      imageUrl: 'https://example.com/ada.png',
    });
  });

  it('omits optional identity keys that are absent or wrongly typed', () => {
    expect(normalizeFieldValue({ displayName: 'Ada' })).toEqual({
      displayName: 'Ada',
    });
    expect(
      normalizeFieldValue({ displayName: 'Ada', uniqueName: 42, imageUrl: null }),
    ).toEqual({ displayName: 'Ada' });
  });

  it('returns null for objects without a string displayName and for arrays', () => {
    expect(normalizeFieldValue({ uniqueName: 'ada@example.com' })).toBeNull();
    expect(normalizeFieldValue({ displayName: 42 })).toBeNull();
    expect(normalizeFieldValue([])).toBeNull();
    expect(normalizeFieldValue(['a'])).toBeNull();
  });
});

describe('getTags', () => {
  it('returns an empty array for an empty string', () => {
    expect(getTags(item({ [FIELD_TAGS]: '' }))).toEqual([]);
  });

  it('returns an empty array when the field is missing', () => {
    expect(getTags(EMPTY)).toEqual([]);
  });

  it('returns a single tag', () => {
    expect(getTags(item({ [FIELD_TAGS]: 'a' }))).toEqual(['a']);
  });

  it("splits Azure's '; ' separated form and trims", () => {
    expect(getTags(item({ [FIELD_TAGS]: 'a; b' }))).toEqual(['a', 'b']);
  });

  it('splits on a bare semicolon', () => {
    expect(getTags(item({ [FIELD_TAGS]: 'a;b' }))).toEqual(['a', 'b']);
  });

  it('drops empty segments and preserves inner spaces', () => {
    expect(getTags(item({ [FIELD_TAGS]: ' a ;; needs review ; ' }))).toEqual([
      'a',
      'needs review',
    ]);
  });
});

describe('typed field accessors', () => {
  it('getFieldValue returns null for a missing key and the value otherwise', () => {
    expect(getFieldValue(EMPTY, FIELD_TITLE)).toBeNull();
    expect(getFieldValue(item({ [FIELD_TITLE]: 'Ship it' }), FIELD_TITLE)).toBe(
      'Ship it',
    );
    expect(
      getFieldValue(item({ [FIELD_BOARD_COLUMN_DONE]: false }), FIELD_BOARD_COLUMN_DONE),
    ).toBe(false);
    expect(
      getFieldValue(item({ [FIELD_PRIORITY]: 0 }), FIELD_PRIORITY),
    ).toBe(0);
  });

  it('returns undefined on a type mismatch', () => {
    const mixed = item({
      [FIELD_TITLE]: 3,
      [FIELD_PRIORITY]: '2',
      [FIELD_BOARD_COLUMN_DONE]: 'true',
      [FIELD_ASSIGNED_TO]: 'Ada',
    });
    expect(getStringField(mixed, FIELD_TITLE)).toBeUndefined();
    expect(getNumberField(mixed, FIELD_PRIORITY)).toBeUndefined();
    expect(getBooleanField(mixed, FIELD_BOARD_COLUMN_DONE)).toBeUndefined();
    expect(getIdentityField(mixed, FIELD_ASSIGNED_TO)).toBeUndefined();
  });

  it('returns undefined for a null-valued key', () => {
    const nulls = item({
      [FIELD_TITLE]: null,
      [FIELD_PRIORITY]: null,
      [FIELD_BOARD_COLUMN_DONE]: null,
      [FIELD_ASSIGNED_TO]: null,
    });
    expect(getStringField(nulls, FIELD_TITLE)).toBeUndefined();
    expect(getNumberField(nulls, FIELD_PRIORITY)).toBeUndefined();
    expect(getBooleanField(nulls, FIELD_BOARD_COLUMN_DONE)).toBeUndefined();
    expect(getIdentityField(nulls, FIELD_ASSIGNED_TO)).toBeUndefined();
  });

  it('reads well-typed values', () => {
    const full = item({
      [FIELD_TITLE]: 'Ship it',
      [FIELD_PRIORITY]: 2,
      [FIELD_BOARD_COLUMN_DONE]: true,
      [FIELD_ASSIGNED_TO]: { displayName: 'Ada', uniqueName: 'a@b.c' },
    });
    expect(getStringField(full, FIELD_TITLE)).toBe('Ship it');
    expect(getNumberField(full, FIELD_PRIORITY)).toBe(2);
    expect(getBooleanField(full, FIELD_BOARD_COLUMN_DONE)).toBe(true);
    expect(getIdentityField(full, FIELD_ASSIGNED_TO)).toEqual({
      displayName: 'Ada',
      uniqueName: 'a@b.c',
    });
  });
});

describe('named accessors on a missing key', () => {
  it('returns undefined from every optional named accessor', () => {
    const optionalAccessors: [
      string,
      (holder: WorkItemFieldsHolder) => unknown,
    ][] = [
      ['getTeamProject', getTeamProject],
      ['getAssignee', getAssignee],
      ['getDescriptionHtml', getDescriptionHtml],
      ['getAcceptanceCriteriaHtml', getAcceptanceCriteriaHtml],
      ['getReproStepsHtml', getReproStepsHtml],
      ['getChangedDate', getChangedDate],
      ['getBoardColumn', getBoardColumn],
      ['getBoardColumnDone', getBoardColumnDone],
      ['getPriority', getPriority],
      ['getStackRank', getStackRank],
      ['getStoryPoints', getStoryPoints],
      ['getIterationPath', getIterationPath],
    ];

    for (const [name, accessor] of optionalAccessors) {
      expect(accessor(EMPTY), name).toBeUndefined();
    }
  });

  it('returns an empty string from the required string accessors', () => {
    expect(getTitle(EMPTY)).toBe('');
    expect(getWorkItemType(EMPTY)).toBe('');
    expect(getState(EMPTY)).toBe('');
  });

  it('reads each named accessor from a fully populated item', () => {
    const full = item({
      [FIELD_TITLE]: 'Ship it',
      [FIELD_WORK_ITEM_TYPE]: 'Bug',
      [FIELD_STATE]: 'Active',
      [FIELD_TEAM_PROJECT]: 'Contoso',
      [FIELD_ASSIGNED_TO]: { displayName: 'Ada' },
      [FIELD_DESCRIPTION]: '<p>desc</p>',
      [FIELD_ACCEPTANCE_CRITERIA]: '<p>ac</p>',
      [FIELD_REPRO_STEPS]: '<p>repro</p>',
      [FIELD_CHANGED_DATE]: '2026-09-19T00:00:00Z',
      [FIELD_BOARD_COLUMN]: 'Doing',
      [FIELD_BOARD_COLUMN_DONE]: false,
      [FIELD_PRIORITY]: 1,
      [FIELD_STACK_RANK]: 1234.5,
      [FIELD_STORY_POINTS]: 3,
      [FIELD_ITERATION_PATH]: 'Contoso\\Sprint 1',
    });

    expect(getTitle(full)).toBe('Ship it');
    expect(getWorkItemType(full)).toBe('Bug');
    expect(getState(full)).toBe('Active');
    expect(getTeamProject(full)).toBe('Contoso');
    expect(getAssignee(full)).toEqual({ displayName: 'Ada' });
    expect(getDescriptionHtml(full)).toBe('<p>desc</p>');
    expect(getAcceptanceCriteriaHtml(full)).toBe('<p>ac</p>');
    expect(getReproStepsHtml(full)).toBe('<p>repro</p>');
    expect(getChangedDate(full)).toBe('2026-09-19T00:00:00Z');
    expect(getBoardColumn(full)).toBe('Doing');
    expect(getBoardColumnDone(full)).toBe(false);
    expect(getPriority(full)).toBe(1);
    expect(getStackRank(full)).toBe(1234.5);
    expect(getStoryPoints(full)).toBe(3);
    expect(getIterationPath(full)).toBe('Contoso\\Sprint 1');
  });
});

describe('core field constants', () => {
  it('has no duplicate core refNames', () => {
    expect(new Set(CORE_FIELD_REFNAMES).size).toBe(CORE_FIELD_REFNAMES.length);
  });

  it('has metadata for every core refName, keyed by its own refName', () => {
    for (const refName of CORE_FIELD_REFNAMES) {
      const metadata = CORE_FIELD_METADATA[refName];
      expect(metadata, refName).toBeDefined();
      expect(metadata.refName).toBe(refName);
      // Empty validWorkItemTypes means "valid for all work item types".
      expect(Array.isArray(metadata.validWorkItemTypes)).toBe(true);
    }
    expect(Object.keys(CORE_FIELD_METADATA).sort()).toEqual(
      [...CORE_FIELD_REFNAMES].sort(),
    );
  });

  it('only marks editable fields that are core and not read-only', () => {
    for (const refName of EDITABLE_FIELD_REFNAMES) {
      expect(CORE_FIELD_REFNAMES, refName).toContain(refName);
      expect(CORE_FIELD_METADATA[refName].readOnly, refName).toBe(false);
    }
  });
});

describe('formatAssignedToValue', () => {
  it('combines display name and unique name so Azure resolves one identity', () => {
    expect(
      formatAssignedToValue({
        displayName: 'Belén Reyes',
        value: 'Belen.Reyes@squirel.fr',
      }),
    ).toBe('Belén Reyes <Belen.Reyes@squirel.fr>');
  });

  it('keeps unassigned empty so the patch stays a remove', () => {
    expect(formatAssignedToValue({ displayName: 'Unassigned', value: '' })).toBe(
      '',
    );
  });

  it('leaves display-name-only and already-combined values untouched', () => {
    expect(
      formatAssignedToValue({
        displayName: 'Ada Lovelace',
        value: 'Ada Lovelace',
      }),
    ).toBe('Ada Lovelace');
    expect(
      formatAssignedToValue({ displayName: 'Ada', value: 'Ada <ada@x.io>' }),
    ).toBe('Ada <ada@x.io>');
  });
});
