import type { UsageDisplaySetting } from '@shared/types';

export function redactUsageDisplaySetting(
  setting: UsageDisplaySetting,
): UsageDisplaySetting {
  return {
    ...setting,
    copilotToken: setting.copilotToken ? 'stored' : '',
  };
}

export function prepareUsageDisplaySettingForSave({
  params,
  existing,
  encrypt,
}: {
  params: UsageDisplaySetting;
  existing: UsageDisplaySetting;
  encrypt: (value: string) => string;
}): UsageDisplaySetting {
  const copilotToken =
    params.copilotToken && params.copilotToken !== 'stored'
      ? encrypt(params.copilotToken)
      : params.copilotToken === ''
        ? ''
        : existing.copilotToken;

  return {
    ...params,
    copilotToken,
  };
}
