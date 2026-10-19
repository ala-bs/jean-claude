// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { ModelProfile, ProjectModelPolicy } from '@shared/model-profiles';

import { api } from '@/lib/api';
import { getQuickPresets } from '@/features/agent/utils-backend-model-selection';

import {
  PROJECT_MODEL_POLICY_QUERY_KEY,
  PROJECT_MODEL_PROFILE_SELECTIONS_QUERY_KEY,
  RESOLVED_MODEL_QUERY_KEY,
  useActivateModelProfile,
  useActiveModelProfile,
  useActiveModelProfileId,
  useEffectiveModelProfile,
  useModelProfilesSetting,
  useResolvedModelForRole,
  useUpdateModelProfiles,
} from './use-model-profiles';
import { useSetting } from './use-settings';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

const PROFILES: ModelProfile[] = [
    {
    id: 'anthropic',
    name: 'Anthropic',
    presets: [
      {
        id: 'anthropic-sonnet',
        name: 'Sonnet',
        backend: 'claude-code',
        model: 'sonnet',
        thinkingEffort: 'high',
      },
    ],
    quickPresetIds: ['anthropic-sonnet'],
    roles: { agent: { backend: 'claude-code', model: 'sonnet', thinkingEffort: 'high' } },
  },
    {
    id: 'codex',
    name: 'Codex fallback',
    presets: [
      {
        id: 'codex-gpt5',
        name: 'GPT-5',
        backend: 'opencode',
        model: 'gpt-5',
        thinkingEffort: 'low',
      },
    ],
    quickPresetIds: ['codex-gpt5'],
    roles: { agent: { backend: 'opencode', model: 'gpt-5', thinkingEffort: 'low' } },
  },
];

/**
 * Mocks the two IPC reads `useEffectiveModelProfile` depends on: the global
 * profile settings and a project's effective policy.
 */
function mockProfileApis({
  activeProfileId,
  policy,
}: {
  activeProfileId: string | null;
  policy?: ProjectModelPolicy;
}) {
  vi.spyOn(api.settings, 'get').mockImplementation(async (key: string) => {
    if (key === 'modelProfiles') return PROFILES as never;
    if (key === 'activeModelProfileId') return activeProfileId as never;
    return null as never;
  });
  vi.spyOn(api.projects, 'getEffectivePolicy').mockResolvedValue({
    policy: policy ?? { mode: 'inherit' },
    source: 'project',
  } as never);
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

async function render(client: QueryClient, Harness: () => null) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Harness),
      ),
    );
  });
}

// Editing a role changes what every `useResolvedModelForRole` consumer should
// show. Without the invalidation the task panel and skill-slot rows keep
// displaying the pre-edit model while the main process resolves the new one —
// a cache-key bug, invisible to the typechecker.
describe('useUpdateModelProfiles', () => {
  it('invalidates the resolved-model cache after a profile write', async () => {
    vi.spyOn(api.settings, 'set').mockResolvedValue(undefined as never);
    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    let result: ReturnType<typeof useUpdateModelProfiles> | undefined;
    await render(queryClient, function Harness() {
      result = useUpdateModelProfiles();
      return null;
    });

    await act(async () => {
      result?.mutate({ key: 'modelProfiles', value: PROFILES });
    });

    await act(async () => {
      await vi.waitFor(() =>
        expect(invalidate).toHaveBeenCalledWith(
          expect.objectContaining({ queryKey: RESOLVED_MODEL_QUERY_KEY }),
        ),
      );
    });
  });
});

