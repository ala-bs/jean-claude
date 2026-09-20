import { describe, expect, it } from 'vitest';

import {
  getRoleDefinition,
  isImageModelBinding,
  isModelTriple,
  isPresetRefBinding,
  listSelectableProfiles,
  type ModelProfile,
  type ModelRole,
  normalizeRoleBinding,
  pickEffectiveProfile,
  resolveImageModelForRole,
  resolveModelForRole,
  roleForSkillSlot,
  toModelTriple,
} from './model-profiles';
import type { AiSkillSlotKey } from './types';

const profiles: ModelProfile[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    presets: [
      {
        id: 'p-gpt5',
        name: 'GPT-5',
        backend: 'codex',
        model: 'gpt-5',
        thinkingEffort: 'high',
      },
    ],
    quickPresetIds: ['p-gpt5'],
    roles: {
      agent: {
        backend: 'claude-code',
        model: 'sonnet',
        thinkingEffort: 'high',
      },
      summary: {
        backend: 'claude-code',
        model: 'haiku',
        thinkingEffort: 'default',
      },
      completion: 'off',
      memory: 'inherit',
    },
  },
  {
    id: 'codex',
    name: 'Codex fallback',
    presets: [],
    quickPresetIds: [],
    roles: {
      agent: { backend: 'codex', model: 'gpt-5', thinkingEffort: 'high' },
    },
  },
];

describe('isModelTriple', () => {
  it('accepts a full triple and rejects the string bindings', () => {
    expect(
      isModelTriple({
        backend: 'claude-code',
        model: 'sonnet',
        thinkingEffort: 'high',
      }),
    ).toBe(true);
    expect(isModelTriple('inherit')).toBe(false);
    expect(isModelTriple('off')).toBe(false);
    expect(isModelTriple({ backend: 'claude-code' })).toBe(false);
    expect(isModelTriple(null)).toBe(false);
  });
});

describe('toModelTriple', () => {
  it('fills defaults for a partial triple', () => {
    expect(toModelTriple({ backend: 'codex' })).toEqual({
      backend: 'codex',
      model: 'default',
      thinkingEffort: 'default',
    });
  });
});

describe('normalizeRoleBinding', () => {
  it('keeps triples and the two string bindings, and falls back to inherit', () => {
    expect(normalizeRoleBinding('off')).toBe('off');
    expect(normalizeRoleBinding('inherit')).toBe('inherit');
    expect(normalizeRoleBinding(undefined)).toBe('inherit');
    // a legacy preset-id binding is no longer meaningful
    expect(normalizeRoleBinding('p-sonnet')).toBe('inherit');
    expect(
      normalizeRoleBinding({
        backend: 'codex',
        model: 'gpt-5',
        thinkingEffort: 'low',
      }),
    ).toEqual({ backend: 'codex', model: 'gpt-5', thinkingEffort: 'low' });
  });
});

