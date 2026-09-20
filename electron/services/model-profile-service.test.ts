import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ModelProfile,
  ProjectModelPolicy,
  ResolvedModel,
  ResolveModelForRoleParams,
} from '@shared/model-profiles';
import type { AppSettings } from '@shared/types';

const resolveModelForRoleMock =
  vi.fn<(params: ResolveModelForRoleParams) => ResolvedModel>();

vi.mock('@shared/model-profiles', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    resolveModelForRole: (params: ResolveModelForRoleParams) =>
      resolveModelForRoleMock(params),
  };
});

import {
  createModelProfileService,
  type ModelProfileProject,
  type ModelProfileServiceDeps,
} from './model-profile-service';

const SONNET_PRESET = {
  id: 'preset-sonnet',
  name: 'Sonnet',
  backend: 'claude-code',
  model: 'sonnet',
  thinkingEffort: 'high',
} as const;

const GPT5_PRESET = {
  id: 'preset-gpt5',
  name: 'GPT-5',
  backend: 'codex',
  model: 'gpt-5',
  thinkingEffort: 'high',
} as const;

const PROFILES: ModelProfile[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    presets: [{ ...SONNET_PRESET }],
    quickPresetIds: [SONNET_PRESET.id],
    roles: {
      agent: {
        backend: SONNET_PRESET.backend,
        model: SONNET_PRESET.model,
        thinkingEffort: SONNET_PRESET.thinkingEffort,
      },
    },
  },
  {
    id: 'codex',
    name: 'Codex fallback',
    presets: [{ ...GPT5_PRESET }],
    quickPresetIds: [GPT5_PRESET.id],
    roles: {
      agent: {
        backend: GPT5_PRESET.backend,
        model: GPT5_PRESET.model,
        thinkingEffort: GPT5_PRESET.thinkingEffort,
      },
    },
  },
];

function makeDeps(
  overrides: {
    settings?: Partial<AppSettings>;
    project?: ModelProfileProject | null;
    policyFile?: ProjectModelPolicy | null;
  } = {},
) {
  const settings: Record<string, unknown> = {
    modelProfiles: PROFILES,
    activeModelProfileId: 'anthropic',
    modelFallbackOrder: [],
    backends: {
      defaultBackend: 'claude-code',
      enabledBackends: ['claude-code', 'codex'],
    },
    ...(overrides.settings as Record<string, unknown> | undefined),
  };

  const project: ModelProfileProject | null =
    overrides.project === undefined
      ? { id: 'p1', path: '/repo', modelPolicy: null }
      : overrides.project;

  const readPolicyFile = vi.fn(async () => overrides.policyFile ?? null);
  const setSetting = vi.fn(async (key: string, value: unknown) => {
    settings[key] = value;
  });

  const deps = {
    getSetting: (async (key: string) => settings[key]) as never,
    setSetting: setSetting as never,
    getProject: (async (id: string) =>
      project && project.id === id ? project : null) as never,
    readPolicyFile: readPolicyFile as never,
  } satisfies ModelProfileServiceDeps;

  return { deps, settings, readPolicyFile, setSetting };
}

beforeEach(() => {
  resolveModelForRoleMock.mockReset();
  resolveModelForRoleMock.mockReturnValue({
    backend: 'claude-code',
    model: 'sonnet',
    thinkingEffort: 'high',
    source: 'profile',
    profileId: 'anthropic',
    presetId: 'preset-sonnet',
  });
});