describe('useActivateModelProfile', () => {
  it('optimistically updates a pinned project pick while activation is pending', async () => {
    let finish: (profile: ModelProfile) => void = () => {};
    vi.spyOn(api.modelProfiles, 'activate').mockImplementation(
      () => new Promise<ModelProfile>((resolve) => { finish = resolve; }),
    );
    const queryClient = makeQueryClient();
    queryClient.setQueryData(['settings', 'activeModelProfileId'], 'anthropic');
    queryClient.setQueryData(
      [...PROJECT_MODEL_POLICY_QUERY_KEY, 'project-1'],
      { policy: { mode: 'prefer', pinnedProfileId: 'anthropic' } },
    );
    queryClient.setQueryData(PROJECT_MODEL_PROFILE_SELECTIONS_QUERY_KEY, {});

    let result: ReturnType<typeof useActivateModelProfile> | undefined;
    await render(queryClient, function Harness() {
      result = useActivateModelProfile('project-1');
      return null;
    });

    let mutation: Promise<unknown> | undefined;
    act(() => { mutation = result?.mutateAsync('codex'); });
    await act(async () => {
      await vi.waitFor(() =>
        expect(queryClient.getQueryData(PROJECT_MODEL_PROFILE_SELECTIONS_QUERY_KEY))
          .toEqual({
            'project-1': { profileId: 'codex', pinnedProfileId: 'anthropic' },
          }),
      );
    });
    expect(api.modelProfiles.activate).toHaveBeenCalledWith('codex', 'project-1');

    await act(async () => {
      finish(PROFILES[1]);
      await mutation;
    });
  });

  it('restores a pinned project pick when activation fails', async () => {
    vi.spyOn(api.modelProfiles, 'activate').mockRejectedValue(new Error('write failed'));
    const queryClient = makeQueryClient();
    queryClient.setQueryData(['settings', 'activeModelProfileId'], 'anthropic');
    queryClient.setQueryData(
      [...PROJECT_MODEL_POLICY_QUERY_KEY, 'project-1'],
      { policy: { mode: 'prefer', pinnedProfileId: 'anthropic' } },
    );
    queryClient.setQueryData(PROJECT_MODEL_PROFILE_SELECTIONS_QUERY_KEY, {});

    let result: ReturnType<typeof useActivateModelProfile> | undefined;
    await render(queryClient, function Harness() {
      result = useActivateModelProfile('project-1');
      return null;
    });

    await act(async () => {
      await expect(result?.mutateAsync('codex')).rejects.toThrow('write failed');
    });
    expect(queryClient.getQueryData(PROJECT_MODEL_PROFILE_SELECTIONS_QUERY_KEY))
      .toEqual({});
    expect(queryClient.getQueryData(['settings', 'activeModelProfileId']))
      .toBe('anthropic');
  });

  it('optimistically sets the active profile id before the IPC call resolves', async () => {
    let finish: (profile: ModelProfile) => void = () => {};
    vi.spyOn(api.modelProfiles, 'activate').mockImplementation(
      () =>
        new Promise<ModelProfile>((resolve) => {
          finish = resolve;
        }),
    );
    const queryClient = makeQueryClient();
    queryClient.setQueryData(['settings', 'activeModelProfileId'], 'anthropic');

    let result: ReturnType<typeof useActivateModelProfile> | undefined;
    await render(queryClient, function Harness() {
      result = useActivateModelProfile();
      return null;
    });

    let mutation: Promise<unknown> | undefined;
    act(() => {
      mutation = result?.mutateAsync('codex');
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          queryClient.getQueryData(['settings', 'activeModelProfileId']),
        ).toBe('codex'),
      );
    });

    await act(async () => {
      finish(PROFILES[1]);
      await mutation;
    });
    expect(api.modelProfiles.activate).toHaveBeenCalledWith('codex', null);
  });

  it('rolls back to the previous active profile id when activation fails', async () => {
    vi.spyOn(api.modelProfiles, 'activate').mockRejectedValue(
      new Error('policy forbids this profile'),
    );
    const queryClient = makeQueryClient();
    queryClient.setQueryData(['settings', 'activeModelProfileId'], 'anthropic');

    let result: ReturnType<typeof useActivateModelProfile> | undefined;
    await render(queryClient, function Harness() {
      result = useActivateModelProfile();
      return null;
    });

    await act(async () => {
      await expect(result?.mutateAsync('codex')).rejects.toThrow(
        'policy forbids this profile',
      );
    });

    expect(
      queryClient.getQueryData(['settings', 'activeModelProfileId']),
    ).toBe('anthropic');
  });

  it('removes the optimistic value when there was no cached active profile id', async () => {
    vi.spyOn(api.modelProfiles, 'activate').mockRejectedValue(
      new Error('boom'),
    );
    const queryClient = makeQueryClient();

    let result: ReturnType<typeof useActivateModelProfile> | undefined;
    await render(queryClient, function Harness() {
      result = useActivateModelProfile();
      return null;
    });

    await act(async () => {
      await expect(result?.mutateAsync('codex')).rejects.toThrow('boom');
    });

    expect(
      queryClient.getQueryData(['settings', 'activeModelProfileId']),
    ).toBeUndefined();
  });
});

