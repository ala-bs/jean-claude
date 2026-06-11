import { describe, expect, it } from 'vitest';

import {
  prepareUsageDisplaySettingForSave,
  redactUsageDisplaySetting,
} from './usage-display-settings';

describe('usage display settings IPC helpers', () => {
  it('redacts stored Copilot token', () => {
    expect(
      redactUsageDisplaySetting({
        enabledProviders: ['copilot'],
        copilotToken: 'encrypted-token',
      }),
    ).toEqual({
      enabledProviders: ['copilot'],
      copilotToken: 'stored',
    });
  });

  it('preserves stored Copilot token marker', () => {
    const result = prepareUsageDisplaySettingForSave({
      existing: { enabledProviders: ['copilot'], copilotToken: 'encrypted' },
      params: { enabledProviders: ['copilot'], copilotToken: 'stored' },
      encrypt: (value) => `encrypted:${value}`,
    });

    expect(result.copilotToken).toBe('encrypted');
  });

  it('clears Copilot token when explicitly empty', () => {
    const result = prepareUsageDisplaySettingForSave({
      existing: { enabledProviders: ['copilot'], copilotToken: 'encrypted' },
      params: { enabledProviders: ['copilot'], copilotToken: '' },
      encrypt: (value) => `encrypted:${value}`,
    });

    expect(result.copilotToken).toBe('');
  });

  it('encrypts new Copilot token values', () => {
    const result = prepareUsageDisplaySettingForSave({
      existing: { enabledProviders: ['copilot'], copilotToken: 'encrypted' },
      params: { enabledProviders: ['copilot'], copilotToken: 'plain-token' },
      encrypt: (value) => `encrypted:${value}`,
    });

    expect(result.copilotToken).toBe('encrypted:plain-token');
  });
});
