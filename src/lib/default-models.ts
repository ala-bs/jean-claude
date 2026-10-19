import type {
  ModelOverride,
  ModelProfile,
  ProjectModelPolicy,
  ResolvedModel,
} from '@shared/model-profiles';
import type {
  ModelPreference,
  ThinkingEffort,
} from '@shared/types';
import type { AgentBackendType } from '@shared/agent-backend-types';
import { resolveModelForRole } from '@shared/model-profiles';

/**
 * The model-ish fields a new-task / new-step draft carries. All of them are
 * *explicit user choices*: an unset field means "follow the active profile",
 * which is why `null` never reaches the resolver as an override.
 */
export type ModelDraftSelection = {
  agentBackend?: AgentBackendType | null;
  modelPreference?: ModelPreference | null;
  thinkingEffort?: ThinkingEffort | null;
  backendModelPresetId?: string | null;
};

/**
 * Turns a draft into a `ModelOverride`, or `null` when the user never touched
 * the model controls. Returning `null` (rather than an object of `null`s)
 * matters: `resolveModelForRole` treats any present field as an override.
 */
export function buildModelOverrideFromDraft(
  draft?: ModelDraftSelection | null,
): ModelOverride | null {
  if (!draft) return null;

  const override: ModelOverride = {};
  if (draft.agentBackend) override.backend = draft.agentBackend;
  // The persisted new-task form uses `'default'` as its untouched sentinel.
  // It means "follow the selected profile", not an explicit model override.
  if (draft.modelPreference && draft.modelPreference !== 'default') {
    override.model = draft.modelPreference;
  }
  if (draft.thinkingEffort && draft.thinkingEffort !== 'default') {
    override.thinkingEffort = draft.thinkingEffort;
  }
  if (draft.backendModelPresetId) override.presetId = draft.backendModelPresetId;

  return Object.keys(override).length > 0 ? override : null;
}

/**
 * Single entry point for "what `(backend, model, thinkingEffort)` should this
 * new task / step run with?".
 *
 * Replaces the old `resolveDefaultBackend` + `getDefaultModelForBackend` pair,
 * which read `backends.defaultBackend`, `backendDefaultModels` and
 * `thinkingSettings` and therefore ignored the active model profile entirely.
 */
export function resolveAgentModelSelection({
  profiles,
  activeProfileId,
  projectProfileId,
  policy,
  enabledBackends,
  draft,
}: {
  profiles?: ModelProfile[] | null;
  activeProfileId?: string | null;
  /**
   * The project's explicitly picked profile. MUST be threaded whenever a
   * `policy` is passed: `resolveModelForRole` re-applies a `prefer` pin on top
   * of `activeProfileId`, so passing an already-resolved effective profile id
   * is not enough — without this the pin wins here while the switcher shows
   * the pick.
   */
  projectProfileId?: string | null;
  policy?: ProjectModelPolicy | null;
  enabledBackends?: AgentBackendType[];
  draft?: ModelDraftSelection | null;
}): ResolvedModel {
  return resolveModelForRole({
    role: 'agent',
    profiles: profiles ?? [],
    activeProfileId: activeProfileId ?? null,
    projectProfileId: projectProfileId ?? null,
    policy: policy ?? null,
    enabledBackends,
    override: buildModelOverrideFromDraft(draft),
  });
}
