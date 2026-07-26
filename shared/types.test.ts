import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MOBILE_PREVIEW_PROJECT_CONFIG,
  DEFAULT_WORK_ITEM_SUMMARY_SLOT,
  getInteractionModeOptions,
  isAiSkillSlotsSetting,
  isMobilePreviewProjectConfig,
  isPrReviewChatStepMeta,
  SETTINGS_DEFINITIONS,
} from './types';
import type { AgentBackendType } from './agent-backend-types';
import type { MobilePreviewNetworkCaptureSource } from './mobile-simulator-types';

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

describe('MobilePreviewNetworkCaptureSource', () => {
  it('accepts packet-only capture entries', () => {
    const allowedSources = [
      'proxied',
      'mitm',
      'tunneled',
      'packet-only',
    ] satisfies MobilePreviewNetworkCaptureSource[];

    expect(allowedSources).toContain('packet-only');
  });
});

describe('MobilePreviewProjectConfig', () => {
  it('defaults iOS bundle ID to automatic resolution', () => {
    expect(DEFAULT_MOBILE_PREVIEW_PROJECT_CONFIG.iosBundleId).toBeNull();
    expect(isMobilePreviewProjectConfig(DEFAULT_MOBILE_PREVIEW_PROJECT_CONFIG)).toBe(
      true,
    );
  });

  it('rejects invalid iOS bundle ID value types', () => {
    expect(
      isMobilePreviewProjectConfig({
        ...DEFAULT_MOBILE_PREVIEW_PROJECT_CONFIG,
        iosBundleId: 123,
      }),
    ).toBe(false);
  });
});

describe('SETTINGS_DEFINITIONS.aiSkillSlots', () => {
  it('accepts the work item summary slot', () => {
    expect(
      isAiSkillSlotsSetting({
        'work-item-summary': DEFAULT_WORK_ITEM_SUMMARY_SLOT,
      }),
    ).toBe(true);
  });

  it('rejects unknown slot keys', () => {
    expect(
      isAiSkillSlotsSetting({
        'unknown-slot': DEFAULT_WORK_ITEM_SUMMARY_SLOT,
      }),
    ).toBe(false);
  });

  it('enables the work item summary slot by default', () => {
    expect(
      SETTINGS_DEFINITIONS.aiSkillSlots.defaultValue['work-item-summary'],
    ).toEqual(DEFAULT_WORK_ITEM_SUMMARY_SLOT);
  });

  it('uses the builtin work item summary skill by default', () => {
    expect(DEFAULT_WORK_ITEM_SUMMARY_SLOT.skillName).toBe('work-item-summary');
  });
});

describe('SETTINGS_DEFINITIONS.agentMemory', () => {
  it('defaults Agent Memory to disabled with extraction defaults', () => {
    expect(SETTINGS_DEFINITIONS.agentMemory.defaultValue).toEqual({
      enabled: false,
      extractionIntervalMinutes: 24 * 60,
      extractionBackend: 'claude-code',
      extractionModel: 'haiku',
      extractionThinkingEffort: 'default',
    });
  });

  it('validates Agent Memory without the retired consolidation flag', () => {
    expect(
      SETTINGS_DEFINITIONS.agentMemory.validate({
        enabled: true,
        extractionIntervalMinutes: 30,
        extractionBackend: 'opencode',
        extractionModel: 'openai/gpt-5',
        extractionThinkingEffort: 'high',
      }),
    ).toBe(true);
    expect(
      SETTINGS_DEFINITIONS.agentMemory.validate({
        enabled: true,
        consolidationEnabled: true,
        extractionIntervalMinutes: 30,
        extractionBackend: 'opencode',
        extractionModel: 'openai/gpt-5',
        extractionThinkingEffort: 'high',
      }),
    ).toBe(false);
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