describe('resolveModelForRole', () => {
  it('resolves a role bound to an inline triple', () => {
    const resolved = resolveModelForRole({
      role: 'summary',
      activeProfileId: 'anthropic',
      profiles,
    });

    expect(resolved).toMatchObject({
      backend: 'claude-code',
      model: 'haiku',
      thinkingEffort: 'default',
      source: 'profile',
      profileId: 'anthropic',
    });
    expect(resolved.blocked).toBeUndefined();
  });

  it('follows the inherit chain up to the agent role', () => {
    const resolved = resolveModelForRole({
      role: 'memory',
      activeProfileId: 'anthropic',
      profiles,
    });

    expect(resolved).toMatchObject({
      backend: 'claude-code',
      model: 'sonnet',
      thinkingEffort: 'high',
      source: 'profile',
      profileId: 'anthropic',
    });
  });

  it('treats an unset role as inherit', () => {
    const resolved = resolveModelForRole({
      role: 'pr-review',
      activeProfileId: 'codex',
      profiles,
    });

    expect(resolved).toMatchObject({ backend: 'codex', model: 'gpt-5' });
  });

  it('treats an unknown role id as inherit', () => {
    const resolved = resolveModelForRole({
      role: 'totally-new-role' as ModelRole,
      activeProfileId: 'anthropic',
      profiles,
    });

    expect(resolved).toMatchObject({ backend: 'claude-code', model: 'sonnet' });
    expect(resolved.blocked).toBeUndefined();
  });

  it('does not loop when the agent role itself inherits', () => {
    const resolved = resolveModelForRole({
      role: 'agent',
      activeProfileId: 'loop',
      profiles: [
        {
          id: 'loop',
          name: 'Loop',
          presets: [],
          quickPresetIds: [],
          roles: { agent: 'inherit' },
        },
      ],
      fallback: { backend: 'claude-code' },
    });

    expect(resolved.source).toBe('fallback');
    expect(resolved.backend).toBe('claude-code');
  });

  it('returns a disabled result for an off binding on an optional role', () => {
    const resolved = resolveModelForRole({
      role: 'completion',
      activeProfileId: 'anthropic',
      profiles,
    });

    expect(resolved.off).toBe(true);
    expect(resolved.blocked).toBeUndefined();
  });

  it('rejects an off binding on a role that cannot be off', () => {
    const resolved = resolveModelForRole({
      role: 'agent',
      activeProfileId: 'broken',
      profiles: [
        {
          id: 'broken',
          name: 'Broken',
          presets: [],
          quickPresetIds: [],
          roles: { agent: 'off' },
        },
      ],
      fallback: { backend: 'claude-code' },
    });

    expect(resolved.off).not.toBe(true);
    expect(resolved.blocked?.reason).toBe('role-off');
    expect(resolved.backend).toBe('claude-code');
  });

  it('falls back when there is no active profile', () => {
    const resolved = resolveModelForRole({
      role: 'agent',
      profiles,
      fallback: { backend: 'claude-code', model: 'sonnet' },
    });

    expect(resolved.source).toBe('fallback');
    expect(resolved.model).toBe('sonnet');
  });

  describe('policy', () => {
    it('enforce blocks a disallowed backend', () => {
      const resolved = resolveModelForRole({
        role: 'agent',
        activeProfileId: 'codex',
        profiles,
        policy: { mode: 'enforce', allowedBackends: ['claude-code'] },
        fallback: { backend: 'claude-code' },
      });

      expect(resolved.blocked?.reason).toBe('backend-not-allowed');
      expect(resolved.blocked?.allowed.backends).toEqual(['claude-code']);
      expect(resolved.blocked?.message).toContain('codex');
      expect(resolved.backend).toBe('claude-code');
      expect(resolved.source).toBe('policy');
    });

    it('enforce blocks a profile outside allowedProfileIds', () => {
      const resolved = resolveModelForRole({
        role: 'agent',
        activeProfileId: 'codex',
        profiles,
        policy: { mode: 'enforce', allowedProfileIds: ['anthropic'] },
        fallback: { backend: 'claude-code' },
      });

      expect(resolved.blocked?.reason).toBe('profile-not-allowed');
      expect(resolved.blocked?.allowed.profileIds).toEqual(['anthropic']);
      expect(resolved.source).toBe('policy');
      expect(resolved.backend).toBe('claude-code');
    });

    it('enforce allows a profile inside allowedProfileIds', () => {
      const resolved = resolveModelForRole({
        role: 'agent',
        activeProfileId: 'codex',
        profiles,
        policy: { mode: 'enforce', allowedProfileIds: ['codex'] },
      });

      expect(resolved.blocked).toBeUndefined();
      expect(resolved.backend).toBe('codex');
    });

    it('enforce blocks a step override that names a disallowed backend', () => {
      const resolved = resolveModelForRole({
        role: 'agent',
        activeProfileId: 'anthropic',
        profiles,
        policy: { mode: 'enforce', allowedBackends: ['claude-code'] },
        override: { backend: 'codex', model: 'gpt-5' },
        fallback: { backend: 'claude-code' },
      });

      expect(resolved.blocked?.reason).toBe('backend-not-allowed');
    });

    it('a policy can only restrict, never grant a disabled backend', () => {
      const resolved = resolveModelForRole({
        role: 'agent',
        activeProfileId: 'codex',
        profiles,
        enabledBackends: ['claude-code'],
        policy: { mode: 'enforce', allowedBackends: ['claude-code', 'codex'] },
        fallback: { backend: 'claude-code' },
      });

      expect(resolved.blocked?.reason).toBe('backend-not-allowed');
      expect(resolved.blocked?.allowed.backends).toEqual(['claude-code']);
    });

    it('enforce pins the policy profile over the active one', () => {
      const resolved = resolveModelForRole({
        role: 'agent',
        activeProfileId: 'anthropic',
        profiles,
        policy: { mode: 'enforce', pinnedProfileId: 'codex' },
      });

      expect(resolved).toMatchObject({
        backend: 'codex',
        model: 'gpt-5',
        source: 'policy',
        profileId: 'codex',
      });
    });

    it('enforce reports a missing pinned profile', () => {
      const resolved = resolveModelForRole({
        role: 'agent',
        activeProfileId: 'anthropic',
        profiles,
        policy: { mode: 'enforce', pinnedProfileId: 'nope' },
        fallback: { backend: 'claude-code' },
      });

      expect(resolved.blocked?.reason).toBe('no-profile');
      expect(resolved.source).toBe('fallback');
    });

    it('prefer pins a profile but still allows an override', () => {
      const pinned = resolveModelForRole({
        role: 'agent',
        activeProfileId: 'anthropic',
        profiles,
        policy: { mode: 'prefer', pinnedProfileId: 'codex' },
      });

      expect(pinned).toMatchObject({
        backend: 'codex',
        model: 'gpt-5',
        source: 'policy',
        profileId: 'codex',
      });

      const overridden = resolveModelForRole({
        role: 'agent',
        activeProfileId: 'anthropic',
        profiles,
        policy: {
          mode: 'prefer',
          pinnedProfileId: 'codex',
          allowedBackends: ['codex'],
          allowedProfileIds: ['codex'],
        },
        override: { backend: 'claude-code', model: 'sonnet' },
      });

      expect(overridden).toMatchObject({
        backend: 'claude-code',
        model: 'sonnet',
        source: 'override',
      });
      expect(overridden.blocked).toBeUndefined();
    });

    it('inherit mode ignores policy allow lists', () => {
      const resolved = resolveModelForRole({
        role: 'agent',
        activeProfileId: 'codex',
        profiles,
        policy: {
          mode: 'inherit',
          allowedBackends: ['claude-code'],
          allowedProfileIds: ['anthropic'],
        },
      });

      expect(resolved.backend).toBe('codex');
      expect(resolved.blocked).toBeUndefined();
    });
  });

  describe('overrides', () => {
    it('applies an override naming a preset of the active profile', () => {
      const resolved = resolveModelForRole({
        role: 'agent',
        activeProfileId: 'anthropic',
        profiles,
        override: { presetId: 'p-gpt5' },
      });

      expect(resolved).toMatchObject({
        backend: 'codex',
        model: 'gpt-5',
        source: 'override',
        presetId: 'p-gpt5',
      });
    });

    it('layers a partial override over the profile result', () => {
      const resolved = resolveModelForRole({
        role: 'agent',
        activeProfileId: 'anthropic',
        profiles,
        override: { thinkingEffort: 'low' },
      });

      expect(resolved).toMatchObject({
        backend: 'claude-code',
        model: 'sonnet',
        thinkingEffort: 'low',
        source: 'override',
      });
    });
  });

  it('normalizes an unsupported thinking effort for the model', () => {
    const resolved = resolveModelForRole({
      role: 'agent',
      activeProfileId: 'x',
      profiles: [
        {
          id: 'x',
          name: 'X',
          presets: [],
          quickPresetIds: [],
          roles: {
            agent: {
              backend: 'claude-code',
              model: 'sonnet',
              thinkingEffort: 'xhigh',
            },
          },
        },
      ],
    });

    expect(resolved.thinkingEffort).toBe('default');
  });

  it('is pure — it does not mutate its inputs', () => {
    const snapshot = JSON.stringify(profiles);
    resolveModelForRole({
      role: 'summary',
      activeProfileId: 'anthropic',
      profiles,
      policy: { mode: 'enforce', allowedBackends: ['claude-code'] },
    });
    expect(JSON.stringify(profiles)).toBe(snapshot);
  });
});

