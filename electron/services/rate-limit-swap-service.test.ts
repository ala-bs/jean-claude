import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
}));

vi.mock('../database/repositories/settings', () => ({
  SettingsRepository: {
    get: vi.fn(),
  },
}));

vi.mock('./agent-usage-service', () => ({
  agentUsageService: {
    getUsage: vi.fn(),
  },
}));

import type {
  EffectiveProjectModelPolicy,
  ModelProfile,
} from '../../shared/model-profiles';

import { agentUsageService } from './agent-usage-service';
import type { ModelProfileService } from './model-profile-service';
import { RateLimitSwapService } from './rate-limit-swap-service';

function makeUsage(utilization: number) {
  return {
    data: {
      limits: [
        {
          key: 'primary',
          label: 'Primary',
          isPrimary: true,
          range: {
            utilization: utilization * 100,
            resetsAt: new Date(),
            timeUntilReset: '10m',
            windowDurationMs: 300000,
          },
        },
      ],
    },
    error: null,
  };
}

const CLAUDE_TRIPLE = {
  backend: 'claude-code',
  model: 'sonnet',
  thinkingEffort: 'high',
} as const;

const CODEX_TRIPLE = {
  backend: 'codex',
  model: 'gpt-5',
  thinkingEffort: 'medium',
} as const;

const PROFILE_CLAUDE: ModelProfile = {
  id: 'anthropic',
  name: 'Anthropic',
  presets: [],
  quickPresetIds: [],
  roles: { agent: { ...CLAUDE_TRIPLE } },
};

const PROFILE_CODEX: ModelProfile = {
  id: 'codex-fallback',
  name: 'Codex fallback',
  presets: [],
  quickPresetIds: [],
  roles: { agent: { ...CODEX_TRIPLE } },
};

function createFakeProfileService(
  overrides: Partial<{
    fallbackOrder: string[];
    profiles: ModelProfile[];
    activeProfile: ModelProfile | null;
    policy: EffectiveProjectModelPolicy;
  }> = {},
) {
  const activateFallbackProfile = vi.fn(async () => PROFILE_CODEX);
  const activateProfile = vi.fn();
  const service = {
    listProfiles: async () =>
      overrides.profiles ?? [PROFILE_CLAUDE, PROFILE_CODEX],
    getActiveProfile: async () =>
      overrides.activeProfile === undefined
        ? PROFILE_CLAUDE
        : overrides.activeProfile,
    // Used instead of `getActiveProfile` when a `projectId` is supplied: a pin
    // or an explicit per-project pick can make them differ.
    getEffectiveProfile: async () =>
      overrides.activeProfile === undefined
        ? PROFILE_CLAUDE
        : overrides.activeProfile,
    activateProfile,
    getEffectivePolicy: async () =>
      overrides.policy ?? {
        policy: { mode: 'inherit' as const },
        source: 'default' as const,
      },
    resolveForRole: vi.fn(),
    getFallbackOrder: async () => overrides.fallbackOrder ?? ['codex-fallback'],
    activateFallbackProfile,
    invalidateProjectPolicyCache: vi.fn(),
  } as unknown as ModelProfileService;
  return { service, activateFallbackProfile, activateProfile };
}

function createService(
  overrides?: Parameters<typeof createFakeProfileService>[0],
) {
  const { service, activateFallbackProfile, activateProfile } =
    createFakeProfileService(overrides);
  return {
    swapService: new RateLimitSwapService({
      modelProfileService: () => service,
    }),
    activateFallbackProfile,
    activateProfile,
  };
}

