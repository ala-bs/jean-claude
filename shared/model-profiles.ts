// Model profiles: roles × profiles × project policy.
//
// See `docs/plans/2026-09-19-model-profiles-and-project-policy-design.md`.
//
// A *role* is a semantic slot that needs a model. A role holds a concrete
// `ModelTriple` — `(backend, model, thinkingEffort)` — or a reference to one of
// its profile's *presets*, or `'inherit'` / `'off'`.
//
// A *profile* binds every role at once and owns a list of named presets. A role
// bound to a preset follows it live: editing the preset moves every role bound
// to it. Deleting a preset inlines its triple into those roles, so a reference
// can never dangle. Use `tripleForBinding` rather than `isModelTriple` when
// reading a role binding — a reference is not itself a triple.
//
// A *project policy* constrains which backends / profiles a project may use.
//
// This module holds only the shared contracts and the resolver. It must stay
// free of Electron/Node imports: both the renderer (to render pickers) and the
// main process (to build `AgentBackendConfig`) import it.

import type {
  AiSkillSlotKey,
  ModelPreference,
  ThinkingEffort,
} from './types';
import type { AgentBackendType } from './agent-backend-types';
import { normalizeThinkingEffortForModel } from './thinking-settings';

// --- Roles ---

/**
 * Every place in the app that needs a model.
 *
 * `ai-generation` is the catch-all for AI skill slots that do not have their
 * own named role (and for `completion-context-generation-service`, which used
 * to hardcode `haiku`).
 */
export type ModelRole =
  // core
  | 'agent'
  | 'summary'
  | 'pr-review'
  | 'memory'
  | 'completion'
  // AI-generation features (each backed by an AI skill slot)
  | 'task-name'
  | 'pr-description'
  | 'commit-message'
  | 'project-summary'
  | 'work-item-summary'
  | 'project-logo'
  | 'project-feature-map'
  | 'merge-commit-message'
  | 'verification-note'
  // catch-all
  | 'ai-generation';

export type RoleDefinition = {
  id: ModelRole;
  label: string;
  /** Short explanation shown under the role in the profile editor. */
  description: string;
  /**
   * Whether this role accepts the `'off'` binding. `agent` may never be off;
   * optional features (e.g. `completion`) may.
   */
  canBeOff: boolean;
  /**
   * Whether this role only decides *whether* a feature runs, never which model
   * it runs on. `completion` is the case: autocomplete is served by Mistral FIM
   * through the Autocomplete settings (its own API key and model), so a preset's
   * backend/model/effort are meaningless there — feeding a preset's model to the
   * Mistral client would just produce an invalid request. The profile editor
   * offers only `inherit` / `off` for these roles.
   */
  toggleOnly?: boolean;
  /**
   * What kind of model this role selects. Absent means `'chat'`: a
   * `(backend, model, thinkingEffort)` triple resolved by
   * `resolveModelForRole`. `'image'` roles hold an `ImageModelBinding` instead
   * and are resolved by `resolveImageModelForRole` — they have no `inherit`
   * (the `agent` role is a chat model, so there is nothing to inherit); unset
   * means "use the AI Generation default".
   */
  modelKind?: 'chat' | 'image';
  /**
   * The AI skill slot this role backs, when it backs exactly one. Slots without
   * a named role resolve through the `ai-generation` role.
   */
  slotId?: AiSkillSlotKey;
};

/**
 * Ordered, app-defined list of roles. Display order in the profile editor.
 */