describe('image roles', () => {
  const imageProfiles: ModelProfile[] = [
    {
      id: 'imgs',
      name: 'Images',
      presets: [],
      quickPresetIds: [],
      roles: {
        agent: {
          backend: 'claude-code',
          model: 'sonnet',
          thinkingEffort: 'high',
        },
        'project-logo': { imageModel: 'gpt-image-1' },
      },
    },
    {
      id: 'no-logo',
      name: 'No logo',
      presets: [],
      quickPresetIds: [],
      roles: {
        agent: { backend: 'codex', model: 'gpt-5', thinkingEffort: 'high' },
        'project-logo': 'off',
      },
    },
    {
      id: 'wrong-kind',
      name: 'Wrong kind',
      presets: [],
      quickPresetIds: [],
      roles: {
        'project-logo': {
          backend: 'claude-code',
          model: 'sonnet',
          thinkingEffort: 'high',
        },
      },
    },
  ];

  it('marks project-logo as an image role and feature-map as a chat role', () => {
    expect(getRoleDefinition('project-logo')?.modelKind).toBe('image');
    const featureMap = getRoleDefinition('project-feature-map');
    expect(featureMap).toBeDefined();
    expect(featureMap?.modelKind).toBeUndefined();
    expect(featureMap?.canBeOff).toBe(true);
    expect(featureMap?.slotId).toBe('project-feature-map');
    expect(roleForSkillSlot('project-feature-map')).toBe('project-feature-map');
  });

  it('gives every AI skill slot its own named role', () => {
    // AI Generation now owns only the prompt; the model comes from the role, so
    // every slot needs a role of its own or it loses configurability.
    const slotKeys: AiSkillSlotKey[] = [
      'merge-commit-message',
      'commit-message',
      'pr-description',
      'task-name',
      'verification-note',
      'project-summary',
      'project-feature-map',
      'work-item-summary',
      'logo-generation',
    ];
    for (const slotKey of slotKeys) {
      expect(roleForSkillSlot(slotKey)).not.toBe('ai-generation');
    }
    expect(roleForSkillSlot('merge-commit-message')).toBe(
      'merge-commit-message',
    );
    expect(roleForSkillSlot('verification-note')).toBe('verification-note');
  });

  it('defines the merge-commit-message and verification-note roles', () => {
    for (const role of ['merge-commit-message', 'verification-note'] as const) {
      const definition = getRoleDefinition(role);
      expect(definition).toBeDefined();
      expect(definition?.canBeOff).toBe(true);
      expect(definition?.modelKind).toBeUndefined();
      expect(definition?.slotId).toBe(role);
      expect(definition?.label).toBeTruthy();
      expect(definition?.description).toBeTruthy();
    }
  });

  it('guards and normalizes image bindings', () => {
    expect(isImageModelBinding({ imageModel: 'gpt-image-1' })).toBe(true);
    expect(isImageModelBinding({ imageModel: '' })).toBe(false);
    expect(
      isImageModelBinding({
        backend: 'claude-code',
        model: 'sonnet',
        thinkingEffort: 'high',
      }),
    ).toBe(false);
    expect(isImageModelBinding('off')).toBe(false);
    expect(normalizeRoleBinding({ imageModel: 'gpt-image-1' })).toEqual({
      imageModel: 'gpt-image-1',
    });
  });

  it('resolves a bound image model', () => {
    expect(
      resolveImageModelForRole({
        role: 'project-logo',
        profiles: imageProfiles,
        activeProfileId: 'imgs',
        fallbackModel: 'gpt-image-0',
      }),
    ).toEqual({
      imageModel: 'gpt-image-1',
      off: false,
      profileId: 'imgs',
    });
  });

  it('falls back to the supplied default when unset, and when the binding is a chat triple', () => {
    expect(
      resolveImageModelForRole({
        role: 'project-logo',
        profiles: imageProfiles,
        activeProfileId: 'codex-missing',
        fallbackModel: 'gpt-image-0',
      }),
    ).toEqual({ imageModel: 'gpt-image-0', off: false });
    // a chat binding on an image role is rejected, never coerced
    expect(
      resolveImageModelForRole({
        role: 'project-logo',
        profiles: imageProfiles,
        activeProfileId: 'wrong-kind',
        fallbackModel: 'gpt-image-0',
      }),
    ).toEqual({ imageModel: 'gpt-image-0', off: false });
  });

  it('disables the feature on off', () => {
    expect(
      resolveImageModelForRole({
        role: 'project-logo',
        profiles: imageProfiles,
        activeProfileId: 'no-logo',
        fallbackModel: 'gpt-image-0',
      }),
    ).toEqual({ imageModel: null, off: true, profileId: 'no-logo' });
  });

  it('applies policy: pinned profile beats active and enforce blocks disallowed profiles', () => {
    expect(
      resolveImageModelForRole({
        role: 'project-logo',
        profiles: imageProfiles,
        activeProfileId: 'imgs',
        policy: { mode: 'prefer', pinnedProfileId: 'no-logo' },
        fallbackModel: 'gpt-image-0',
      }),
    ).toEqual({ imageModel: null, off: true, profileId: 'no-logo' });

    // Image and chat resolution must select the SAME profile. Under `enforce`
    // with an allow-list the chat side falls forward onto a permitted profile;
    // this one used to keep the disallowed active profile and refuse, naming a
    // profile that was no longer effective anywhere else in the app.
    const fellForward = resolveImageModelForRole({
      role: 'project-logo',
      profiles: imageProfiles,
      activeProfileId: 'imgs',
      policy: { mode: 'enforce', allowedProfileIds: ['no-logo'] },
      fallbackModel: 'gpt-image-0',
    });
    expect(fellForward.blocked).toBeUndefined();
    expect(fellForward.profileId).toBe('no-logo');
    // `no-logo` turns the role off, which is the permitted profile's own choice
    expect(fellForward.off).toBe(true);

    // With no permitted profile at all it still refuses.
    const blocked = resolveImageModelForRole({
      role: 'project-logo',
      profiles: imageProfiles,
      activeProfileId: 'imgs',
      policy: { mode: 'enforce', allowedProfileIds: ['nobody'] },
      fallbackModel: 'gpt-image-0',
    });
    expect(blocked.blocked?.reason).toBe('profile-not-allowed');

    const missingPin = resolveImageModelForRole({
      role: 'project-logo',
      profiles: imageProfiles,
      activeProfileId: 'imgs',
      policy: { mode: 'enforce', pinnedProfileId: 'gone' },
      fallbackModel: 'gpt-image-0',
    });
    expect(missingPin.blocked?.reason).toBe('no-profile');
  });

  it('never lets an image binding leak out of the chat resolver', () => {
    const resolved = resolveModelForRole({
      role: 'project-logo',
      profiles: imageProfiles,
      activeProfileId: 'imgs',
      fallback: { backend: 'claude-code', model: 'opus' },
    });
    expect(resolved).not.toHaveProperty('imageModel');
    // image binding is unusable for chat: falls through to `agent`
    expect(resolved.backend).toBe('claude-code');
    expect(resolved.model).toBe('sonnet');
  });
});

