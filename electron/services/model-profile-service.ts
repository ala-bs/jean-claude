// Model profile service (main process).
//
// Owns the *stateful* side of model profiles: reading the profile settings
// (each profile owns its own presets), activating a profile, resolving the
// effective project policy
// (repo file wins over the DB column), and running the shared resolver
// (`resolveModelForRole`) with those inputs.
//
// Every dependency is injected so the service is testable without a database
// or a filesystem: pass fakes to `createModelProfileService`. The default
// instance returned by `getModelProfileService()` is wired to the real
// repositories.
//
// See `docs/plans/2026-09-19-model-profiles-and-project-policy-design.md`.

import { join } from 'node:path';

import {
  DEFAULT_PROJECT_MODEL_POLICY,
  pickEffectiveProfile,
  PROJECT_MODEL_POLICY_MODES,
  resolveModelForRole,
} from '@shared/model-profiles';
import type {
  EffectiveProjectModelPolicy,
  ModelOverride,
  ModelProfile,
  ModelRole,
  ProjectModelPolicy,
  ResolvedModel,
} from '@shared/model-profiles';
import type { AgentBackendType } from '@shared/agent-backend-types';
import type { AppSettings } from '@shared/types';
import { MODEL_POLICY_FILE_RELATIVE_PATH } from '@shared/model-policy-file';

/**
 * The slice of a project this service needs. Kept structural (not `Project`) so
 * tests can pass a literal.
 */
export type ModelProfileProject = {
  id: string;
  /** Repo root, used to look for `.jean-claude/model-policy.json`. */
  path: string;
  /** Raw JSON text of the `projects.modelPolicy` column, or null. */
  modelPolicy: string | null;
};

export type ModelProfileServiceDeps = {
  /** Reads a global setting (real impl: `SettingsRepository.get`). */
  getSetting: <K extends keyof AppSettings>(key: K) => Promise<AppSettings[K]>;
  /** Writes a global setting (real impl: `SettingsRepository.set`). */
  setSetting: <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) => Promise<void>;
  /** Loads a project, or null when it does not exist. */
  getProject: (projectId: string) => Promise<ModelProfileProject | null>;
  /**
   * Reads `<cwd>/.jean-claude/model-policy.json` (real impl:
   * `readPolicyFile` from `@shared/model-policy-file`).
   */
  readPolicyFile: (cwd: string) => Promise<ProjectModelPolicy | null>;
};

export type ModelProfileService = {
  /** All profile definitions (global). */
  listProfiles: () => Promise<ModelProfile[]>;
  /** The globally active profile, or null when none is set. */
  getActiveProfile: () => Promise<ModelProfile | null>;
  /**
   * The profile that governs a project: the pinned one when the effective
   * policy is `prefer`/`enforce` with a `pinnedProfileId`, else the globally
   * active profile.
   *
   * Use this — never `getActiveProfile()` — for any project-scoped decision,
   * such as which role binding a skill slot reads.
   */
  getEffectiveProfile: (params: {
    projectId?: string | null;
  }) => Promise<ModelProfile | null>;
  /**
   * Makes `profileId` the globally active profile.
   *
   * Rejects when the profile does not exist.
   */
  activateProfile: (params: { profileId: string }) => Promise<ModelProfile>;
  /**
   * Effective policy for a project: the repo file when present (wholesale),
   * else the DB column, else `{ mode: 'inherit' }`.
   */
  getEffectivePolicy: (params: {
    projectId: string;
  }) => Promise<EffectiveProjectModelPolicy>;
  /**
   * Resolves `(backend, model, thinkingEffort)` for a role, honouring the
   * project policy, the pinned or active profile, and any step override.
   *
   * `projectId` may be omitted for app-level roles with no project context.
   */
  resolveForRole: (params: {
    role: ModelRole;
    projectId?: string | null;
    override?: ModelOverride | null;
  }) => Promise<ResolvedModel>;
  /**
   * Ordered profile ids used for rate-limit fallback (replaces `rateLimitSwap`).
   */
  getFallbackOrder: () => Promise<string[]>;
  /**
   * Drops the cached effective policy for one project (call on project update)
   * or for every project when `projectId` is omitted.
   */
  invalidateProjectPolicyCache: (params?: { projectId?: string }) => void;
};