describe('getEffectivePolicy', () => {
  it('prefers the repo policy file over the database policy', async () => {
    const { deps } = makeDeps({
      project: {
        id: 'p1',
        path: '/repo',
        modelPolicy: JSON.stringify({
          mode: 'prefer',
          pinnedProfileId: 'codex',
        }),
      },
      policyFile: { mode: 'enforce', allowedBackends: ['claude-code'] },
    });
    const service = createModelProfileService(deps);

    const effective = await service.getEffectivePolicy({ projectId: 'p1' });

    expect(effective.source).toBe('file');
    expect(effective.policy).toEqual({
      mode: 'enforce',
      allowedBackends: ['claude-code'],
    });
    expect(effective.filePath).toBe('/repo/.jean-claude/model-policy.json');
  });

  it('falls back to the database policy, then to the default', async () => {
    const withRow = createModelProfileService(
      makeDeps({
        project: {
          id: 'p1',
          path: '/repo',
          modelPolicy: JSON.stringify({ mode: 'prefer' }),
        },
      }).deps,
    );
    expect(await withRow.getEffectivePolicy({ projectId: 'p1' })).toEqual({
      policy: { mode: 'prefer' },
      source: 'project',
    });

    const empty = createModelProfileService(makeDeps().deps);
    expect(await empty.getEffectivePolicy({ projectId: 'p1' })).toEqual({
      policy: { mode: 'inherit' },
      source: 'default',
    });

    const malformed = createModelProfileService(
      makeDeps({
        project: { id: 'p1', path: '/repo', modelPolicy: '{oops' },
      }).deps,
    );
    expect(
      (await malformed.getEffectivePolicy({ projectId: 'p1' })).source,
    ).toBe('default');
  });

  it('caches per project and re-reads after invalidation', async () => {
    const { deps, readPolicyFile } = makeDeps();
    const service = createModelProfileService(deps);

    await service.getEffectivePolicy({ projectId: 'p1' });
    await service.getEffectivePolicy({ projectId: 'p1' });
    expect(readPolicyFile).toHaveBeenCalledTimes(1);

    service.invalidateProjectPolicyCache({ projectId: 'p1' });
    await service.getEffectivePolicy({ projectId: 'p1' });
    expect(readPolicyFile).toHaveBeenCalledTimes(2);

    service.invalidateProjectPolicyCache();
    await service.getEffectivePolicy({ projectId: 'p1' });
    expect(readPolicyFile).toHaveBeenCalledTimes(3);
  });
});

describe('getEffectiveProfile', () => {
  it('returns the pinned profile for a project that pins one', async () => {
    for (const mode of ['prefer', 'enforce'] as const) {
      const service = createModelProfileService(
        makeDeps({ policyFile: { mode, pinnedProfileId: 'codex' } }).deps,
      );

      expect(await service.getEffectiveProfile({ projectId: 'p1' })).toEqual(
        PROFILES[1],
      );
    }
  });

  it('returns the globally active profile when nothing is pinned', async () => {
    const service = createModelProfileService(
      makeDeps({ policyFile: { mode: 'prefer' } }).deps,
    );

    expect(await service.getEffectiveProfile({ projectId: 'p1' })).toEqual(
      PROFILES[0],
    );
  });

  it('ignores a pinned profile in inherit mode', async () => {
    const service = createModelProfileService(
      makeDeps({
        policyFile: { mode: 'inherit', pinnedProfileId: 'codex' },
      }).deps,
    );

    expect(await service.getEffectiveProfile({ projectId: 'p1' })).toEqual(
      PROFILES[0],
    );
  });

  it('returns the globally active profile without a project id', async () => {
    const service = createModelProfileService(makeDeps().deps);

    expect(await service.getEffectiveProfile({})).toEqual(PROFILES[0]);
  });

  it('falls back to the active profile when the pinned one is unknown', async () => {
    const service = createModelProfileService(
      makeDeps({
        policyFile: { mode: 'enforce', pinnedProfileId: 'ghost' },
      }).deps,
    );

    expect(await service.getEffectiveProfile({ projectId: 'p1' })).toEqual(
      PROFILES[0],
    );
  });

  it('lands on the first allowed profile under enforce when the active one is not allowed', async () => {
    const service = createModelProfileService(
      makeDeps({
        policyFile: { mode: 'enforce', allowedProfileIds: ['codex'] },
      }).deps,
    );

    expect(await service.getEffectiveProfile({ projectId: 'p1' })).toEqual(
      PROFILES[1],
    );
  });

  it('keeps the active profile under prefer even with an allow-list', async () => {
    const service = createModelProfileService(
      makeDeps({
        policyFile: { mode: 'prefer', allowedProfileIds: ['codex'] },
      }).deps,
    );

    expect(await service.getEffectiveProfile({ projectId: 'p1' })).toEqual(
      PROFILES[0],
    );
  });

  it('prefers the pin over the allow-list', async () => {
    const service = createModelProfileService(
      makeDeps({
        policyFile: {
          mode: 'enforce',
          pinnedProfileId: 'codex',
          allowedProfileIds: ['anthropic'],
        },
      }).deps,
    );

    expect(await service.getEffectiveProfile({ projectId: 'p1' })).toEqual(
      PROFILES[1],
    );
  });

  it('returns null when nothing is active and nothing is pinned', async () => {
    const service = createModelProfileService(
      makeDeps({ settings: { activeModelProfileId: null } as never }).deps,
    );

    expect(await service.getEffectiveProfile({ projectId: 'p1' })).toBeNull();
  });
});