// An override picks a triple, not a profile. Dropping `profileId` here made
// every override look profile-less to an `allowedProfileIds` check, which
// blocked every session in an `enforce` project — including on the very
// profile the policy allows.
// The pickers have always read an empty allow-list as "unrestricted". The
// resolver read it as "nothing is allowed", so a policy the UI showed as
// open blocked every single resolution.
// `prefer` pins a starting point, not a restriction (design section 2/9).
// Deleting the pinned profile must not make every run in the project fail.
describe('a dangling pin', () => {
  const profile = {
    id: 'active',
    name: 'Anthropic',
    presets: [],
    quickPresetIds: [],
    roles: {
      agent: {
        backend: 'claude-code' as const,
        model: 'sonnet',
        thinkingEffort: 'high' as const,
      },
    },
  };

  it('falls back to the active profile under prefer', () => {
    const resolved = resolveModelForRole({
      role: 'agent',
      profiles: [profile],
      activeProfileId: 'active',
      enabledBackends: ['claude-code'],
      policy: { mode: 'prefer', pinnedProfileId: 'deleted' },
    });

    expect(resolved.blocked).toBeUndefined();
    expect(resolved.model).toBe('sonnet');
  });

  it('still blocks under enforce', () => {
    const resolved = resolveModelForRole({
      role: 'agent',
      profiles: [profile],
      activeProfileId: 'active',
      enabledBackends: ['claude-code'],
      policy: { mode: 'enforce', pinnedProfileId: 'deleted' },
    });

    expect(resolved.blocked?.reason).toBe('no-profile');
  });
});

