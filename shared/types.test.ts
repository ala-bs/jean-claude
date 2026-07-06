import { describe, expect, it } from 'vitest';

import { SETTINGS_DEFINITIONS } from './types';

describe('SETTINGS_DEFINITIONS.thinkingSettings', () => {
  it('accepts Codex minimal reasoning effort', () => {
    expect(
      SETTINGS_DEFINITIONS.thinkingSettings.validate({
        efforts: {
          'claude-code': { default: 'default' },
          opencode: { default: 'default' },
          codex: { default: 'minimal', 'gpt-5.4': 'minimal' },
          copilot: { default: 'default' },
        },
        selectedModels: {
          'claude-code': 'default',
          opencode: 'default',
          codex: 'gpt-5.4',
          copilot: 'default',
        },
      }),
    ).toBe(true);
  });
});