export const ROLE_DEFINITIONS: readonly RoleDefinition[] = [
  {
    id: 'agent',
    label: 'Agent',
    description: 'Main coding agent for task steps',
    canBeOff: false,
  },
  {
    id: 'summary',
    label: 'Summaries',
    description: 'Step and task summaries',
    canBeOff: true,
  },
  {
    id: 'pr-review',
    label: 'PR review',
    description: 'Pull request review agent',
    canBeOff: true,
  },
  {
    id: 'memory',
    label: 'Agent memory',
    description: 'Agent memory extraction',
    canBeOff: true,
  },
  {
    id: 'completion',
    label: 'Autocomplete',
    description:
      'Enable inline prompt autocomplete for this profile (model is set in Settings → Autocomplete)',
    canBeOff: true,
    toggleOnly: true,
  },
  {
    id: 'task-name',
    label: 'Task names',
    description: 'Generated task names',
    canBeOff: true,
    slotId: 'task-name',
  },
  {
    id: 'pr-description',
    label: 'PR descriptions',
    description: 'Generated pull request descriptions',
    canBeOff: true,
    slotId: 'pr-description',
  },
  {
    id: 'commit-message',
    label: 'Commit messages',
    description: 'Generated commit messages',
    canBeOff: true,
    slotId: 'commit-message',
  },
  {
    id: 'project-summary',
    label: 'Project summaries',
    description: 'Generated project summaries',
    canBeOff: true,
    slotId: 'project-summary',
  },
  {
    id: 'work-item-summary',
    label: 'Work item summaries',
    description: 'Generated work item summaries',
    canBeOff: true,
    slotId: 'work-item-summary',
  },
  {
    id: 'project-logo',
    label: 'Project logos',
    description: 'Generated project logos',
    canBeOff: true,
    modelKind: 'image',
    slotId: 'logo-generation',
  },
  {
    id: 'project-feature-map',
    label: 'Project feature maps',
    description: 'Generated project feature maps',
    canBeOff: true,
    slotId: 'project-feature-map',
  },
  {
    id: 'merge-commit-message',
    label: 'Merge commit messages',
    description: 'Generated commit messages when squash-merging worktrees',
    canBeOff: true,
    slotId: 'merge-commit-message',
  },
  {
    id: 'verification-note',
    label: 'Verification notes',
    description: 'Generated work item verification checklists',
    canBeOff: true,
    slotId: 'verification-note',
  },
  {
    id: 'ai-generation',
    label: 'Other AI generation',
    description: 'Fallback for every other AI-generation feature',
    canBeOff: true,
  },
];

export const MODEL_ROLES: readonly ModelRole[] = ROLE_DEFINITIONS.map(
  (definition) => definition.id,
);

/**
 * Type guard for stored role ids. Profiles must tolerate role ids they do not
 * recognise (a profile written by a newer version) — unknown ids are treated as
 * `'inherit'` rather than invalidating the whole profile.
 */
export function isModelRole(value: unknown): value is ModelRole {
  return (
    typeof value === 'string' && MODEL_ROLES.includes(value as ModelRole)
  );
}

export function getRoleDefinition(role: ModelRole): RoleDefinition | undefined {
  return ROLE_DEFINITIONS.find((definition) => definition.id === role);
}

/**
 * The role that backs a given AI skill slot, or `'ai-generation'` for slots
 * without a named role.
 */
export function roleForSkillSlot(slot: AiSkillSlotKey): ModelRole {
  const definition = ROLE_DEFINITIONS.find((entry) => entry.slotId === slot);
  return definition ? definition.id : 'ai-generation';
}

// --- Profiles ---

/** The concrete model selection a role can hold. */
export type ModelTriple = {
  backend: AgentBackendType;
  model: ModelPreference;
  thinkingEffort: ThinkingEffort;
};

/**
 * The selection an *image* role can hold. Image generation goes straight to an
 * image API with its own key (see `project-logo-service.ts`), so there is no
 * backend or thinking effort to pick — only the image model id.
 */
export type ImageModelBinding = {
  imageModel: string;
};

/**
 * A reference to a preset of the *same profile*. The role follows the preset
 * live: editing the preset moves every role bound to it, which is the point of
 * having named presets at all.
 *
 * The dangling-reference risk this reintroduces is handled at the only place
 * that can create one: deleting a preset inlines its triple into every role
 * that referenced it (see the profile editor). The resolver still degrades a
 * missing id to `'inherit'` as defence in depth.
 */
export type PresetRefBinding = { presetId: string };

/**
 * What a role binds to inside a profile:
 * - a `ModelTriple` — a concrete, self-contained chat selection (`Custom…`)
 * - a `PresetRefBinding` — follow a preset of this profile, live
 * - an `ImageModelBinding` — a concrete image-model selection (image roles only)
 * - `'inherit'` — follow the `agent` role (chat roles only)
 * - `'off'` — the feature is disabled under this profile
 */
export type RoleBinding =
  | ModelTriple
  | PresetRefBinding
  | ImageModelBinding
  | 'inherit'
  | 'off';

export const INHERIT_BINDING = 'inherit' as const;
export const OFF_BINDING = 'off' as const;

/** A named shortcut owned by a profile; applying it copies its triple. */
export type ProfilePreset = {
  id: string;
  name: string;
} & ModelTriple;

/** Structural check for a stored role binding. */
export function isModelTriple(value: unknown): value is ModelTriple {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ModelTriple>;
  return (
    typeof candidate.backend === 'string' &&
    candidate.backend.length > 0 &&
    typeof candidate.model === 'string' &&
    typeof candidate.thinkingEffort === 'string'
  );
}

