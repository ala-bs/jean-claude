import { describe, expect, it } from 'vitest';

import {
  getQuickPresets,
  isProfilePresetSelectable,
  resolveBackendModelSelection,
} from './index';
import type { ModelProfile, ProfilePreset } from '@shared/model-profiles';

const sonnet: ProfilePreset = {
  id: 'sonnet',
  name: 'Sonnet',
  backend: 'claude-code',
  model: 'sonnet',
  thinkingEffort: 'default',
};
const opus: ProfilePreset = {
  id: 'opus',
  name: 'Opus',
  backend: 'claude-code',
  model: 'opus',
  thinkingEffort: 'default',
};
const ocFast: ProfilePreset = {
  id: 'oc-fast',
  name: 'OC Fast',
  backend: 'opencode',
  model: 'openai/gpt-5-mini',
  thinkingEffort: 'default',
};
/** Exists in the profile, but is not pinned to the quick list. */
const deep: ProfilePreset = {
  id: 'deep',
  name: 'Deep',
  backend: 'claude-code',
  model: 'opus',
  thinkingEffort: 'high',
};

const presets = [sonnet, opus, ocFast];

const anthropicProfile: ModelProfile = {
  id: 'anthropic',
  name: 'Anthropic',
  presets: [sonnet, opus, deep],
  quickPresetIds: ['sonnet', 'opus'],
  roles: { agent: { ...sonnet } },
};

const codexProfile: ModelProfile = {
  id: 'codex',
  name: 'Codex fallback',
  presets: [ocFast],
  quickPresetIds: ['oc-fast'],
  roles: { agent: { ...ocFast } },
};

const base = {
  presets,
  quickPresetIds: ['sonnet', 'opus', 'oc-fast'],
  backend: 'claude-code' as const,
  defaultModel: 'default' as const,
  enabledBackends: ['claude-code' as const, 'opencode' as const],
  availableModels: ['default' as const, 'sonnet' as const, 'opus' as const],
  areModelsFetched: true,
};

describe('isProfilePresetSelectable', () => {
  it('rejects a preset whose backend is disabled', () => {
    expect(
      isProfilePresetSelectable({
        preset: ocFast,
        enabledBackends: ['claude-code'],
      }),
    ).toBe(false);
  });

  it('accepts any backend when the enabled list is unknown', () => {
    expect(isProfilePresetSelectable({ preset: ocFast })).toBe(true);
  });
});

describe('getQuickPresets', () => {
  it('offers the active profile quick presets, in the profile order', () => {
    expect(
      getQuickPresets({ profile: anthropicProfile }).map(
        (preset) => preset.id,
      ),
    ).toEqual(['sonnet', 'opus']);
  });

  it('changes the chips when the active profile changes', () => {
    expect(
      getQuickPresets({ profile: codexProfile }).map((preset) => preset.id),
    ).toEqual(['oc-fast']);
  });

  it('omits a profile preset that is not pinned to the quick list', () => {
    expect(
      getQuickPresets({ profile: anthropicProfile }).map(
        (preset) => preset.id,
      ),
    ).not.toContain('deep');
  });

  it('omits a quick preset whose backend is disabled', () => {
    expect(
      getQuickPresets({
        profile: codexProfile,
        enabledBackends: ['claude-code'],
      }),
    ).toEqual([]);
  });

  it('ignores a quick id with no matching preset', () => {
    expect(
      getQuickPresets({
        profile: { ...anthropicProfile, quickPresetIds: ['gone', 'opus'] },
      }).map((preset) => preset.id),
    ).toEqual(['opus']);
  });

  it('returns nothing when there is no active profile', () => {
    expect(getQuickPresets({ profile: null })).toEqual([]);
  });
});

