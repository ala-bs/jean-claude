import { describe, expect, it } from 'vitest';

import {
  getThinkingEffortOptions,
  normalizeThinkingEffortForModel,
} from './thinking-settings';

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

  it('returns default thinking option for copilot without model capabilities', () => {
    expect(
      getThinkingEffortOptions({
        backend: 'copilot',
        model: 'default',
      }).map((option) => option.value),
    ).toEqual(['default']);
  });

  it('uses copilot dynamic thinking efforts when available', () => {
    expect(
      getThinkingEffortOptions({
        backend: 'copilot',
        model: 'gpt-5',
        capabilities: {
          supportsThinking: true,
          thinkingEfforts: ['low', 'medium', 'high', 'xhigh'],
        },
      }).map((option) => option.value),
    ).toEqual(['default', 'low', 'medium', 'high', 'xhigh']);
  });

  it('hides explicit copilot efforts for non-reasoning models', () => {
    expect(
      getThinkingEffortOptions({
        backend: 'copilot',
        model: 'gpt-4.1',
        capabilities: { supportsThinking: false },
      }).map((option) => option.value),
    ).toEqual(['default']);
  });

  it('normalizes unsupported copilot thinking effort to default', () => {
    expect(
      normalizeThinkingEffortForModel({
        backend: 'copilot',
        model: 'default',
        effort: 'high',
      }),
    ).toBe('default');
  });

  it('keeps copilot thinking effort for service fallback without capabilities', () => {
    expect(
      normalizeThinkingEffortForModel({
        backend: 'copilot',
        model: 'default',
        effort: 'high',
        allowCopilotEffortWithoutCapabilities: true,
      }),
    ).toBe('high');
  });

  it('normalizes unsupported copilot service fallback effort to default', () => {
    expect(
      normalizeThinkingEffortForModel({
        backend: 'copilot',
        model: 'default',
        effort: 'max',
        allowCopilotEffortWithoutCapabilities: true,
      }),
    ).toBe('default');
  });

  it('keeps supported copilot thinking effort', () => {
    expect(
      normalizeThinkingEffortForModel({
        backend: 'copilot',
        model: 'gpt-5',
        effort: 'high',
        capabilities: {
          supportsThinking: true,
          thinkingEfforts: ['low', 'medium', 'high'],
        },
      }),
    ).toBe('high');
  });
});