/** Structural check for a stored image-model binding. */
export function isImageModelBinding(
  value: unknown,
): value is ImageModelBinding {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ImageModelBinding>;
  return (
    typeof candidate.imageModel === 'string' && candidate.imageModel.length > 0
  );
}

/** Structural check for a stored preset reference. */
export function isPresetRefBinding(value: unknown): value is PresetRefBinding {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PresetRefBinding>;
  return (
    typeof candidate.presetId === 'string' && candidate.presetId.length > 0
  );
}

/**
 * The concrete chat triple a binding stands for, resolving a preset reference
 * through the presets it names. `null` for anything that is not a chat
 * selection (inherit/off/unset/image) or for a reference that no longer
 * resolves.
 */
export function tripleForBinding({
  binding,
  presets,
}: {
  binding: RoleBinding | undefined;
  presets: readonly ProfilePreset[];
}): ModelTriple | null {
  if (isPresetRefBinding(binding)) {
    const preset = presets.find((entry) => entry.id === binding.presetId);
    if (!preset) return null;
    return {
      backend: preset.backend,
      model: preset.model,
      thinkingEffort: preset.thinkingEffort,
    };
  }
  return isModelTriple(binding) ? binding : null;
}

/** Fill in `'default'` for the parts a partial selection leaves out. */
export function toModelTriple(input: {
  backend: AgentBackendType;
  model?: ModelPreference | null;
  thinkingEffort?: ThinkingEffort | null;
}): ModelTriple {
  return {
    backend: input.backend,
    model: input.model ?? 'default',
    thinkingEffort: input.thinkingEffort ?? 'default',
  };
}

/**
 * Coerce an unknown stored value into a usable binding. Anything unrecognised
 * (including a legacy preset-id string) becomes `'inherit'`, which is the same
 * path an unset role takes.
 */
export function normalizeRoleBinding(value: unknown): RoleBinding {
  if (value === OFF_BINDING) return OFF_BINDING;
  if (isPresetRefBinding(value)) {
    return { presetId: value.presetId };
  }
  if (isImageModelBinding(value)) {
    return { imageModel: value.imageModel };
  }
  if (isModelTriple(value)) {
    return {
      backend: value.backend,
      model: value.model,
      thinkingEffort: value.thinkingEffort,
    };
  }
  return INHERIT_BINDING;
}

export type ModelProfile = {
  id: string;
  name: string;
  /** Named shortcuts owned by THIS profile; applying one fills a role's triple. */
  presets: ProfilePreset[];
  /** Presets offered as one-tap chips in the composer, for this profile. */
  quickPresetIds: string[];
  /**
   * Roles left unset behave as `'inherit'`. Unknown role keys are ignored.
   */
  roles: Partial<Record<ModelRole, RoleBinding>>;
};

export type ModelProfilesSetting = ModelProfile[];

/** `modelProfiles` setting default: no profiles until migration synthesizes them. */
export const DEFAULT_MODEL_PROFILES: ModelProfilesSetting = [];

// --- Project policy ---

export type ProjectModelPolicyMode = 'inherit' | 'prefer' | 'enforce';

export const PROJECT_MODEL_POLICY_MODES: readonly ProjectModelPolicyMode[] = [
  'inherit',
  'prefer',
  'enforce',
];

/**
 * Per-project constraint on which models may be used.
 *
 * - `inherit` — no constraint; the global active profile applies.
 * - `prefer` — `pinnedProfileId` is preselected but the user may pick anything.
 * - `enforce` — disallowed options are hidden in pickers *and* rejected at
 *   session creation.
 *
 * Source of truth: `<repo>/.jean-claude/model-policy.json` when present
 * (wholesale, not merged), else `projects.modelPolicy` in the database.
 */
export type ProjectModelPolicy = {
  mode: ProjectModelPolicyMode;
  /**
   * Kept even though roles no longer reference global presets: a step-level
   * override can still name a backend directly, and under `enforce` that has to
   * be refused at session creation regardless of profile.
   */
  allowedBackends?: AgentBackendType[];
  allowedProfileIds?: string[];
  pinnedProfileId?: string;
};

export const DEFAULT_PROJECT_MODEL_POLICY: ProjectModelPolicy = {
  mode: 'inherit',
};

/** Where an effective policy came from, for read-only UI affordances. */
export type ProjectModelPolicySource = 'file' | 'project' | 'default';

export type EffectiveProjectModelPolicy = {
  policy: ProjectModelPolicy;
  source: ProjectModelPolicySource;
  /** Absolute path of the repo policy file when `source === 'file'`. */
  filePath?: string;
};

// --- Profile selection under a policy ---

