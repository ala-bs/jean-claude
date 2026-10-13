import { describe, expect, it } from 'vitest';

import type { ModelProfile } from '@shared/model-profiles';

import {
  buildModelOverrideFromDraft,
  resolveAgentModelSelection,
} from './default-models';

// Revision 1: a role holds its own triple; presets live on the profile as
// named shortcuts you apply, never as a reference a role points at.
const SONNET_HIGH = {
  backend: 'claude-code',
  model: 'sonnet',
  thinkingEffort: 'high',
} as const;
const GPT5_LOW = {
  backend: 'opencode',
  model: 'gpt-5',
  thinkingEffort: 'low',
} as const;
const OPUS_MAX = {
  backend: 'claude-code',
  model: 'opus',
  thinkingEffort: 'max',
} as const;

const PROFILES: ModelProfile[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    presets: [
      { id: 'preset-sonnet', name: 'Sonnet high', ...SONNET_HIGH },
      { id: 'preset-opus', name: 'Opus max', ...OPUS_MAX },
    ],
    quickPresetIds: ['preset-sonnet', 'preset-opus'],
    roles: { agent: { ...SONNET_HIGH } },
  },
  {
    id: 'fallback',
    name: 'Fallback',
    presets: [{ id: 'preset-gpt5', name: 'GPT-5 low', ...GPT5_LOW }],
    quickPresetIds: ['preset-gpt5'],
    roles: { agent: { ...GPT5_LOW } },
  },
];

const ENABLED_BACKENDS = ['claude-code', 'opencode'] as const;

function resolve({
  activeProfileId,
  policy,
  draft,
}: {
  activeProfileId: string | null;
  policy?: Parameters<typeof resolveAgentModelSelection>[0]['policy'];
  draft?: Parameters<typeof buildModelOverrideFromDraft>[0];
}) {
  return resolveAgentModelSelection({
    profiles: PROFILES,
    activeProfileId,
    policy,
    enabledBackends: [...ENABLED_BACKENDS],
    draft,
  });
}

describe('resolveAgentModelSelection', () => {
  it('uses the active profile agent triple for a fresh draft', () => {
    const resolved = resolve({ activeProfileId: 'anthropic' });

    expect(resolved.backend).toBe('claude-code');
    expect(resolved.model).toBe('sonnet');
    expect(resolved.thinkingEffort).toBe('high');
    expect(resolved.source).toBe('profile');
  });

  it('changes the created task triple when the active profile changes', () => {
    const before = resolve({ activeProfileId: 'anthropic' });
    const after = resolve({ activeProfileId: 'fallback' });

    expect(before.backend).toBe('claude-code');
    expect(before.model).toBe('sonnet');
    expect(after.backend).toBe('opencode');
    expect(after.model).toBe('gpt-5');
    expect(after.thinkingEffort).toBe('low');
  });

  it('uses a project default profile for an untouched new-task draft', () => {
    const resolved = resolve({
      activeProfileId: 'anthropic',
      policy: { mode: 'prefer', pinnedProfileId: 'fallback' },
      draft: {
        modelPreference: 'default',
        thinkingEffort: 'default',
      },
    });

    expect(resolved.profileId).toBe('fallback');
    expect(resolved.backend).toBe('opencode');
    expect(resolved.model).toBe('gpt-5');
    expect(resolved.source).toBe('policy');
  });

  it('keeps an explicit new-task override over the project default', () => {
    const resolved = resolve({
      activeProfileId: 'anthropic',
      policy: { mode: 'prefer', pinnedProfileId: 'fallback' },
      draft: { agentBackend: 'claude-code', modelPreference: 'opus' },
    });

    expect(resolved.profileId).toBe('fallback');
    expect(resolved.backend).toBe('claude-code');
    expect(resolved.model).toBe('opus');
    expect(resolved.source).toBe('override');
  });

  it('lets an explicit per-step override win over the active profile', () => {
    const resolved = resolve({
      activeProfileId: 'anthropic',
      draft: {
        agentBackend: 'opencode',
        modelPreference: 'gpt-5',
        thinkingEffort: 'low',
        backendModelPresetId: null,
      },
    });

    expect(resolved.backend).toBe('opencode');
    expect(resolved.model).toBe('gpt-5');
    expect(resolved.thinkingEffort).toBe('low');
    expect(resolved.source).toBe('override');
  });

  it('resolves a preset-id override to that preset triple', () => {
    const resolved = resolve({
      activeProfileId: 'anthropic',
      draft: { backendModelPresetId: 'preset-opus' },
    });

    expect(resolved.backend).toBe('claude-code');
    expect(resolved.model).toBe('opus');
    expect(resolved.thinkingEffort).toBe('max');
    expect(resolved.source).toBe('override');
  });

  // Presets are owned by a profile, so one profile cannot reach another's.
  // This is the invariant that makes a quick chip impossible to contradict the
  // profile it was offered under.
  it('ignores a preset id that belongs to a different profile', () => {
    const resolved = resolve({
      activeProfileId: 'anthropic',
      draft: { backendModelPresetId: 'preset-gpt5' },
    });

    expect(resolved.backend).toBe('claude-code');
    expect(resolved.model).toBe('sonnet');
  });

  it('falls back to the first enabled backend when no profile is active', () => {
    const resolved = resolve({ activeProfileId: null });

    expect(resolved.backend).toBe('claude-code');
    expect(resolved.model).toBe('default');
    expect(resolved.source).toBe('fallback');
  });

  it('honors an enforcing project policy over the active profile', () => {
    const resolved = resolveAgentModelSelection({
      profiles: PROFILES,
      activeProfileId: 'anthropic',
      enabledBackends: [...ENABLED_BACKENDS],
      policy: { mode: 'enforce', pinnedProfileId: 'fallback' },
    });

    expect(resolved.backend).toBe('opencode');
    expect(resolved.model).toBe('gpt-5');
    expect(resolved.profileId).toBe('fallback');
    expect(resolved.source).toBe('policy');
  });
});

describe('buildModelOverrideFromDraft', () => {
  it('returns null for an untouched draft', () => {
    expect(buildModelOverrideFromDraft(undefined)).toBeNull();
    expect(
      buildModelOverrideFromDraft({
        agentBackend: null,
        modelPreference: null,
        thinkingEffort: null,
        backendModelPresetId: null,
      }),
    ).toBeNull();
  });

  it('keeps only the fields the user actually set', () => {
    expect(
      buildModelOverrideFromDraft({
        agentBackend: 'opencode',
        modelPreference: null,
      }),
    ).toEqual({ backend: 'opencode' });
  });
});