describe('resolveForRole', () => {
  it('passes the pinned profile and the policy to the shared resolver', async () => {
    const { deps } = makeDeps({
      policyFile: { mode: 'prefer', pinnedProfileId: 'codex' },
    });
    const service = createModelProfileService(deps);

    await service.resolveForRole({ role: 'summary', projectId: 'p1' });

    const params = resolveModelForRoleMock.mock.calls[0]?.[0];
    expect(params?.role).toBe('summary');
    expect(params?.activeProfileId).toBe('codex');
    expect(params?.profiles).toEqual(PROFILES);
    expect(params?.enabledBackends).toEqual(['claude-code', 'codex']);
  });

  // Selection and resolution must agree. `getEffectiveProfile` already fell
  // forward onto the first allowed profile under `enforce`; `resolveForRole`
  // re-derived `pinned ?? active` and skipped that, so the picker showed one
  // profile in effect while resolution used another and blocked.
  it('resolves with the same profile getEffectiveProfile reports', async () => {
    const { deps } = makeDeps({
      policyFile: { mode: 'enforce', allowedProfileIds: ['codex'] },
    });
    const service = createModelProfileService(deps);

    const effective = await service.getEffectiveProfile({ projectId: 'p1' });
    await service.resolveForRole({ role: 'agent', projectId: 'p1' });

    expect(effective?.id).toBe('codex');
    expect(resolveModelForRoleMock.mock.calls[0]?.[0].activeProfileId).toBe(
      'codex',
    );
  });

  it('uses the globally active profile when the policy does not pin one', async () => {
    const service = createModelProfileService(makeDeps().deps);

    await service.resolveForRole({ role: 'agent', projectId: 'p1' });

    expect(resolveModelForRoleMock.mock.calls[0]?.[0].activeProfileId).toBe(
      'anthropic',
    );
  });

  it('intersects allowed backends with the enabled backends', async () => {
    const { deps } = makeDeps({
      policyFile: {
        mode: 'enforce',
        allowedBackends: ['claude-code', 'opencode'],
      },
    });
    const service = createModelProfileService(deps);

    await service.resolveForRole({ role: 'agent', projectId: 'p1' });

    expect(
      resolveModelForRoleMock.mock.calls[0]?.[0].policy?.allowedBackends,
    ).toEqual(['claude-code']);
  });

  it('blocks under enforce when the resolver returns a disallowed backend', async () => {
    resolveModelForRoleMock.mockReturnValue({
      backend: 'codex',
      model: 'gpt-5',
      thinkingEffort: 'high',
      source: 'profile',
      profileId: 'codex',
      presetId: 'preset-gpt5',
    });
    const { deps } = makeDeps({
      policyFile: { mode: 'enforce', allowedBackends: ['claude-code'] },
    });
    const service = createModelProfileService(deps);

    const resolved = await service.resolveForRole({
      role: 'agent',
      projectId: 'p1',
    });

    expect(resolved.blocked?.reason).toBe('backend-not-allowed');
    expect(resolved.blocked?.allowed.backends).toEqual(['claude-code']);
  });

  // The service must DELEGATE profile enforcement, not re-implement it. It
  // used to re-check `resolved.profileId`, which is legitimately absent when
  // a role resolves through the fallback — so it refused sessions on the very
  // profile the policy allows. The real enforcement lives in
  // `resolveModelForRole` and is covered in `shared/model-profiles.test.ts`.
  it('passes allowedProfileIds to the resolver instead of re-checking it', async () => {
    const { deps } = makeDeps({
      policyFile: { mode: 'enforce', allowedProfileIds: ['anthropic'] },
    });
    const service = createModelProfileService(deps);
    // A result with no `profileId` — what the fallback path really produces.
    resolveModelForRoleMock.mockReturnValue({
      backend: 'claude-code',
      model: 'sonnet',
      thinkingEffort: 'high',
      source: 'fallback',
    });

    const resolved = await service.resolveForRole({
      role: 'agent',
      projectId: 'p1',
    });

    expect(
      resolveModelForRoleMock.mock.calls[0]?.[0].policy?.allowedProfileIds,
    ).toEqual(['anthropic']);
    // and it must NOT invent a block of its own
    expect(resolved.blocked).toBeUndefined();
  });

  it('blocks under enforce when the pinned profile does not exist', async () => {
    const { deps } = makeDeps({
      policyFile: { mode: 'enforce', pinnedProfileId: 'ghost' },
    });
    const service = createModelProfileService(deps);

    const resolved = await service.resolveForRole({
      role: 'agent',
      projectId: 'p1',
    });

    expect(resolved.blocked?.reason).toBe('profile-not-allowed');
    expect(resolveModelForRoleMock).not.toHaveBeenCalled();
  });

  it('does not block under prefer', async () => {
    resolveModelForRoleMock.mockReturnValue({
      backend: 'codex',
      model: 'gpt-5',
      thinkingEffort: 'high',
      source: 'profile',
      presetId: 'preset-gpt5',
    });
    const { deps } = makeDeps({
      policyFile: { mode: 'prefer', allowedBackends: ['claude-code'] },
    });
    const service = createModelProfileService(deps);

    const resolved = await service.resolveForRole({
      role: 'agent',
      projectId: 'p1',
    });

    expect(resolved.blocked).toBeUndefined();
  });

  it('resolves without a project using the default policy', async () => {
    const service = createModelProfileService(makeDeps().deps);

    await service.resolveForRole({ role: 'task-name' });

    expect(resolveModelForRoleMock.mock.calls[0]?.[0].policy).toEqual({
      mode: 'inherit',
    });
  });
});