/**
 * Whether a project policy permits *selecting* `profile` at all.
 *
 * Only `enforce` restricts: a pin means exactly one profile, an allow-list
 * means the listed ones. `inherit` and `prefer` permit everything (`prefer`
 * pins a starting point, not a restriction).
 */
function isProfilePermitted({
  profile,
  policy,
}: {
  profile: ModelProfile;
  policy?: ProjectModelPolicy | null;
}): boolean {
  if (!policy || policy.mode !== 'enforce') return true;
  if (policy.pinnedProfileId) return policy.pinnedProfileId === profile.id;
  if (policy.allowedProfileIds && policy.allowedProfileIds.length > 0) {
    return policy.allowedProfileIds.includes(profile.id);
  }
  return true;
}

/**
 * The project's explicit profile pick, or null when there is none *in force*.
 *
 * THE one reader of `projectModelProfileSelections` — never index that map
 * directly, because a pick is only valid against the default it was made
 * against. The stored `pinnedProfileId` is compared with the policy's current
 * pin, so a pick expires by itself when the project default changes from any
 * source, including a committed `.jean-claude/model-policy.json` that moves
 * under a `git pull` (which has no write hook that could clear it).
 */
export function readProjectProfilePick({
  selections,
  projectId,
  policy,
}: {
  selections?: Record<
    string,
    { profileId: string; pinnedProfileId: string }
  > | null;
  projectId?: string | null;
  policy?: ProjectModelPolicy | null;
}): string | null {
  if (!projectId || !selections) return null;
  const pick = selections[projectId];
  if (!pick) return null;
  // The pick expires the moment the default it was made against changes, from
  // whichever source — including a committed policy file changing under a `git
  // pull`, which has no write hook to clear it.
  if (pick.pinnedProfileId !== policy?.pinnedProfileId) return null;
  return pick.profileId;
}

/**
 * Whether an explicit per-project profile pick may override the policy.
 *
 * Only under `prefer` *with* a pin. That is the one case where the pin would
 * otherwise silently swallow the user's choice; `inherit` has nothing to
 * override, `enforce` + pin is a hard rule, and an `enforce` allow-list already
 * routes through the global active profile.
 *
 * This tests only that *a* pin exists; expiring a pick made against an older
 * pin is `readProjectProfilePick`'s job.
 */
function isProjectPickHonored(policy?: ProjectModelPolicy | null): boolean {
  return Boolean(policy && policy.mode === 'prefer' && policy.pinnedProfileId);
}

/**
 * The single rule for "which profile is in effect here", shared by
 * `ModelProfileService.getEffectiveProfile` (main) and
 * `useEffectiveModelProfile` (renderer). Both MUST call this — the two used to
 * re-implement it and drifted twice.
 *
 * In order:
 * 1. no policy, or mode `inherit` → the active profile.
 * 2. mode `prefer` with a pin AND an explicit project-scoped pick → the pick.
 *    Under `prefer` the pin is a *default*, not a restriction, so a deliberate
 *    choice for this project has to beat it (otherwise the switcher appears to
 *    do nothing and the project is stuck on its default profile forever).
 * 3. `pinnedProfileId` (prefer/enforce) that exists → that profile.
 * 4. `enforce` with a non-empty `allowedProfileIds` that excludes the active
 *    profile → the first allowed profile that exists, in `profiles` order.
 * 5. otherwise → the active profile.
 *
 * Note this only decides what is *selected*. `resolveModelForRole` still blocks
 * at resolution time when a binding genuinely violates the policy.
 */
export function pickEffectiveProfile({
  profiles,
  activeProfileId,
  projectProfileId,
  policy,
}: {
  profiles: ModelProfile[];
  activeProfileId?: string | null;
  /**
   * Profile the user explicitly picked *for this project*
   * (`projectModelProfileSelections`). Only consulted to override a `prefer`
   * pin — see `isProjectPickHonored`.
   */
  projectProfileId?: string | null;
  policy?: ProjectModelPolicy | null;
}): ModelProfile | null {
  const active = activeProfileId
    ? (profiles.find((entry) => entry.id === activeProfileId) ?? null)
    : null;

  if (!policy || policy.mode === 'inherit') return active;

  if (policy.pinnedProfileId) {
    if (isProjectPickHonored(policy)) {
      const picked = projectProfileId
        ? profiles.find((entry) => entry.id === projectProfileId)
        : undefined;
      if (picked) return picked;
    }
    const pinned = profiles.find(
      (entry) => entry.id === policy.pinnedProfileId,
    );
    if (pinned) return pinned;
    // A pin naming a profile that no longer exists must not strand the user.
    return active;
  }

  if (policy.mode === 'enforce' && !(active && isProfilePermitted({ profile: active, policy }))) {
    const firstAllowed = profiles.find((entry) =>
      isProfilePermitted({ profile: entry, policy }),
    );
    if (firstAllowed) return firstAllowed;
  }

  return active;
}

