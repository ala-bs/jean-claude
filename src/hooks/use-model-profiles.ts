import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import type {
  ModelOverride,
  ModelProfile,
  ModelProfilesSetting,
  ModelRole,
  ProjectModelPolicy,
} from '@shared/model-profiles';
import type { ProjectModelProfileSelectionsSetting } from '@shared/types';
import {
  pickEffectiveProfile,
  readProjectProfilePick,
} from '@shared/model-profiles';

import { api } from '@/lib/api';
import { useSetting } from '@/hooks/use-settings';
import { useUpdateSetting } from '@/hooks/use-settings';

/**
 * Shared empty value so selectors/derivations never hand React a fresh `[]`
 * (see AGENTS.md: unstable outputs cause re-render loops in React 19).
 */
const EMPTY_PROFILES: ModelProfilesSetting = [];
const EMPTY_SELECTIONS: ProjectModelProfileSelectionsSetting = {};

export const MODEL_PROFILES_QUERY_KEY = ['settings', 'modelProfiles'] as const;
export const ACTIVE_MODEL_PROFILE_QUERY_KEY = [
  'settings',
  'activeModelProfileId',
] as const;
export const RESOLVED_MODEL_QUERY_KEY = ['model-profiles', 'resolve'] as const;
export const PROJECT_MODEL_PROFILE_SELECTIONS_QUERY_KEY = [
  'settings',
  'projectModelProfileSelections',
] as const;

/**
 * Global profile definitions. `profiles` is always an array and keeps a stable
 * identity while the underlying setting is unchanged.
 */
export function useModelProfilesSetting() {
  const query = useSetting('modelProfiles');
  const profiles = query.data ?? EMPTY_PROFILES;
  return { ...query, profiles };
}

/**
 * Explicit per-project profile picks. Only overrides a `prefer` policy's
 * pinned default (see `pickEffectiveProfile`).
 */
export function useProjectModelProfileSelections() {
  const query = useSetting('projectModelProfileSelections');
  return { ...query, selections: query.data ?? EMPTY_SELECTIONS };
}

/** Id of the globally active profile, or `null` when none is set. */
export function useActiveModelProfileId() {
  const query = useSetting('activeModelProfileId');
  return { ...query, activeProfileId: query.data ?? null };
}

/**
 * The currently active profile object, derived from the profile list and the
 * active id. `profile` is `undefined` while loading or when the active id no
 * longer matches any profile.
 */
export function useActiveModelProfile() {
  const profilesQuery = useModelProfilesSetting();
  const activeQuery = useActiveModelProfileId();
  const { profiles } = profilesQuery;
  const { activeProfileId } = activeQuery;
  const profile = useMemo<ModelProfile | undefined>(
    () =>
      activeProfileId
        ? profiles.find((entry) => entry.id === activeProfileId)
        : undefined,
    [profiles, activeProfileId],
  );
  return {
    profile,
    profiles,
    activeProfileId,
    isLoading: profilesQuery.isLoading || activeQuery.isLoading,
  };
}

/** Cache key of a project's effective model policy (shared with the switcher). */
export const PROJECT_MODEL_POLICY_QUERY_KEY = [
  'projects',
  'effective-model-policy',
] as const;

/**
 * The profile that governs a project — the renderer twin of
 * `ModelProfileService.getEffectiveProfile`. Both call the same shared rule,
 * `pickEffectiveProfile`: project default pin first, then (under `enforce`)
 * the first profile the allow-list permits when the active one is not
 * permitted, else the globally active profile.
 *
 * Use this — never `useActiveModelProfile` — for anything project-scoped, such
 * as the preset list or the composer's quick chips. `useActiveModelProfile`
 * stays right for genuinely global decisions (e.g. which profiles the switcher
 * lets you switch between).
 *
 * With no `projectId` this follows the global active profile, falling back to
 * the first profile for a deterministic UI default when no profile is active.
 */
export function useEffectiveModelProfile(projectId?: string | null) {
  const normalizedProjectId = projectId ?? null;
  const {
    profiles,
    activeProfileId,
    isLoading: isProfilesLoading,
  } = useActiveModelProfile();

  const policyQuery = useQuery({
    queryKey: [...PROJECT_MODEL_POLICY_QUERY_KEY, normalizedProjectId],
    queryFn: () => api.projects.getEffectivePolicy(normalizedProjectId as string),
    enabled: Boolean(normalizedProjectId),
  });

  const policy = policyQuery.data?.policy;
  const { selections } = useProjectModelProfileSelections();
  // Through the shared reader, so a pick made against an older project default
  // expires here exactly as it does in the main process.
  const projectProfileId = readProjectProfilePick({
    selections,
    projectId: normalizedProjectId,
    policy,
  });

  const profile = useMemo<ModelProfile | undefined>(
    () =>
      // Keep the shared resolver's null result for main-process fallback
      // semantics, but give the UI a deterministic initial profile when the
      // settings have not selected one yet.
      pickEffectiveProfile({
        profiles,
        activeProfileId,
        projectProfileId,
        policy,
      }) ?? profiles[0],
    [activeProfileId, policy, profiles, projectProfileId],
  );

  return {
    profile,
    profiles,
    activeProfileId,
    /**
     * The project's explicit pick, for callers that resolve a role themselves.
     * `resolveModelForRole` re-applies a `prefer` pin on top of
     * `activeProfileId`, so passing `effectiveProfileId` alone is NOT enough —
     * thread this too wherever a `policy` is passed.
     */
    projectProfileId,
    /** Id of the profile actually in effect here (pinned or active). */
    effectiveProfileId: profile?.id ?? null,
    isLoading:
      isProfilesLoading ||
      (Boolean(normalizedProjectId) && policyQuery.isLoading),
  };
}

