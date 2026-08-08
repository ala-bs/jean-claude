import { describe, expect, it } from 'vitest';

import {
  isEureciaSettingDraftEquivalent,
  parseEureciaSettingDraft,
  serializeEureciaSettingDraft,
  validateEureciaSettingForm,
} from './eurecia-setting-form';

const validSetting = {
  baseUrl: 'https://tenant.eurecia.com',
  axis1Label: 'Project',
  axis2Label: 'Activity',
  axis3Label: 'Role',
};

describe('validateEureciaSettingForm', () => {
  it('trims labels and normalizes an origin without a trailing slash', () => {
    expect(
      validateEureciaSettingForm({
        ...validSetting,
        baseUrl: '  https://TENANT.eurecia.com:443/  ',
        axis1Label: ' Project ',
      }),
    ).toEqual({
      errors: {},
      value: validSetting,
    });
  });

  it.each([
    'http://tenant.eurecia.com',
    'https://user:secret@tenant.eurecia.com',
    'https://tenant.eurecia.com/path',
    'https://tenant.eurecia.com?view=timesheet',
    'https://tenant.eurecia.com#login',
  ])('rejects non-origin base URL %s', (baseUrl) => {
    const result = validateEureciaSettingForm({ ...validSetting, baseUrl });

    expect(result.value).toBeNull();
    expect(result.errors.baseUrl).toBeTruthy();
  });

  it('rejects empty, long, and control-character labels', () => {
    const result = validateEureciaSettingForm({
      ...validSetting,
      axis1Label: ' ',
      axis2Label: 'A'.repeat(101),
      axis3Label: 'Role\nname',
    });

    expect(result.value).toBeNull();
    expect(result.errors).toEqual({
      axis1Label: 'Enter a heading.',
      axis2Label: 'Use 100 characters or fewer.',
      axis3Label: 'Control characters are not allowed.',
    });
  });
});

describe('Eurecia setting draft serialization', () => {
  it('serializes only the Eurecia form fields', () => {
    const draftWithUnexpectedData = {
      ...validSetting,
      cookies: 'secret',
    };
    const serialized = serializeEureciaSettingDraft(draftWithUnexpectedData);

    expect(serialized).not.toContain('cookies');
    expect(parseEureciaSettingDraft(serialized)).toEqual(validSetting);
  });

  it.each([
    null,
    '',
    '{',
    '[]',
    JSON.stringify({ ...validSetting, cookies: 'secret' }),
    JSON.stringify({ ...validSetting, axis3Label: 3 }),
    JSON.stringify({
      baseUrl: validSetting.baseUrl,
      axis1Label: validSetting.axis1Label,
      axis2Label: validSetting.axis2Label,
    }),
  ])('rejects malformed or non-form draft %s', (serialized) => {
    expect(parseEureciaSettingDraft(serialized)).toBeNull();
  });

  it('treats normalized-equivalent raw edits as matching server settings', () => {
    expect(
      isEureciaSettingDraftEquivalent(
        {
          ...validSetting,
          baseUrl: ' https://TENANT.eurecia.com/ ',
          axis1Label: ' Project ',
        },
        validSetting,
      ),
    ).toBe(true);
  });

  it('does not treat an invalid draft as matching server settings', () => {
    expect(
      isEureciaSettingDraftEquivalent(
        { ...validSetting, axis1Label: '' },
        validSetting,
      ),
    ).toBe(false);
  });
});