/**
 * Profiles a picker may offer for a project. Under `enforce` disallowed
 * profiles are *hidden* (design §2), including profiles whose `agent` backend
 * the policy forbids. `inherit` / `prefer` offer everything.
 *
 * If filtering would leave nothing (e.g. the allow-list names profiles that no
 * longer exist) the full list is returned rather than an empty menu.
 */
export function listSelectableProfiles({
  profiles,
  policy,
}: {
  profiles: ModelProfile[];
  policy?: ProjectModelPolicy | null;
}): ModelProfile[] {
  if (!policy || policy.mode !== 'enforce') return profiles;

  const permitted = profiles.filter((profile) => {
    if (!isProfilePermitted({ profile, policy })) return false;
    if (policy.allowedBackends && policy.allowedBackends.length > 0) {
      const triple = tripleForBinding({
        binding: profile.roles.agent,
        presets: profile.presets ?? [],
      });
      if (triple) {
        return policy.allowedBackends.includes(triple.backend);
      }
    }
    return true;
  });

  return permitted.length > 0 ? permitted : profiles;
}

// --- Resolution ---

export type ResolvedModelSource =
  | 'override'
  | 'profile'
  | 'policy'
  | 'fallback';

export type ResolvedModelBlockedReason =
  | 'backend-not-allowed'
  | 'profile-not-allowed'
  | 'role-off'
  | 'no-profile';

export type ResolvedModel = {
  backend: AgentBackendType;
  model: ModelPreference;
  thinkingEffort: ThinkingEffort;
  source: ResolvedModelSource;
  /** Set when the policy rejected the requested selection. */
  blocked?: {
    reason: ResolvedModelBlockedReason;
    /** Human-readable explanation to surface in the UI / session error. */
    message: string;
    allowed: {
      backends?: AgentBackendType[];
      profileIds?: string[];
    };
  };
  /** Profile the resolution came from, when any. */
  profileId?: string;
  /** Profile preset an override named, when any. */
  presetId?: string;
  /** True when the role resolved to `'off'` (feature disabled). */
  off?: boolean;
};

/**
 * An explicit, per-step (or per-call) selection that bypasses the profile when
 * the policy allows it.
 */
export type ModelOverride = {
  backend?: AgentBackendType | null;
  model?: ModelPreference | null;
  thinkingEffort?: ThinkingEffort | null;
  /** A preset of the profile that applies; its triple is copied in. */
  presetId?: string | null;
};

export type ResolveModelForRoleParams = {
  role: ModelRole;
  /** Effective policy for the project, already resolved from file or DB. */
  policy?: ProjectModelPolicy | null;
  /** Currently active profile (global) or the project-pinned one. */
  activeProfileId?: string | null;
  /**
   * Profile explicitly picked for this project, which overrides a `prefer`
   * pin. See `pickEffectiveProfile` / `isProjectPickHonored`.
   */
  projectProfileId?: string | null;
  profiles: ModelProfile[];
  /** Backends the user has enabled; policy can only restrict, never grant. */
  enabledBackends?: AgentBackendType[];
  /** Explicit step-level selection, applied only when the policy allows it. */
  override?: ModelOverride | null;
  /** Used when nothing else resolves. */
  fallback?: {
    backend: AgentBackendType;
    model?: ModelPreference;
    thinkingEffort?: ThinkingEffort;
  };
};

const DEFAULT_FALLBACK_BACKEND: AgentBackendType = 'claude-code';

/** Binding for a role, tolerating unknown role ids (treated as `inherit`). */
function bindingForRole(
  profile: ModelProfile | undefined,
  role: ModelRole,
): RoleBinding {
  if (!profile || !isModelRole(role)) {
    return INHERIT_BINDING;
  }
  return normalizeRoleBinding(profile.roles[role]);
}

function tripleFromFallback(
  fallback: ResolveModelForRoleParams['fallback'],
  enabledBackends: AgentBackendType[] | undefined,
): ModelTriple {
  const backend =
    fallback?.backend ?? enabledBackends?.[0] ?? DEFAULT_FALLBACK_BACKEND;
  return {
    backend,
    model: fallback?.model ?? 'default',
    thinkingEffort: fallback?.thinkingEffort ?? 'default',
  };
}

