import { describe, expect, it } from 'vitest';

import {
  AGENT_BACKEND_IDS,
  BACKENDS,
  DEFAULT_MOBILE_PREVIEW_PROJECT_CONFIG,
  DEFAULT_WORK_ITEM_SUMMARY_SLOT,
  getInteractionModeOptions,
  isAiSkillSlotsSetting,
  isMobilePreviewProjectConfig,
  isModelProfile,
  isProjectModelPolicySetting,
  isPrReviewChatStepMeta,
  SETTINGS_DEFINITIONS,
} from './types';
import type { AgentBackendType } from './agent-backend-types';

describe('BACKENDS registry', () => {
  it('is the single source for the runtime backend list', () => {
    expect(AGENT_BACKEND_IDS).toEqual(BACKENDS.map((b) => b.id));
    expect(new Set(AGENT_BACKEND_IDS).size).toBe(AGENT_BACKEND_IDS.length);
  });

  it('is exactly what the backends setting validator accepts', () => {
    expect(
      SETTINGS_DEFINITIONS.backends.validate({
        enabledBackends: AGENT_BACKEND_IDS,
      }),
    ).toBe(true);
    expect(
      SETTINGS_DEFINITIONS.backends.validate({
        enabledBackends: [...AGENT_BACKEND_IDS, 'not-a-backend'],
      }),
    ).toBe(false);
  });

  it('no longer defines the retired per-backend model settings keys', () => {
    for (const key of [
      'backendDefaultModels',
      'thinkingSettings',
      'summaryModels',
      'prReviewAgent',
      'rateLimitSwap',
    ]) {
      expect(SETTINGS_DEFINITIONS).not.toHaveProperty(key);
    }
    expect(SETTINGS_DEFINITIONS.backends.defaultValue).toEqual({
      enabledBackends: [],
    });
  });

  it('gives every backend a label and a description for the pickers', () => {
    for (const backend of BACKENDS) {
      expect(backend.label.length).toBeGreaterThan(0);
      expect(backend.description.length).toBeGreaterThan(0);
    }
  });
});

describe('getInteractionModeOptions', () => {
  it('includes Ask for Codex while keeping Build as the default', () => {
    expect(getInteractionModeOptions({ backend: 'codex' })).toEqual([
      {
        value: 'auto',
        label: 'Build',
        description: 'Tools run without approval',
      },
      {
        value: 'ask',
        label: 'Ask',
        description: 'Ask for approval before tools run',
      },
      {
        value: 'plan',
        label: 'Plan',
        description: 'Planning only, no execution',
      },
    ]);
  });

  it('falls back instead of returning undefined for stale backend values', () => {
    expect(
      getInteractionModeOptions({ backend: 'stale' as AgentBackendType }),
    ).toEqual([]);
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

describe('isModelProfile (Revision 1: roles hold inline triples)', () => {
  const base = {
    id: 'anthropic',
    name: 'Anthropic',
    presets: [],
    quickPresetIds: [],
  };

  it('accepts a role bound to an inline triple', () => {
    expect(
      isModelProfile({
        ...base,
        roles: {
          agent: {
            backend: 'claude-code',
            model: 'sonnet',
            thinkingEffort: 'high',
          },
        },
      }),
    ).toBe(true);
  });

  it('accepts inherit and off bindings', () => {
    expect(
      isModelProfile({ ...base, roles: { summary: 'inherit', memory: 'off' } }),
    ).toBe(true);
  });

  it('still accepts a legacy preset-id binding so the startup migration can inline it', () => {
    expect(isModelProfile({ ...base, roles: { agent: 'preset-sonnet' } })).toBe(
      true,
    );
  });

  // Revision 2: a role may point at a preset of its profile by id. A guard that
  // does not know the shape discards the WHOLE `modelProfiles` setting on read.
  it('accepts a role bound to a preset by reference', () => {
    expect(
      isModelProfile({ ...base, roles: { summary: { presetId: 'fast' } } }),
    ).toBe(true);
  });

  it('accepts an image-model binding', () => {
    expect(
      isModelProfile({
        ...base,
        roles: { 'project-logo': { imageModel: 'gpt-image-1' } },
      }),
    ).toBe(true);
  });

  it('rejects a preset reference that is not a non-empty string', () => {
    expect(isModelProfile({ ...base, roles: { summary: { presetId: 42 } } })).toBe(
      false,
    );
    expect(isModelProfile({ ...base, roles: { summary: { presetId: '' } } })).toBe(
      false,
    );
  });

  it('rejects a malformed triple binding', () => {
    expect(
      isModelProfile({
        ...base,
        roles: { agent: { backend: 'not-a-backend', model: 'sonnet' } },
      }),
    ).toBe(false);
  });
});

describe('isProjectModelPolicySetting', () => {
  it('accepts allowedProfileIds', () => {
    expect(
      isProjectModelPolicySetting({
        mode: 'enforce',
        allowedProfileIds: ['anthropic'],
      }),
    ).toBe(true);
  });

  it('rejects a non-string allowedProfileIds entry', () => {
    expect(
      isProjectModelPolicySetting({ mode: 'enforce', allowedProfileIds: [1] }),
    ).toBe(false);
  });
});

describe('SETTINGS_DEFINITIONS (Revision 1 deletions)', () => {
  it('no longer defines the global preset and quick-switcher keys', () => {
    expect(SETTINGS_DEFINITIONS).not.toHaveProperty('backendModelPresets');
    expect(SETTINGS_DEFINITIONS).not.toHaveProperty('modelQuickSwitcher');
  });
});