describe('an empty allow-list means unrestricted', () => {
  const profile = {
    id: 'p1',
    name: 'Anthropic',
    presets: [],
    quickPresetIds: [],
    roles: {
      agent: {
        backend: 'claude-code' as const,
        model: 'sonnet',
        thinkingEffort: 'high' as const,
      },
    },
  };

  it('does not block on an empty allowedProfileIds', () => {
    const resolved = resolveModelForRole({
      role: 'agent',
      profiles: [profile],
      activeProfileId: 'p1',
      enabledBackends: ['claude-code'],
      policy: { mode: 'enforce', allowedProfileIds: [] },
    });

    expect(resolved.blocked).toBeUndefined();
    expect(resolved.backend).toBe('claude-code');
  });

  it('does not block on an empty allowedBackends', () => {
    const resolved = resolveModelForRole({
      role: 'agent',
      profiles: [profile],
      activeProfileId: 'p1',
      enabledBackends: ['claude-code'],
      policy: { mode: 'enforce', allowedBackends: [] },
    });

    expect(resolved.blocked).toBeUndefined();
    expect(resolved.backend).toBe('claude-code');
  });

  it('agrees with listSelectableProfiles, which already allowed everything', () => {
    const policy = { mode: 'enforce' as const, allowedProfileIds: [] };
    expect(listSelectableProfiles({ profiles: [profile], policy })).toHaveLength(
      1,
    );
    expect(
      resolveModelForRole({
        role: 'agent',
        profiles: [profile],
        activeProfileId: 'p1',
        enabledBackends: ['claude-code'],
        policy,
      }).blocked,
    ).toBeUndefined();
  });
});