/**
 * The single resolution chain that replaces `resolveBackendModelSelection`,
 * `resolveRunModelSettings`, and the per-feature model settings.
 *
 * Pure: no IO, no mutation of its inputs. Safe to call from both processes.
 */
export function resolveModelForRole(
  params: ResolveModelForRoleParams,
): ResolvedModel {
  const {
    role,
    policy,
    activeProfileId,
    projectProfileId,
    profiles,
    enabledBackends,
    override,
    fallback,
  } = params;

  const mode: ProjectModelPolicyMode = policy?.mode ?? 'inherit';
  const policyActive = mode !== 'inherit';

  // A policy can only restrict, never grant (design §8): intersect with the
  // backends the user actually enabled.
  // An EMPTY allow-list means "unrestricted", the same thing the pickers
  // (`isProfilePermitted`, `listSelectableProfiles`) already take it to mean.
  // Reading it as "nothing is allowed" here made a policy the UI showed as
  // unrestricted block every single resolution.
  const allowedBackends = (() => {
    const fromPolicy = policyActive ? policy?.allowedBackends : undefined;
    const restrictive = fromPolicy && fromPolicy.length > 0 ? fromPolicy : undefined;
    if (!restrictive && !enabledBackends) return undefined;
    if (!restrictive) return enabledBackends;
    if (!enabledBackends) return restrictive;
    return restrictive.filter((backend) => enabledBackends.includes(backend));
  })();
  const allowedProfileIdsRaw = policyActive
    ? policy?.allowedProfileIds
    : undefined;
  const allowedProfileIds =
    allowedProfileIdsRaw && allowedProfileIdsRaw.length > 0
      ? allowedProfileIdsRaw
      : undefined;

  const fallbackTriple = tripleFromFallback(fallback, enabledBackends);

  const blockedResult = (
    reason: ResolvedModelBlockedReason,
    message: string,
    source: ResolvedModelSource,
  ): ResolvedModel => {
    const backend =
      allowedBackends && !allowedBackends.includes(fallbackTriple.backend)
        ? (allowedBackends[0] ?? fallbackTriple.backend)
        : fallbackTriple.backend;
    const model =
      backend === fallbackTriple.backend ? fallbackTriple.model : 'default';
    return finalize({
      triple: {
        backend,
        model,
        thinkingEffort:
          backend === fallbackTriple.backend
            ? fallbackTriple.thinkingEffort
            : 'default',
      },
      source,
      blocked: {
        reason,
        message,
        allowed: {
          ...(allowedBackends ? { backends: [...allowedBackends] } : {}),
          ...(allowedProfileIds
            ? { profileIds: [...allowedProfileIds] }
            : policy?.pinnedProfileId
              ? { profileIds: [policy.pinnedProfileId] }
              : {}),
        },
      },
    });
  };

  // --- Which profile applies: policy pin beats the global active profile. ---
  const pinnedProfileId = policyActive ? policy?.pinnedProfileId : undefined;
  const pinnedProfile = pinnedProfileId
    ? profiles.find((entry) => entry.id === pinnedProfileId)
    : undefined;
  // A dangling pin only blocks under `enforce`. Under `prefer` the pin is a
  // starting point, not a restriction (design §2/§9), so deleting the pinned
  // profile must fall back to the active one rather than making every run in
  // the project fail — which is what `pickEffectiveProfile` already does.
  // An explicit per-project pick beats a `prefer` pin, exactly as
  // `pickEffectiveProfile` decides for the pickers. These two used to disagree,
  // so the switcher's selection marker and the model actually run diverged.
  const projectPick =
    isProjectPickHonored(policyActive ? policy : null) && projectProfileId
      ? profiles.find((entry) => entry.id === projectProfileId)
      : undefined;
  const effectiveProfileId =
    projectPick?.id ??
    (pinnedProfile ? pinnedProfileId : undefined) ??
    activeProfileId ??
    null;
  const profile = effectiveProfileId
    ? profiles.find((entry) => entry.id === effectiveProfileId)
    : undefined;

  if (mode === 'enforce' && pinnedProfileId && !pinnedProfile) {
    return blockedResult(
      'no-profile',
      `Project policy pins profile "${pinnedProfileId}", which no longer exists.`,
      'fallback',
    );
  }

  // --- Profile allow-list. Under `enforce` the profile itself must be permitted. ---
  if (mode === 'enforce' && allowedProfileIds) {
    if (!profile || !allowedProfileIds.includes(profile.id)) {
      return blockedResult(
        'profile-not-allowed',
        profile
          ? `This project does not permit the model profile "${profile.name}".`
          : 'This project only permits a fixed set of model profiles.',
        'policy',
      );
    }
  }

  const profileSource: ResolvedModelSource =
    pinnedProfileId && !projectPick ? 'policy' : 'profile';

  // --- Role binding, resolving `inherit` through the `agent` role. ---
  // An image binding is unusable for a chat role: treat it exactly like any
  // other unrecognised value, i.e. as `inherit`. The chat resolver must never
  // return an image selection. A preset reference resolves through the
  // effective profile's OWN presets; an id that no longer exists degrades to
  // `inherit` rather than throwing (deletion inlines, so this is unreachable).
  const asChatBinding = (
    value: RoleBinding,
  ): ModelTriple | 'inherit' | 'off' => {
    if (value === INHERIT_BINDING || value === OFF_BINDING) return value;
    return (
      tripleForBinding({ binding: value, presets: profile?.presets ?? [] }) ??
      INHERIT_BINDING
    );
  };

  let binding = asChatBinding(bindingForRole(profile, role));
  if (binding === INHERIT_BINDING && role !== 'agent') {
    binding = asChatBinding(bindingForRole(profile, 'agent'));
  }

  let base: ResolvedModel;

  if (binding === OFF_BINDING) {
    const canBeOff = isModelRole(role)
      ? (getRoleDefinition(role)?.canBeOff ?? true)
      : true;
    if (!canBeOff) {
      return blockedResult(
        'role-off',
        `Role "${role}" cannot be disabled.`,
        'fallback',
      );
    }
    base = {
      ...fallbackTriple,
      source: profileSource,
      off: true,
      ...(profile ? { profileId: profile.id } : {}),
    };
  } else if (binding === INHERIT_BINDING) {
    // Either there is no profile, or `agent` itself is `inherit` / unset.
    base = { ...fallbackTriple, source: 'fallback' };
  } else {
    base = {
      ...binding,
      source: profileSource,
      ...(profile ? { profileId: profile.id } : {}),
    };
  }

  // --- Step override. Under `enforce` it still has to satisfy the policy. ---
  let resolved = base;
  if (override && !base.off) {
    const overridePreset = override.presetId
      ? profile?.presets.find((preset) => preset.id === override.presetId)
      : undefined;
    const backend =
      override.backend ?? overridePreset?.backend ?? base.backend;
    const hasOverride =
      overridePreset != null ||
      override.backend != null ||
      override.model != null ||
      override.thinkingEffort != null;
    if (hasOverride) {
      const model =
        override.model ??
        (overridePreset
          ? overridePreset.model
          : backend === base.backend
            ? base.model
            : 'default');
      const thinkingEffort =
        override.thinkingEffort ??
        (overridePreset
          ? overridePreset.thinkingEffort
          : backend === base.backend
            ? base.thinkingEffort
            : 'default');
      resolved = {
        backend,
        model,
        thinkingEffort,
        source: 'override',
        // Keep the profile the override was applied ON TOP OF. An override
        // picks a triple, never a profile, so dropping this made every
        // override look profile-less to `allowedProfileIds` checks — which
        // blocked every session in an `enforce` project.
        ...(base.profileId ? { profileId: base.profileId } : {}),
        ...(overridePreset ? { presetId: overridePreset.id } : {}),
      };
    }
  }

  // --- Policy clamping on the final triple. ---
  if (mode === 'enforce' && !resolved.off) {
    if (allowedBackends && !allowedBackends.includes(resolved.backend)) {
      return blockedResult(
        'backend-not-allowed',
        `This project does not permit the backend "${resolved.backend}".`,
        'policy',
      );
    }
  }

  return finalize({
    triple: {
      backend: resolved.backend,
      model: resolved.model,
      thinkingEffort: resolved.thinkingEffort,
    },
    source: resolved.source,
    presetId: resolved.presetId,
    profileId: resolved.profileId,
    off: resolved.off,
  });
}

