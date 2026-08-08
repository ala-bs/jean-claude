import type { EureciaSetting } from '@shared/types';

export type EureciaSettingField = keyof EureciaSetting;

const EURECIA_SETTING_FIELDS: EureciaSettingField[] = [
  'baseUrl',
  'axis1Label',
  'axis2Label',
  'axis3Label',
];

export function serializeEureciaSettingDraft(value: EureciaSetting): string {
  return JSON.stringify({
    baseUrl: value.baseUrl,
    axis1Label: value.axis1Label,
    axis2Label: value.axis2Label,
    axis3Label: value.axis3Label,
  });
}

export function parseEureciaSettingDraft(
  serialized: string | null,
): EureciaSetting | null {
  if (!serialized) return null;

  try {
    const value = JSON.parse(serialized) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length !== EURECIA_SETTING_FIELDS.length ||
      !EURECIA_SETTING_FIELDS.every(
        (field) => typeof record[field] === 'string',
      )
    ) {
      return null;
    }

    return value as EureciaSetting;
  } catch {
    return null;
  }
}

export function isEureciaSettingDraftEquivalent(
  draft: EureciaSetting,
  setting: EureciaSetting,
): boolean {
  const normalized = validateEureciaSettingForm(draft).value;
  return normalized
    ? JSON.stringify(normalized) === JSON.stringify(setting)
    : false;
}

export function validateEureciaSettingForm(value: EureciaSetting): {
  errors: Partial<Record<EureciaSettingField, string>>;
  value: EureciaSetting | null;
} {
  const errors: Partial<Record<EureciaSettingField, string>> = {};
  const baseUrl = value.baseUrl.trim();
  let normalizedBaseUrl: string | null = null;

  try {
    const url = new URL(baseUrl);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      !/^https:\/\/[^/?#]+\/?$/i.test(baseUrl)
    ) {
      throw new Error('invalid origin');
    }
    normalizedBaseUrl = url.origin;
  } catch {
    errors.baseUrl =
      'Enter an HTTPS origin only, without a path, query, credentials, or fragment.';
  }

  const normalizedLabels = {
    axis1Label: value.axis1Label.trim(),
    axis2Label: value.axis2Label.trim(),
    axis3Label: value.axis3Label.trim(),
  };

  for (const field of [
    'axis1Label',
    'axis2Label',
    'axis3Label',
  ] as const) {
    const label = normalizedLabels[field];
    if (!label) {
      errors[field] = 'Enter a heading.';
    } else if (label.length > 100) {
      errors[field] = 'Use 100 characters or fewer.';
    } else if (/\p{Cc}/u.test(label)) {
      errors[field] = 'Control characters are not allowed.';
    }
  }

  if (Object.keys(errors).length > 0 || !normalizedBaseUrl) {
    return { errors, value: null };
  }

  return {
    errors,
    value: {
      baseUrl: normalizedBaseUrl,
      ...normalizedLabels,
    },
  };
}
