import { describe, expect, it } from 'vitest';

import {
  isBackendModelPresetSelectable,
  resolveBackendModelSelection,
} from './index';
import type { BackendModelPreset } from '@shared/types';

const sonnet: BackendModelPreset = {
  id: 'sonnet',
  name: 'Sonnet',
  backend: 'claude-code',
  model: 'sonnet',
};
const opus: BackendModelPreset = {
  id: 'opus',
  name: 'Opus',
  backend: 'claude-code',
  model: 'opus',
};
const ocFast: BackendModelPreset = {
  id: 'oc-fast',
  name: 'OC Fast',
  backend: 'opencode',
  model: 'openai/gpt-5-mini',
};
const hidden: BackendModelPreset = {
  id: 'deep',
  name: 'Deep',
  backend: 'claude-code',
  model: 'opus',
  showInQuickSwitcher: false,
};

const presets = [sonnet, opus, ocFast];

const base = {
  presets,
  backend: 'claude-code' as const,
  defaultModel: 'default' as const,
  enabledBackends: ['claude-code' as const, 'opencode' as const],
  availableModels: ['default' as const, 'sonnet' as const, 'opus' as const],
  areModelsFetched: true,
};

describe('isBackendModelPresetSelectable', () => {
  it('rejects a preset whose backend is disabled', () => {
    expect(
      isBackendModelPresetSelectable({
        preset: ocFast,
        enabledBackends: ['claude-code'],
      }),
    ).toBe(false);
  });

  it('rejects a quick-switcher-hidden preset while the quick switcher is on', () => {
    expect(
      isBackendModelPresetSelectable({
        preset: hidden,
        quickSwitcherEnabled: true,
      }),
    ).toBe(false);
  });

  it('accepts a hidden preset when the quick switcher is off', () => {
    expect(
      isBackendModelPresetSelectable({
        preset: hidden,
        quickSwitcherEnabled: false,
      }),
    ).toBe(true);
  });

  it('accepts any backend when the enabled list is unknown', () => {
    expect(isBackendModelPresetSelectable({ preset: ocFast })).toBe(true);
  });
});

describe('resolveBackendModelSelection', () => {
  it('defaults an empty draft to the first quick preset when the quick switcher is on', () => {
    const result = resolveBackendModelSelection({
      ...base,
      quickSwitcherEnabled: true,
    });

    expect(result.presetId).toBe('sonnet');
    expect(result.model).toBe('sonnet');
  });

  it('never picks a quick preset for a different backend', () => {
    const result = resolveBackendModelSelection({
      ...base,
      backend: 'opencode',
      availableModels: ['default', 'openai/gpt-5-mini'],
      quickSwitcherEnabled: true,
    });

    expect(result.preset?.backend).toBe('opencode');
    expect(result.model).toBe('openai/gpt-5-mini');
  });

  it('falls back to Custom when the quick switcher is off', () => {
    const result = resolveBackendModelSelection({
      ...base,
      quickSwitcherEnabled: false,
    });

    expect(result.presetId).toBeNull();
    expect(result.model).toBe('default');
  });

  it('never overrides a model the user already picked', () => {
    const result = resolveBackendModelSelection({
      ...base,
      draftModelPreference: 'opus',
      quickSwitcherEnabled: true,
    });

    expect(result.presetId).toBe('opus');
    expect(result.model).toBe('opus');
  });

  it('keeps the draft model and shows Custom when nothing matches', () => {
    const result = resolveBackendModelSelection({
      ...base,
      presets: [ocFast],
      draftModelPreference: 'opus',
      quickSwitcherEnabled: true,
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

  it('drops a selected preset that was hidden from the quick switcher', () => {
    const result = resolveBackendModelSelection({
      ...base,
      presets: [hidden, sonnet],
      draftPresetId: 'deep',
      draftModelPreference: 'opus',
      shouldAutoSelectPreset: false,
      quickSwitcherEnabled: true,
    });

    expect(result.presetId).toBeNull();
    expect(result.model).toBe('opus');
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
      quickSwitcherEnabled: true,
    });

    expect(result.presetId).toBeNull();
    expect(result.model).toBe('sonnet');
  });

  it('keeps a persisted preset id when shouldAutoSelectPreset is undefined', () => {
    const result = resolveBackendModelSelection({
      ...base,
      draftPresetId: 'opus',
      draftModelPreference: 'opus',
      quickSwitcherEnabled: true,
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
      quickSwitcherEnabled: true,
    });

    expect(result.presetId).toBe('sonnet');
  });

  it('does not apply the quick-preset default once a backend was chosen', () => {
    const result = resolveBackendModelSelection({
      ...base,
      draftAgentBackend: 'claude-code',
      quickSwitcherEnabled: true,
    });

    expect(result.presetId).toBeNull();
    expect(result.model).toBe('default');
  });
});