export type ResolveImageModelForRoleParams = {
  role: ModelRole;
  profiles: ModelProfile[];
  /** Currently active profile (global); a policy pin beats it. */
  activeProfileId?: string | null;
  /** Explicit per-project pick, which beats a `prefer` pin. */
  projectProfileId?: string | null;
  policy?: ProjectModelPolicy | null;
  /** The AI Generation image model, used when the role is unset. */
  fallbackModel: string;
};

export type ResolvedImageModel = {
  /** `null` only when the role is `'off'`. */
  imageModel: string | null;
  /** True when the role resolved to `'off'` — the feature must not run. */
  off: boolean;
  blocked?: {
    reason: ResolvedModelBlockedReason;
    message: string;
    allowed: { profileIds?: string[] };
  };
  profileId?: string;
};

/**
 * Resolution for `modelKind: 'image'` roles. Separate from
 * `resolveModelForRole` so an image role never pretends to be a triple.
 *
 * An image role has no `inherit`: unset means "use the AI Generation default"
 * (`fallbackModel`). A chat triple stored on an image role is rejected, not
 * coerced, and takes the same path as unset.
 */
export function resolveImageModelForRole(
  params: ResolveImageModelForRoleParams,
): ResolvedImageModel {
  const {
    role,
    profiles,
    activeProfileId,
    projectProfileId,
    policy,
    fallbackModel,
  } = params;

  const mode: ProjectModelPolicyMode = policy?.mode ?? 'inherit';
  const policyActive = mode !== 'inherit';
  // Empty allow-list means unrestricted, same as everywhere else.
  const allowedProfileIdsRaw = policyActive
    ? policy?.allowedProfileIds
    : undefined;
  const allowedProfileIds =
    allowedProfileIdsRaw && allowedProfileIdsRaw.length > 0
      ? allowedProfileIdsRaw
      : undefined;

  const blockedResult = (
    reason: ResolvedModelBlockedReason,
    message: string,
  ): ResolvedImageModel => ({
    imageModel: fallbackModel,
    off: false,
    blocked: {
      reason,
      message,
      allowed: {
        ...(allowedProfileIds
          ? { profileIds: [...allowedProfileIds] }
          : policy?.pinnedProfileId
            ? { profileIds: [policy.pinnedProfileId] }
            : {}),
      },
    },
  });

  const pinnedProfileId = policyActive ? policy?.pinnedProfileId : undefined;
  const pinnedProfile = pinnedProfileId
    ? profiles.find((entry) => entry.id === pinnedProfileId)
    : undefined;
  // The SAME selection the chat resolver and the UI use. Re-deriving it as
  // `pinned ?? active` here meant the image resolver could pick a different
  // profile than everything else — e.g. under `enforce` with an allow-list,
  // the chat side falls forward onto a permitted profile while this one kept
  // the disallowed active profile and refused logo generation, naming a
  // profile no longer effective anywhere else.
  const profile =
    pickEffectiveProfile({
      profiles,
      activeProfileId,
      projectProfileId,
      policy,
    }) ?? undefined;

  if (mode === 'enforce' && pinnedProfileId && !pinnedProfile) {
    return blockedResult(
      'no-profile',
      `Project policy pins profile "${pinnedProfileId}", which no longer exists.`,
    );
  }

  if (mode === 'enforce' && allowedProfileIds) {
    if (!profile || !allowedProfileIds.includes(profile.id)) {
      return blockedResult(
        'profile-not-allowed',
        profile
          ? `This project does not permit the model profile "${profile.name}".`
          : 'This project only permits a fixed set of model profiles.',
      );
    }
  }

  const binding =
    profile && isModelRole(role)
      ? normalizeRoleBinding(profile.roles[role])
      : INHERIT_BINDING;

  if (binding === OFF_BINDING) {
    const canBeOff = getRoleDefinition(role)?.canBeOff ?? true;
    if (!canBeOff) {
      return blockedResult('role-off', `Role "${role}" cannot be disabled.`);
    }
    return {
      imageModel: null,
      off: true,
      ...(profile ? { profileId: profile.id } : {}),
    };
  }

  if (isImageModelBinding(binding)) {
    return {
      imageModel: binding.imageModel,
      off: false,
      ...(profile ? { profileId: profile.id } : {}),
    };
  }

  // Unset, `inherit`, or a chat triple stored on an image role: use the
  // AI Generation default rather than coercing an unusable binding.
  return { imageModel: fallbackModel, off: false };
}

function finalize({
  triple,
  source,
  blocked,
  presetId,
  profileId,
  off,
}: {
  triple: ModelTriple;
  source: ResolvedModelSource;
  blocked?: ResolvedModel['blocked'];
  presetId?: string;
  profileId?: string;
  off?: boolean;
}): ResolvedModel {
  return {
    backend: triple.backend,
    model: triple.model,
    thinkingEffort: normalizeThinkingEffortForModel({
      backend: triple.backend,
      model: triple.model,
      effort: triple.thinkingEffort,
    }),
    source,
    ...(blocked ? { blocked } : {}),
    ...(presetId ? { presetId } : {}),
    ...(profileId ? { profileId } : {}),
    ...(off ? { off: true } : {}),
  };
}