describe('override keeps the profile it was applied to', () => {
  const profile = {
    id: 'p1',
    name: 'Anthropic',
    presets: [],
    quickPresetIds: [],
    roles: {
      agent: {
        backend: 'claude-code' as const,
        model: 'sonnet',
        thinkingEffort: 'high' as const,
      },
    },
  };

  it('reports profileId when a step override applies', () => {
    const resolved = resolveModelForRole({
      role: 'agent',
      profiles: [profile],
      activeProfileId: 'p1',
      enabledBackends: ['claude-code'],
      override: { backend: 'claude-code', model: 'opus' },
    });

    expect(resolved.source).toBe('override');
    expect(resolved.profileId).toBe('p1');
  });

  it('still permits the profile under enforce + allowedProfileIds', () => {
    const resolved = resolveModelForRole({
      role: 'agent',
      profiles: [profile],
      activeProfileId: 'p1',
      enabledBackends: ['claude-code'],
      policy: { mode: 'enforce', allowedProfileIds: ['p1'] },
      override: { backend: 'claude-code', model: 'opus' },
    });

    expect(resolved.blocked).toBeUndefined();
    expect(resolved.profileId).toBe('p1');
  });

  // The allow-list is checked against the PROFILE, before any derivation, so
  // it must hold even when the role resolves through the fallback and there
  // is no `profileId` to key on. Re-checking a derived id downstream is what
  // refused sessions on an allowed profile.
  it('permits an allowed profile whose agent role is unset', () => {
    const unbound = { ...profile, roles: {} };

    const resolved = resolveModelForRole({
      role: 'agent',
      profiles: [unbound],
      activeProfileId: 'p1',
      enabledBackends: ['claude-code'],
      policy: { mode: 'enforce', allowedProfileIds: ['p1'] },
      override: { backend: 'claude-code' },
    });

    expect(resolved.blocked).toBeUndefined();
  });

  it('still refuses a profile the allow-list excludes', () => {
    const resolved = resolveModelForRole({
      role: 'agent',
      profiles: [profile],
      activeProfileId: 'p1',
      enabledBackends: ['claude-code'],
      policy: { mode: 'enforce', allowedProfileIds: ['someone-else'] },
      override: { backend: 'claude-code', model: 'opus' },
    });

    expect(resolved.blocked?.reason).toBe('profile-not-allowed');
  });
});