function parseStoredPolicy(raw: string | null): ProjectModelPolicy | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const mode = (parsed as { mode?: unknown }).mode;
  if (
    typeof mode !== 'string' ||
    !PROJECT_MODEL_POLICY_MODES.includes(
      mode as ProjectModelPolicy['mode'],
    )
  ) {
    return null;
  }
  return parsed as ProjectModelPolicy;
}


export function createModelProfileService(
  deps: ModelProfileServiceDeps,
): ModelProfileService {
  /** Effective policy cache, keyed by project id. Invalidated on update. */
  const policyCache = new Map<string, EffectiveProjectModelPolicy>();

  const listProfiles = async (): Promise<ModelProfile[]> =>
    (await deps.getSetting('modelProfiles')) ?? [];

  const getEnabledBackends = async (): Promise<AgentBackendType[]> => {
    const backends = await deps.getSetting('backends');
    return backends?.enabledBackends ?? [];
  };

  const getActiveProfile = async (): Promise<ModelProfile | null> => {
    const activeId = await deps.getSetting('activeModelProfileId');
    if (!activeId) return null;
    const profiles = await listProfiles();
    return profiles.find((profile) => profile.id === activeId) ?? null;
  };

  const activateProfile = async ({
    profileId,
  }: {
    profileId: string;
  }): Promise<ModelProfile> => {
    const profiles = await listProfiles();
    const profile = profiles.find((entry) => entry.id === profileId);
    if (!profile) {
      throw new Error(`Unknown model profile: ${profileId}`);
    }
    await deps.setSetting('activeModelProfileId', profileId);
    return profile;
  };

  const getEffectivePolicy = async ({
    projectId,
  }: {
    projectId: string;
  }): Promise<EffectiveProjectModelPolicy> => {
    const cached = policyCache.get(projectId);
    if (cached) return cached;

    const project = await deps.getProject(projectId);
    let effective: EffectiveProjectModelPolicy = {
      policy: DEFAULT_PROJECT_MODEL_POLICY,
      source: 'default',
    };

    if (project) {
      // The committed repo file wins wholesale over the DB column.
      const fromFile = await deps.readPolicyFile(project.path);
      if (fromFile) {
        effective = {
          policy: fromFile,
          source: 'file',
          filePath: join(project.path, MODEL_POLICY_FILE_RELATIVE_PATH),
        };
      } else {
        const fromRow = parseStoredPolicy(project.modelPolicy);
        if (fromRow) {
          effective = { policy: fromRow, source: 'project' };
        }
      }
    }

    policyCache.set(projectId, effective);
    return effective;
  };

  const getEffectiveProfile = async ({
    projectId,
  }: {
    projectId?: string | null;
  }): Promise<ModelProfile | null> => {
    if (!projectId) return getActiveProfile();

    const { policy } = await getEffectivePolicy({ projectId });
    const [profiles, activeProfileId] = await Promise.all([
      listProfiles(),
      deps.getSetting('activeModelProfileId'),
    ]);

    // One shared rule with the renderer's `useEffectiveModelProfile`.
    return pickEffectiveProfile({ profiles, activeProfileId, policy });
  };

  const resolveForRole = async ({
    role,
    projectId,
    override,
  }: {
    role: ModelRole;
    projectId?: string | null;
    override?: ModelOverride | null;
  }): Promise<ResolvedModel> => {
    const policy = projectId
      ? (await getEffectivePolicy({ projectId })).policy
      : DEFAULT_PROJECT_MODEL_POLICY;

    const [profiles, enabledBackends, globalActiveId] = await Promise.all([
      listProfiles(),
      getEnabledBackends(),
      deps.getSetting('activeModelProfileId'),
    ]);

    // A policy may only restrict: intersect with what the user enabled.
    // An empty list means unrestricted, so it must not become an empty
    // intersection that blocks everything.
    const allowedBackends =
      policy.allowedBackends && policy.allowedBackends.length > 0
        ? policy.allowedBackends.filter((backend) =>
            enabledBackends.includes(backend),
          )
        : undefined;
    const effectivePolicy: ProjectModelPolicy = allowedBackends
      ? { ...policy, allowedBackends }
      : policy;

    // The SAME rule the UI and `getEffectiveProfile` use. Re-deriving it here
    // as `pinned ?? active` skipped the `enforce` fall-forward, so the picker
    // showed one profile in effect while resolution used another and blocked.
    const activeProfileId =
      pickEffectiveProfile({
        profiles,
        activeProfileId: globalActiveId ?? null,
        policy,
      })?.id ?? null;

    const enforced = policy.mode === 'enforce';

    // `pickEffectiveProfile` falls back to the active profile when a pin is
    // dangling, so the UI never strands the user on a deleted profile. Here
    // that fallback would be a policy bypass: the project said "always run X",
    // X is gone, and running something else is exactly what `enforce` forbids.
    // Selection and enforcement legitimately differ on this one case.
    const pinnedMissing =
      enforced &&
      policy.pinnedProfileId != null &&
      !profiles.some((profile) => profile.id === policy.pinnedProfileId);

    if (
      pinnedMissing ||
      (enforced &&
        activeProfileId &&
        !profiles.some((profile) => profile.id === activeProfileId))
    ) {
      // Name the profile that is actually missing. `activeProfileId` is the
      // fall-forward result here, so under `pinnedMissing` it points at a
      // profile that exists — telling the user a profile sitting in their
      // switcher is "not available".
      const missingId = pinnedMissing ? policy.pinnedProfileId : activeProfileId;
      return {
        backend: enabledBackends[0] ?? 'claude-code',
        model: 'default',
        thinkingEffort: 'default',
        source: 'policy',
        blocked: {
          reason: 'profile-not-allowed',
          message: pinnedMissing
            ? `This project always runs model profile "${missingId}", which no longer exists.`
            : `Model profile "${missingId}" is not available, and this project enforces a model policy.`,
          allowed: pinnedMissing
            ? { profileIds: policy.pinnedProfileId ? [policy.pinnedProfileId] : [] }
            : { profileIds: profiles.map((profile) => profile.id) },
        },
      };
    }

    const resolved = resolveModelForRole({
      role,
      policy: effectivePolicy,
      activeProfileId,
      profiles,
      enabledBackends,
      override,
    });

    if (!enforced || resolved.blocked) return resolved;

    // Hard boundary: never let a stale row or a global profile switch leak a
    // disallowed selection into an `enforce` project.
    if (allowedBackends && !allowedBackends.includes(resolved.backend)) {
      return {
        ...resolved,
        source: 'policy',
        blocked: {
          reason: 'backend-not-allowed',
          message: `This project only permits ${allowedBackends.join(', ') || 'no enabled backend'}.`,
          allowed: { backends: allowedBackends },
        },
      };
    }

    // NO profile allow-list re-check here on purpose.
    //
    // `resolveModelForRole` already enforces `allowedProfileIds` against the
    // real profile, before any derivation. This duplicate keyed on
    // `resolved.profileId` — a derived field that is legitimately absent
    // whenever the role resolves through the fallback (an `inherit`/unset
    // `agent` role, or a step override) — so it refused sessions on the very
    // profile the policy allows. Two implementations of one rule, and the
    // weaker one won.
    return resolved;
  };

  const getFallbackOrder = async (): Promise<string[]> =>
    (await deps.getSetting('modelFallbackOrder')) ?? [];

  return {
    listProfiles,
    getActiveProfile,
    activateProfile,
    getEffectivePolicy,
    getEffectiveProfile,
    resolveForRole,
    getFallbackOrder,
    invalidateProjectPolicyCache: (params) => {
      if (params?.projectId) policyCache.delete(params.projectId);
      else policyCache.clear();
    },
  };
}

let defaultService: ModelProfileService | null = null;

/** Default instance wired to the real repositories and filesystem. */
export function getModelProfileService(): ModelProfileService {
  if (defaultService) return defaultService;

  defaultService = createModelProfileService({
    getSetting: async (key) => {
      const { SettingsRepository } = await import(
        '../database/repositories/settings'
      );
      return SettingsRepository.get(key);
    },
    setSetting: async (key, value) => {
      const { SettingsRepository } = await import(
        '../database/repositories/settings'
      );
      await SettingsRepository.set(key, value);
    },
    getProject: async (projectId) => {
      const { ProjectRepository } = await import(
        '../database/repositories/projects'
      );
      const project = await ProjectRepository.findById(projectId);
      if (!project) return null;
      return {
        id: project.id,
        path: project.path,
        modelPolicy: project.modelPolicy
          ? JSON.stringify(project.modelPolicy)
          : null,
      };
    },
    readPolicyFile: async (cwd) => {
      const { readPolicyFile } = await import('@shared/model-policy-file');
      return readPolicyFile(cwd);
    },
  });

  return defaultService;
}