/**
 * Activates a profile globally. Optimistic: the active id flips immediately and
 * rolls back if the main process rejects the switch (e.g. project policy).
 */
/**
 * Writes the `modelProfiles` setting and invalidates the resolved-model cache.
 *
 * Editing a role changes what every `useResolvedModelForRole` consumer should
 * show, so the invalidation belongs next to the key rather than in whichever
 * component happens to do the write — the task panel, add-step dialog and
 * skill-slot rows otherwise keep displaying the pre-edit model while the main
 * process already resolves the new one.
 */
export function useUpdateModelProfiles() {
  const queryClient = useQueryClient();
  const updateSetting = useUpdateSetting<'modelProfiles'>();
  // Both entry points must invalidate. Wrapping only `mutate` left
  // `mutateAsync` as a silent bypass with an identical type signature.
  const onSuccess = () => {
    void queryClient.invalidateQueries({ queryKey: RESOLVED_MODEL_QUERY_KEY });
  };
  type Variables = { key: 'modelProfiles'; value: ModelProfile[] };
  return {
    ...updateSetting,
    mutate: (variables: Variables) =>
      updateSetting.mutate(variables, { onSuccess }),
    mutateAsync: (variables: Variables) =>
      updateSetting.mutateAsync(variables, { onSuccess }),
  };
}

/**
 * Activates a profile. Pass the `projectId` whenever the pick happens inside a
 * project (composer, new step dialog): a `prefer` policy's pinned default
 * otherwise wins on the next read and the pick looks like it did nothing.
 */
export function useActivateModelProfile(projectId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (profileId: string) =>
      api.modelProfiles.activate(profileId, projectId ?? null),
    onMutate: async (profileId) => {
      const queryKey = ACTIVE_MODEL_PROFILE_QUERY_KEY;
      await Promise.all([
        queryClient.cancelQueries({ queryKey }),
        queryClient.cancelQueries({
          queryKey: PROJECT_MODEL_PROFILE_SELECTIONS_QUERY_KEY,
        }),
      ]);
      const hadPrevious = queryClient.getQueryData(queryKey) !== undefined;
      const previous = queryClient.getQueryData<string | null>(queryKey);
      const policy = projectId
        ? queryClient.getQueryData<{ policy: ProjectModelPolicy }>([
            ...PROJECT_MODEL_POLICY_QUERY_KEY,
            projectId,
          ])?.policy
        : undefined;
      const pinnedProfileId =
        policy?.mode === 'prefer' ? policy.pinnedProfileId : undefined;
      const previousProjectSelections =
        queryClient.getQueryData<ProjectModelProfileSelectionsSetting>(
          PROJECT_MODEL_PROFILE_SELECTIONS_QUERY_KEY,
        );
      queryClient.setQueryData(queryKey, profileId);
      if (projectId && pinnedProfileId) {
        queryClient.setQueryData<ProjectModelProfileSelectionsSetting>(
          PROJECT_MODEL_PROFILE_SELECTIONS_QUERY_KEY,
          {
            ...previousProjectSelections,
            [projectId]: { profileId, pinnedProfileId },
          },
        );
      }
      return { hadPrevious, previous, previousProjectSelections, pinnedProfileId };
    },
    onError: (_error, profileId, context) => {
      if (queryClient.getQueryData(ACTIVE_MODEL_PROFILE_QUERY_KEY) === profileId) {
        if (context?.hadPrevious) {
          queryClient.setQueryData(
            ACTIVE_MODEL_PROFILE_QUERY_KEY,
            context.previous,
          );
        } else {
          queryClient.removeQueries({
            queryKey: ACTIVE_MODEL_PROFILE_QUERY_KEY,
          });
        }
      }
      if (projectId && context?.pinnedProfileId) {
        const current =
          queryClient.getQueryData<ProjectModelProfileSelectionsSetting>(
            PROJECT_MODEL_PROFILE_SELECTIONS_QUERY_KEY,
          ) ?? {};
        if (current[projectId]?.profileId === profileId) {
          const restored = { ...current };
          const previous = context.previousProjectSelections?.[projectId];
          if (previous) restored[projectId] = previous;
          else delete restored[projectId];
          queryClient.setQueryData(
            PROJECT_MODEL_PROFILE_SELECTIONS_QUERY_KEY,
            restored,
          );
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ACTIVE_MODEL_PROFILE_QUERY_KEY,
      });
      // Every resolved role depends on the active profile.
      queryClient.invalidateQueries({ queryKey: RESOLVED_MODEL_QUERY_KEY });
      // The per-project pick may have been recorded too; without this the
      // switcher keeps rendering the project default as selected.
      queryClient.invalidateQueries({
        queryKey: PROJECT_MODEL_PROFILE_SELECTIONS_QUERY_KEY,
      });
    },
  });
}

/**
 * Resolves `(backend, model, thinkingEffort)` for a role through the main
 * process, which applies the project policy, the pinned or active profile and
 * any step override.
 */
export function useResolvedModelForRole(
  role: ModelRole,
  projectId?: string | null,
  override?: ModelOverride | null,
) {
  const normalizedProjectId = projectId ?? null;
  const normalizedOverride = override ?? null;
  return useQuery({
    queryKey: [
      ...RESOLVED_MODEL_QUERY_KEY,
      role,
      normalizedProjectId,
      normalizedOverride,
    ],
    queryFn: () =>
      api.modelProfiles.resolve({
        role,
        projectId: normalizedProjectId,
        override: normalizedOverride,
      }),
  });
}