describe('pickEffectiveProfile', () => {
  const pickProfiles: ModelProfile[] = [
    { id: 'a', name: 'A', presets: [], quickPresetIds: [], roles: {} },
    { id: 'b', name: 'B', presets: [], quickPresetIds: [], roles: {} },
    { id: 'c', name: 'C', presets: [], quickPresetIds: [], roles: {} },
  ];

  it('returns the active profile without a policy or under inherit', () => {
    expect(
      pickEffectiveProfile({ profiles: pickProfiles, activeProfileId: 'b' })?.id,
    ).toBe('b');
    expect(
      pickEffectiveProfile({
        profiles: pickProfiles,
        activeProfileId: 'b',
        policy: { mode: 'inherit', pinnedProfileId: 'c', allowedProfileIds: ['c'] },
      })?.id,
    ).toBe('b');
  });

  it('returns null when nothing is active and nothing is pinned', () => {
    expect(
      pickEffectiveProfile({ profiles: pickProfiles, activeProfileId: null }),
    ).toBeNull();
  });

  it('prefers the pin over an allow-list', () => {
    expect(
      pickEffectiveProfile({
        profiles: pickProfiles,
        activeProfileId: 'a',
        policy: {
          mode: 'enforce',
          pinnedProfileId: 'c',
          allowedProfileIds: ['b'],
        },
      })?.id,
    ).toBe('c');
  });

  it('lands on the first allowed profile in `profiles` order under enforce', () => {
    expect(
      pickEffectiveProfile({
        profiles: pickProfiles,
        activeProfileId: 'a',
        policy: { mode: 'enforce', allowedProfileIds: ['c', 'b'] },
      })?.id,
    ).toBe('b');
  });

  it('keeps the active profile when it is already allowed', () => {
    expect(
      pickEffectiveProfile({
        profiles: pickProfiles,
        activeProfileId: 'c',
        policy: { mode: 'enforce', allowedProfileIds: ['b', 'c'] },
      })?.id,
    ).toBe('c');
  });

  it('does not apply the allow-list under prefer', () => {
    expect(
      pickEffectiveProfile({
        profiles: pickProfiles,
        activeProfileId: 'a',
        policy: { mode: 'prefer', allowedProfileIds: ['b'] },
      })?.id,
    ).toBe('a');
  });

  it('falls back to the active profile when the allow-list names nothing that exists', () => {
    expect(
      pickEffectiveProfile({
        profiles: pickProfiles,
        activeProfileId: 'a',
        policy: { mode: 'enforce', allowedProfileIds: ['ghost'] },
      })?.id,
    ).toBe('a');
    expect(
      pickEffectiveProfile({
        profiles: pickProfiles,
        activeProfileId: 'a',
        policy: { mode: 'enforce', pinnedProfileId: 'ghost' },
      })?.id,
    ).toBe('a');
  });
});

describe('listSelectableProfiles', () => {
  const pickProfiles: ModelProfile[] = [
    {
      id: 'a',
      name: 'A',
      presets: [],
      quickPresetIds: [],
      roles: {
        agent: { backend: 'claude-code', model: 'sonnet', thinkingEffort: 'high' },
      },
    },
    {
      id: 'b',
      name: 'B',
      presets: [],
      quickPresetIds: [],
      roles: {
        agent: { backend: 'codex', model: 'gpt-5', thinkingEffort: 'high' },
      },
    },
  ];

  it('returns every profile without a policy or under prefer', () => {
    expect(listSelectableProfiles({ profiles: pickProfiles })).toEqual(
      pickProfiles,
    );
    expect(
      listSelectableProfiles({
        profiles: pickProfiles,
        policy: { mode: 'prefer', allowedProfileIds: ['a'], pinnedProfileId: 'a' },
      }),
    ).toEqual(pickProfiles);
  });

  it('keeps only allowed profiles under enforce', () => {
    expect(
      listSelectableProfiles({
        profiles: pickProfiles,
        policy: { mode: 'enforce', allowedProfileIds: ['b'] },
      }).map((profile) => profile.id),
    ).toEqual(['b']);
  });

  it('keeps only the pinned profile under enforce', () => {
    expect(
      listSelectableProfiles({
        profiles: pickProfiles,
        policy: { mode: 'enforce', pinnedProfileId: 'a' },
      }).map((profile) => profile.id),
    ).toEqual(['a']);
  });

  it('drops profiles whose agent backend is not allowed under enforce', () => {
    expect(
      listSelectableProfiles({
        profiles: pickProfiles,
        policy: { mode: 'enforce', allowedBackends: ['claude-code'] },
      }).map((profile) => profile.id),
    ).toEqual(['a']);
  });

  it('falls back to every profile rather than an empty menu', () => {
    expect(
      listSelectableProfiles({
        profiles: pickProfiles,
        policy: { mode: 'enforce', allowedProfileIds: ['ghost'] },
      }),
    ).toEqual(pickProfiles);
  });
});

