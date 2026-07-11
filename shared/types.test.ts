import { describe, expect, it } from 'vitest';

import {
  getInteractionModeOptions,
  isPrReviewChatStepMeta,
  SETTINGS_DEFINITIONS,
} from './types';
import type { AgentBackendType } from './agent-backend-types';

describe('getInteractionModeOptions', () => {
  it('falls back instead of returning undefined for stale backend values', () => {
    expect(
      getInteractionModeOptions({ backend: 'stale' as AgentBackendType }),
    ).toEqual([]);
  });
});

describe('SETTINGS_DEFINITIONS.thinkingSettings', () => {
  it('accepts Codex minimal reasoning effort', () => {
    expect(
      SETTINGS_DEFINITIONS.thinkingSettings.validate({
        efforts: {
          'claude-code': { default: 'default' },
          opencode: { default: 'default' },
          codex: { default: 'minimal', 'gpt-5.4': 'minimal' },
          copilot: { default: 'default' },
          vibe: { default: 'default' },
        },
        selectedModels: {
          'claude-code': 'default',
          opencode: 'default',
          codex: 'gpt-5.4',
          copilot: 'default',
          vibe: 'default',
        },
      }),
    ).toBe(true);
  });
});

describe('isPrReviewChatStepMeta', () => {
  it('recognizes valid anchored metadata', () => {
    expect(
      isPrReviewChatStepMeta({
        kind: 'pr-review-chat',
        pullRequestId: 42,
        filePath: 'src/example.ts',
        lineStart: 12,
        lineEnd: 16,
        side: 'old',
        selectedText: 'const value = 1;',
      }),
    ).toBe(true);
  });

  it('rejects unrelated metadata', () => {
    expect(
      isPrReviewChatStepMeta({
        pullRequestId: 42,
        projectId: 'project-1',
        comments: [],
      }),
    ).toBe(false);
  });
});