describe('RateLimitSwapService (profile fallback)', () => {
  beforeEach(() => {
    vi.mocked(agentUsageService.getUsage).mockReset();
  });

  it('does not swap when the fallback order is empty', async () => {
    const { swapService } = createService({ fallbackOrder: [] });
    await expect(swapService.resolveBackend('claude-code')).resolves.toEqual({
      backend: 'claude-code',
      swapped: false,
    });
    expect(agentUsageService.getUsage).not.toHaveBeenCalled();
  });

  it('does not swap while the backend is under the threshold', async () => {
    vi.mocked(agentUsageService.getUsage).mockResolvedValue({
      'claude-code': makeUsage(0.5),
    });
    const { swapService } = createService();
    await expect(swapService.resolveBackend('claude-code')).resolves.toEqual({
      backend: 'claude-code',
      swapped: false,
    });
  });

  it('treats missing usage data as optimistic (no swap)', async () => {
    vi.mocked(agentUsageService.getUsage).mockResolvedValue({});
    const { swapService } = createService();
    const result = await swapService.resolveBackend('claude-code');
    expect(result.swapped).toBe(false);
  });

  it('preserves the fallback profile model and thinking effort', async () => {
    vi.mocked(agentUsageService.getUsage).mockResolvedValue({
      'claude-code': makeUsage(0.95),
    });
    const { swapService } = createService();
    const result = await swapService.resolveBackend('claude-code');
    expect(result).toEqual({
      backend: 'codex',
      model: 'gpt-5',
      thinkingEffort: 'medium',
      swapped: true,
      skippedDueToRateLimit: true,
      profileId: 'codex-fallback',
    });
  });

  it('skips profiles whose agent role stays on the limited backend', async () => {
    vi.mocked(agentUsageService.getUsage).mockResolvedValue({
      'claude-code': makeUsage(0.95),
    });
    const sameBackendProfile: ModelProfile = {
      id: 'claude-cheap',
      name: 'Claude cheap',
      presets: [],
      quickPresetIds: [],
      roles: { agent: { ...CLAUDE_TRIPLE } },
    };
    const { swapService } = createService({
      profiles: [PROFILE_CLAUDE, sameBackendProfile, PROFILE_CODEX],
      fallbackOrder: ['claude-cheap', 'codex-fallback'],
    });
    const result = await swapService.resolveBackend('claude-code');
    expect(result.profileId).toBe('codex-fallback');
    expect(result.backend).toBe('codex');
  });

  // A profile's agent role may follow one of its presets by reference; the
  // fallback must still see its backend, or that profile is silently skipped.
  it('uses a fallback profile whose agent role follows a preset', async () => {
    const presetBound: ModelProfile = {
      id: 'codex-preset',
      name: 'Codex via preset',
      presets: [{ id: 'p-codex', name: 'Codex', ...CODEX_TRIPLE }],
      quickPresetIds: ['p-codex'],
      roles: { agent: { presetId: 'p-codex' } },
    };
    vi.mocked(agentUsageService.getUsage).mockResolvedValue({
      'claude-code': makeUsage(0.95),
    });
    const { swapService } = createService({
      profiles: [PROFILE_CLAUDE, presetBound],
      fallbackOrder: ['codex-preset'],
    });

    const result = await swapService.resolveBackend('claude-code');

    expect(result.profileId).toBe('codex-preset');
    expect(result.backend).toBe('codex');
  });

  it('does not activate a profile unless asked (probe callers)', async () => {
    vi.mocked(agentUsageService.getUsage).mockResolvedValue({
      'claude-code': makeUsage(0.95),
    });
    const { swapService, activateFallbackProfile } = createService();
    await swapService.resolveBackend('claude-code');
    expect(activateFallbackProfile).not.toHaveBeenCalled();
  });

  // Activation must use the profile this call already selected. Re-deriving it
  // let a profile with no resolvable agent role win there but not here, so the
  // banner named one profile while another was activated.
  it('activates exactly the profile it reports switching to', async () => {
    vi.mocked(agentUsageService.getUsage).mockResolvedValue({
      'claude-code': makeUsage(0.95),
    });
    const blank: ModelProfile = {
      id: 'blank',
      name: 'No agent role',
      presets: [],
      quickPresetIds: [],
      roles: {},
    };
    const { swapService, activateProfile } = createService({
      profiles: [PROFILE_CLAUDE, blank, PROFILE_CODEX],
      fallbackOrder: ['blank', 'codex-fallback'],
    });

    const result = await swapService.resolveBackend('claude-code', {
      activate: true,
    });

    expect(result.profileId).toBe('codex-fallback');
    expect(activateProfile).toHaveBeenCalledWith({
      profileId: 'codex-fallback',
      projectId: null,
    });
  });

  it('blocks instead of falling back for an enforce project (design §8)', async () => {
    vi.mocked(agentUsageService.getUsage).mockResolvedValue({
      'claude-code': makeUsage(0.95),
    });
    const { swapService, activateFallbackProfile } = createService({
      policy: {
        policy: { mode: 'enforce', allowedBackends: ['claude-code'] },
        source: 'project',
      },
    });
    const result = await swapService.resolveBackend('claude-code', {
      activate: true,
      projectId: 'project-1',
    });
    expect(result.swapped).toBe(false);
    expect(result.backend).toBe('claude-code');
    expect(result.blocked?.reason).toBe('backend-not-allowed');
    expect(result.blocked?.allowedBackends).toEqual(['claude-code']);
    expect(activateFallbackProfile).not.toHaveBeenCalled();
  });

  // The guard used to inspect `allowedBackends` ONLY. The policy editor treats
  // profiles and backends as separate constraints, so "always run Anthropic"
  // stores a pin and NO allowedBackends — leaving the guard inert for exactly
  // the policies people actually write.
  it('blocks a swap away from the pinned profile (design §8)', async () => {
    vi.mocked(agentUsageService.getUsage).mockResolvedValue({
      'claude-code': makeUsage(0.95),
    });
    const { swapService, activateProfile } = createService({
      policy: {
        policy: { mode: 'enforce', pinnedProfileId: 'anthropic' },
        source: 'project',
      },
    });

    const result = await swapService.resolveBackend('claude-code', {
      activate: true,
      projectId: 'project-1',
    });

    expect(result.swapped).toBe(false);
    expect(result.blocked?.reason).toBe('profile-not-allowed');
    expect(result.blocked?.message).toContain('Anthropic');
    expect(activateProfile).not.toHaveBeenCalled();
  });

  it('blocks a swap to a profile outside the allow-list (design §8)', async () => {
    vi.mocked(agentUsageService.getUsage).mockResolvedValue({
      'claude-code': makeUsage(0.95),
    });
    const { swapService, activateProfile } = createService({
      policy: {
        policy: { mode: 'enforce', allowedProfileIds: ['anthropic'] },
        source: 'project',
      },
    });

    const result = await swapService.resolveBackend('claude-code', {
      activate: true,
      projectId: 'project-1',
    });

    expect(result.swapped).toBe(false);
    expect(result.blocked?.reason).toBe('profile-not-allowed');
    expect(result.blocked?.allowedProfileIds).toEqual(['anthropic']);
    expect(activateProfile).not.toHaveBeenCalled();
  });

  it('allows the swap when the fallback profile is itself permitted', async () => {
    vi.mocked(agentUsageService.getUsage).mockResolvedValue({
      'claude-code': makeUsage(0.95),
    });
    const { swapService } = createService({
      policy: {
        policy: {
          mode: 'enforce',
          allowedProfileIds: ['anthropic', 'codex-fallback'],
        },
        source: 'project',
      },
    });

    const result = await swapService.resolveBackend('claude-code', {
      projectId: 'project-1',
    });

    expect(result.swapped).toBe(true);
    expect(result.profileId).toBe('codex-fallback');
    expect(result.blocked).toBeUndefined();
  });

  it('falls back normally for a project in prefer mode', async () => {
    vi.mocked(agentUsageService.getUsage).mockResolvedValue({
      'claude-code': makeUsage(0.95),
    });
    const { swapService } = createService({
      policy: {
        policy: { mode: 'prefer', allowedBackends: ['claude-code'] },
        source: 'project',
      },
    });
    const result = await swapService.resolveBackend('claude-code', {
      projectId: 'project-1',
    });
    expect(result.swapped).toBe(true);
    expect(result.backend).toBe('codex');
    expect(result.blocked).toBeUndefined();
  });

  it('records the fallback against the project so a pick cannot undo it', async () => {
    // Regression: an explicit per-project profile pick beats the global active
    // profile in a `prefer` project. Activating globally only left the project
    // resolving the rate-limited profile while the banner announced a swap.
    vi.mocked(agentUsageService.getUsage).mockResolvedValue({
      'claude-code': makeUsage(0.95),
    });
    const { swapService, activateProfile } = createService({
      policy: {
        policy: { mode: 'prefer', pinnedProfileId: 'claude-default' },
        source: 'project',
      },
    });

    const result = await swapService.resolveBackend('claude-code', {
      projectId: 'project-1',
      activate: true,
    });

    expect(result.swapped).toBe(true);
    expect(activateProfile).toHaveBeenCalledWith({
      profileId: 'codex-fallback',
      projectId: 'project-1',
    });
  });

  it('reports the rate limit when no profile can take over', async () => {
    vi.mocked(agentUsageService.getUsage).mockResolvedValue({
      'claude-code': makeUsage(0.95),
    });
    const { swapService } = createService({
      profiles: [PROFILE_CLAUDE],
      fallbackOrder: ['anthropic'],
    });
    const result = await swapService.resolveBackend('claude-code');
    expect(result).toEqual({
      backend: 'claude-code',
      swapped: false,
      skippedDueToRateLimit: true,
    });
  });

  it('reset clears notification state', () => {
    const { swapService } = createService();
    expect(() => swapService.reset()).not.toThrow();
  });
});