// --- Revision 2: a role may bind to a preset BY REFERENCE ---
//
// Copy-semantics (revision 1) made editing a preset a no-op for every role it
// had been applied to. A `{ presetId }` binding follows the preset live; the
// dangling-reference risk copy-semantics existed to avoid is handled by the
// editor inlining a preset's triple on delete.
describe('preset-reference bindings', () => {
  const withPreset = (model: string): ModelProfile[] => [
    {
      id: 'p',
      name: 'P',
      presets: [
        {
          id: 'fast',
          name: 'Fast',
          backend: 'claude-code',
          model,
          thinkingEffort: 'default',
        },
      ],
      quickPresetIds: [],
      roles: {
        agent: {
          backend: 'claude-code',
          model: 'sonnet',
          thinkingEffort: 'high',
        },
        summary: { presetId: 'fast' },
        memory: { backend: 'codex', model: 'gpt-5', thinkingEffort: 'low' },
      },
    },
  ];

  it('is preserved by normalizeRoleBinding', () => {
    expect(normalizeRoleBinding({ presetId: 'fast' })).toEqual({
      presetId: 'fast',
    });
    expect(normalizeRoleBinding({ presetId: '' })).toBe('inherit');
  });

  it('is recognised by isPresetRefBinding only', () => {
    expect(isPresetRefBinding({ presetId: 'fast' })).toBe(true);
    expect(isPresetRefBinding('fast')).toBe(false);
    expect(isModelTriple({ presetId: 'fast' })).toBe(false);
    expect(isImageModelBinding({ presetId: 'fast' })).toBe(false);
  });

  it('resolves through the profile own presets', () => {
    expect(
      resolveModelForRole({
        role: 'summary',
        activeProfileId: 'p',
        profiles: withPreset('haiku'),
      }),
    ).toMatchObject({
      backend: 'claude-code',
      model: 'haiku',
      source: 'profile',
      profileId: 'p',
    });
  });

  // The headline behaviour: the preset is a shared definition.
  it('follows an edit of the preset it points at', () => {
    expect(
      resolveModelForRole({
        role: 'summary',
        activeProfileId: 'p',
        profiles: withPreset('opus'),
      }).model,
    ).toBe('opus');
  });

  it('leaves an inline triple untouched when the preset changes', () => {
    expect(
      resolveModelForRole({
        role: 'memory',
        activeProfileId: 'p',
        profiles: withPreset('opus'),
      }).model,
    ).toBe('gpt-5');
  });

  // Unreachable once deletion inlines, but it must degrade, never throw.
  it('degrades to inherit when the preset id does not exist', () => {
    const broken = withPreset('haiku');
    broken[0].roles.summary = { presetId: 'gone' };
    const resolved = resolveModelForRole({
      role: 'summary',
      activeProfileId: 'p',
      profiles: broken,
    });
    expect(resolved.model).toBe('sonnet');
    expect(resolved.thinkingEffort).toBe('high');
  });

  it('is not a valid binding for an image role', () => {
    const imageProfile: ModelProfile[] = [
      {
        id: 'p',
        name: 'P',
        presets: [
          {
            id: 'fast',
            name: 'Fast',
            backend: 'claude-code',
            model: 'haiku',
            thinkingEffort: 'default',
          },
        ],
        quickPresetIds: [],
        roles: { 'project-logo': { presetId: 'fast' } },
      },
    ];
    expect(
      resolveImageModelForRole({
        role: 'project-logo',
        profiles: imageProfile,
        activeProfileId: 'p',
        fallbackModel: 'gpt-image-1',
      }),
    ).toEqual({ imageModel: 'gpt-image-1', off: false });
  });
});