describe('useModelProfilesSetting', () => {
  it('keeps the profiles array identity stable across unrelated setting changes', async () => {
    vi.spyOn(api.settings, 'get').mockImplementation(async (key: string) => {
      if (key === 'modelProfiles') return PROFILES as never;
      return null as never;
    });
    const queryClient = makeQueryClient();

    const seen: (ModelProfile[] | undefined)[] = [];
    const emptyIdentities: ModelProfile[][] = [];
    await render(queryClient, function Harness() {
      const { profiles } = useModelProfilesSetting();
      // Second independent consumer: empty results must share one constant.
      const other = useModelProfilesSetting().profiles;
      if (profiles.length === 0) emptyIdentities.push(profiles, other);
      // Subscribe to the unrelated setting so its change forces a re-render.
      useActiveModelProfileId();
      seen.push(profiles);
      return null;
    });

    await act(async () => {
      await vi.waitFor(() => expect(seen.at(-1)).toHaveLength(2));
    });
    const stable = seen.at(-1);
    const rendersBefore = seen.length;

    // An unrelated setting changing must not produce a new array identity.
    await act(async () => {
      queryClient.setQueryData(['settings', 'activeModelProfileId'], 'codex');
    });

    await act(async () => {
      await vi.waitFor(() =>
        expect(seen.length).toBeGreaterThan(rendersBefore),
      );
    });
    expect(seen.at(-1)).toBe(stable);
    // Empty data must be a shared constant, not a fresh [] per call.
    expect(emptyIdentities.length).toBeGreaterThan(1);
    for (const identity of emptyIdentities) {
      expect(identity).toBe(emptyIdentities[0]);
    }
  });
});

describe('useActiveModelProfile', () => {
  it('returns the profile matching the active id and stays identity-stable', async () => {
    vi.spyOn(api.settings, 'get').mockImplementation(async (key: string) => {
      if (key === 'modelProfiles') return PROFILES as never;
      if (key === 'activeModelProfileId') return 'codex' as never;
      return null as never;
    });
    const queryClient = makeQueryClient();

    const seen: (ModelProfile | undefined)[] = [];
    await render(queryClient, function Harness() {
      seen.push(useActiveModelProfile().profile);
      // Unrelated setting subscription so its change re-renders this consumer.
      useSetting('appearance');
      return null;
    });

    await act(async () => {
      await vi.waitFor(() => expect(seen.at(-1)?.id).toBe('codex'));
    });
    const stable = seen.at(-1);
    const rendersBefore = seen.length;

    await act(async () => {
      queryClient.setQueryData(['settings', 'appearance'], {
        theme: 'light',
      } as never);
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(seen.length).toBeGreaterThan(rendersBefore),
      );
    });
    expect(seen.at(-1)).toBe(stable);
  });
});