describe('resolveBackendModelSelection', () => {
  it('defaults an empty draft to the first quick preset of the profile', () => {
    const result = resolveBackendModelSelection({
      ...base,
      presets: anthropicProfile.presets,
      quickPresetIds: anthropicProfile.quickPresetIds,
      profiles: [anthropicProfile],
      activeProfileId: 'anthropic',
    });

    expect(result.presetId).toBe('sonnet');
    expect(result.model).toBe('sonnet');
  });

  it('follows the newly active profile after a profile switch', () => {
    const result = resolveBackendModelSelection({
      ...base,
      backend: 'opencode',
      presets: codexProfile.presets,
      quickPresetIds: codexProfile.quickPresetIds,
      profiles: [anthropicProfile, codexProfile],
      activeProfileId: 'codex',
      availableModels: ['default', 'openai/gpt-5-mini'],
    });

    expect(result.presetId).toBe('oc-fast');
    expect(result.model).toBe('openai/gpt-5-mini');
  });

  it('never picks a quick preset for a different backend', () => {
    const result = resolveBackendModelSelection({
      ...base,
      backend: 'opencode',
      availableModels: ['default', 'openai/gpt-5-mini'],
    });

    expect(result.preset?.backend).toBe('opencode');
    expect(result.model).toBe('openai/gpt-5-mini');
  });

  it('falls back to Custom when the profile pins no quick presets', () => {
    const result = resolveBackendModelSelection({
      ...base,
      quickPresetIds: [],
    });

    expect(result.presetId).toBeNull();
    expect(result.model).toBe('default');
  });

  it('never overrides a model the user already picked', () => {
    const result = resolveBackendModelSelection({
      ...base,
      draftModelPreference: 'opus',
    });

    expect(result.presetId).toBe('opus');
    expect(result.model).toBe('opus');
  });

  it('lets a per-task override win over the active profile', () => {
    const result = resolveBackendModelSelection({
      ...base,
      presets: anthropicProfile.presets,
      quickPresetIds: anthropicProfile.quickPresetIds,
      profiles: [anthropicProfile],
      activeProfileId: 'anthropic',
      draftAgentBackend: 'opencode',
      draftModelPreference: 'openai/gpt-5-mini',
      availableModels: ['default', 'openai/gpt-5-mini'],
    });

    expect(result.presetId).toBeNull();
    expect(result.model).toBe('openai/gpt-5-mini');
  });

  it('keeps the draft model and shows Custom when nothing matches', () => {
    const result = resolveBackendModelSelection({
      ...base,
      presets: [ocFast],
      draftModelPreference: 'opus',
    });

    expect(result.presetId).toBeNull();
    expect(result.model).toBe('opus');
  });

  it('does not clamp an unknown model while the model list is still loading', () => {
    const result = resolveBackendModelSelection({
      ...base,
      backend: 'opencode',
      draftModelPreference: 'openai/gpt-6',
      availableModels: ['default'],
      areModelsFetched: false,
    });

    expect(result.model).toBe('openai/gpt-6');
  });

  it('clamps an unknown model to default once the model list has loaded', () => {
    const result = resolveBackendModelSelection({
      ...base,
      backend: 'opencode',
      draftModelPreference: 'openai/gpt-6',
      availableModels: ['default'],
      areModelsFetched: true,
    });

    expect(result.model).toBe('default');
  });

  it('does not clamp when no model list was supplied', () => {
    const result = resolveBackendModelSelection({
      ...base,
      backend: 'opencode',
      draftModelPreference: 'openai/gpt-6',
      availableModels: undefined,
      areModelsFetched: true,
    });

    expect(result.model).toBe('openai/gpt-6');
  });

  it('does not clamp when there is no backend to validate against', () => {
    const result = resolveBackendModelSelection({
      ...base,
      backend: null,
      draftModelPreference: 'openai/gpt-6',
      availableModels: ['default'],
    });

    expect(result.model).toBe('openai/gpt-6');
  });

  it('drops a selected preset whose backend was since disabled', () => {
    const result = resolveBackendModelSelection({
      ...base,
      backend: 'opencode',
      draftPresetId: 'oc-fast',
      draftModelPreference: 'openai/gpt-5-mini',
      shouldAutoSelectPreset: false,
      enabledBackends: ['claude-code'],
      availableModels: ['default'],
      areModelsFetched: true,
    });

    expect(result.presetId).toBeNull();
    expect(result.model).toBe('default');
  });

  it('drops a selected preset that no longer exists', () => {
    const result = resolveBackendModelSelection({
      ...base,
      draftPresetId: 'deleted',
      draftModelPreference: 'sonnet',
      shouldAutoSelectPreset: false,
    });

    expect(result.presetId).toBeNull();
    expect(result.preset).toBeNull();
    expect(result.model).toBe('sonnet');
  });

  it('respects an explicit Custom choice instead of re-matching a preset', () => {
    const result = resolveBackendModelSelection({
      ...base,
      draftPresetId: null,
      draftModelPreference: 'sonnet',
      draftAgentBackend: 'claude-code',
      shouldAutoSelectPreset: false,
    });

    expect(result.presetId).toBeNull();
    expect(result.model).toBe('sonnet');
  });

  it('keeps a persisted preset id when shouldAutoSelectPreset is undefined', () => {
    const result = resolveBackendModelSelection({
      ...base,
      draftPresetId: 'opus',
      draftModelPreference: 'opus',
    });

    expect(result.presetId).toBe('opus');
    expect(result.model).toBe('opus');
  });

  it('never clamps the model while a preset is selected, even if unknown', () => {
    const result = resolveBackendModelSelection({
      ...base,
      draftPresetId: 'sonnet',
      draftModelPreference: 'sonnet-1m',
      availableModels: ['default'],
      areModelsFetched: true,
    });

    expect(result.presetId).toBe('sonnet');
    expect(result.model).toBe('sonnet-1m');
  });

  it('treats an unknown enabled-backend list as permissive', () => {
    const result = resolveBackendModelSelection({
      ...base,
      enabledBackends: undefined,
      backend: 'opencode',
      draftPresetId: 'oc-fast',
      shouldAutoSelectPreset: false,
    });

    expect(result.presetId).toBe('oc-fast');
  });

  it('skips a leading quick preset that belongs to another backend', () => {
    const result = resolveBackendModelSelection({
      ...base,
      presets: [ocFast, sonnet],
      quickPresetIds: ['oc-fast', 'sonnet'],
    });

    expect(result.presetId).toBe('sonnet');
  });

  it('does not apply the quick-preset default once a backend was chosen', () => {
    const result = resolveBackendModelSelection({
      ...base,
      draftAgentBackend: 'claude-code',
    });

    expect(result.presetId).toBeNull();
    expect(result.model).toBe('default');
  });
});