describe('profiles and fallback', () => {
  it('lists profiles with their own presets and the active profile', async () => {
    const service = createModelProfileService(makeDeps().deps);

    expect(await service.listProfiles()).toEqual(PROFILES);
    expect((await service.listProfiles())[0]?.presets).toEqual([
      { ...SONNET_PRESET },
    ]);
    expect((await service.getActiveProfile())?.id).toBe('anthropic');
  });

  it('returns null when the active profile id is unknown', async () => {
    const service = createModelProfileService(
      makeDeps({ settings: { activeModelProfileId: 'ghost' } as never }).deps,
    );

    expect(await service.getActiveProfile()).toBeNull();
  });

  it('activates a profile and rejects unknown ids', async () => {
    const { deps, settings } = makeDeps();
    const service = createModelProfileService(deps);

    const activated = await service.activateProfile({ profileId: 'codex' });

    expect(activated.id).toBe('codex');
    expect(settings.activeModelProfileId).toBe('codex');
    await expect(
      service.activateProfile({ profileId: 'ghost' }),
    ).rejects.toThrow(/ghost/);
  });

  // `activateFallbackProfile` was removed: it re-derived the fallback with a
  // weaker predicate than `resolveBackend` had already used, and took no
  // projectId, so it bypassed the whole design-section-8 enforce check.
  // `RateLimitSwapService` now activates the candidate it already chose.
  it('exposes no fallback-activation shortcut that bypasses policy', () => {
    const service = createModelProfileService(makeDeps().deps);

    expect('activateFallbackProfile' in service).toBe(false);
  });
});
