import { describe, expect, it } from 'vitest';

import { getThinkingEffortOptions } from './thinking-settings';

describe('getThinkingEffortOptions', () => {
  it('keeps default available for Claude model-specific capabilities', () => {
    expect(
      getThinkingEffortOptions({
        backend: 'claude-code',
        model: 'opus',
        capabilities: {
          supportsThinking: true,
          thinkingEfforts: ['low', 'medium', 'high', 'max'],
        },
      }).map((option) => option.value),
    ).toEqual(['default', 'low', 'medium', 'high', 'max']);
  });

  it('hides explicit efforts for known non-reasoning OpenCode models', () => {
    expect(
      getThinkingEffortOptions({
        backend: 'opencode',
        model: 'github-copilot/gpt-4.1',
        capabilities: { supportsThinking: false },
      }).map((option) => option.value),
    ).toEqual(['default']);
  });

  it('uses Codex model-specific reasoning efforts', () => {
    expect(
      getThinkingEffortOptions({
        backend: 'codex',
        model: 'gpt-5.4',
        capabilities: {
          supportsThinking: true,
          thinkingEfforts: ['minimal', 'medium', 'xhigh'],
        },
      }).map((option) => option.value),
    ).toEqual(['default', 'minimal', 'medium', 'xhigh']);
  });
});