describe('useEffectiveModelProfile', () => {
  async function renderEffective({
    activeProfileId,
    policy,
    projectId,
  }: {
    activeProfileId: string | null;
    policy?: ProjectModelPolicy;
    projectId?: string | null;
  }) {
    mockProfileApis({ activeProfileId, policy });
    const queryClient = makeQueryClient();
    const seen: (ModelProfile | undefined)[] = [];
    await render(queryClient, function Harness() {
      seen.push(useEffectiveModelProfile(projectId).profile);
      return null;
    });
    return seen;
  }

  it('returns the pinned profile under `prefer`', async () => {
    const seen = await renderEffective({
      activeProfileId: 'anthropic',
      policy: { mode: 'prefer', pinnedProfileId: 'codex' },
      projectId: 'project-1',
    });
    await act(async () => {
      await vi.waitFor(() => expect(seen.at(-1)?.id).toBe('codex'));
    });
  });

  it('defaults the UI to the first profile when none is active', async () => {
    const seen = await renderEffective({
      activeProfileId: null,
      projectId: 'project-1',
    });
    await act(async () => {
      await vi.waitFor(() => expect(seen.at(-1)?.id).toBe('anthropic'));
    });
  });

  it('returns the pinned profile under `enforce`', async () => {
    const seen = await renderEffective({
      activeProfileId: 'anthropic',
      policy: { mode: 'enforce', pinnedProfileId: 'codex' },
      projectId: 'project-1',
    });
    await act(async () => {
      await vi.waitFor(() => expect(seen.at(-1)?.id).toBe('codex'));
    });
  });

  it('returns the active profile under `inherit` even with a pinned id', async () => {
    const seen = await renderEffective({
      activeProfileId: 'anthropic',
      policy: { mode: 'inherit', pinnedProfileId: 'codex' },
      projectId: 'project-1',
    });
    await act(async () => {
      await vi.waitFor(() => expect(seen.at(-1)?.id).toBe('anthropic'));
    });
    expect(seen.every((profile) => profile?.id !== 'codex')).toBe(true);
  });

  it('falls back to the active profile when the pinned id is unknown', async () => {
    const seen = await renderEffective({
      activeProfileId: 'anthropic',
      policy: { mode: 'enforce', pinnedProfileId: 'does-not-exist' },
      projectId: 'project-1',
    });
    await act(async () => {
      await vi.waitFor(() => expect(seen.at(-1)?.id).toBe('anthropic'));
    });
  });

  it('lands on the first allowed profile under `enforce` when the active one is not allowed', async () => {
    const seen = await renderEffective({
      activeProfileId: 'anthropic',
      policy: { mode: 'enforce', allowedProfileIds: ['codex'] },
      projectId: 'project-1',
    });
    await act(async () => {
      await vi.waitFor(() => expect(seen.at(-1)?.id).toBe('codex'));
    });
  });

  it('keeps the active profile under `prefer` even with an allow-list', async () => {
    const seen = await renderEffective({
      activeProfileId: 'anthropic',
      policy: { mode: 'prefer', allowedProfileIds: ['codex'] },
      projectId: 'project-1',
    });
    await act(async () => {
      await vi.waitFor(() => expect(seen.at(-1)?.id).toBe('anthropic'));
    });
    expect(seen.every((profile) => profile?.id !== 'codex')).toBe(true);
  });

  it('prefers the pin over the allow-list under `enforce`', async () => {
    const seen = await renderEffective({
      activeProfileId: 'codex',
      policy: {
        mode: 'enforce',
        pinnedProfileId: 'anthropic',
        allowedProfileIds: ['codex'],
      },
      projectId: 'project-1',
    });
    await act(async () => {
      await vi.waitFor(() => expect(seen.at(-1)?.id).toBe('anthropic'));
    });
  });

  it('behaves like useActiveModelProfile when no projectId is given', async () => {
    mockProfileApis({
      activeProfileId: 'anthropic',
      policy: { mode: 'enforce', pinnedProfileId: 'codex' },
    });
    const queryClient = makeQueryClient();
    const seen: { effective?: string; active?: string }[] = [];
    await render(queryClient, function Harness() {
      seen.push({
        effective: useEffectiveModelProfile().profile?.id,
        active: useActiveModelProfile().profile?.id,
      });
      return null;
    });
    await act(async () => {
      await vi.waitFor(() => expect(seen.at(-1)?.active).toBe('anthropic'));
    });
    expect(seen.at(-1)?.effective).toBe('anthropic');
    // No project in scope means no policy lookup at all.
    expect(api.projects.getEffectivePolicy).not.toHaveBeenCalled();
  });
});

describe('composer quick chips', () => {
  it('offers the chips of the pinned profile, not the globally active one', async () => {
    mockProfileApis({
      activeProfileId: 'anthropic',
      policy: { mode: 'prefer', pinnedProfileId: 'codex' },
    });
    const queryClient = makeQueryClient();

    const seen: (string | undefined)[][] = [];
    await render(queryClient, function Harness() {
      // Exactly what the composer does: the picker's preset/chip source.
      const { profile } = useEffectiveModelProfile('project-1');
      seen.push(
        getQuickPresets({ profile, enabledBackends: undefined }).map(
          (preset) => preset.id,
        ),
      );
      return null;
    });

    await act(async () => {
      await vi.waitFor(() =>
        expect(seen.at(-1)).toEqual(['codex-gpt5']),
      );
    });
  });
});

describe('useResolvedModelForRole', () => {
  it('resolves through the api with the role and project id', async () => {
    const resolved = {
      backend: 'claude-code',
      model: 'sonnet',
      thinkingEffort: 'high',
      source: 'profile',
    };
    vi.spyOn(api.modelProfiles, 'resolve').mockResolvedValue(resolved as never);
    const queryClient = makeQueryClient();

    let data: unknown;
    await render(queryClient, function Harness() {
      data = useResolvedModelForRole('summary', 'project-1').data;
      return null;
    });

    await act(async () => {
      await vi.waitFor(() => expect(data).toEqual(resolved));
    });
    expect(api.modelProfiles.resolve).toHaveBeenCalledWith({
      role: 'summary',
      projectId: 'project-1',
      override: null,
    });
  });
});
