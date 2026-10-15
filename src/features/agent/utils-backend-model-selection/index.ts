import type { ModelPreference, ThinkingEffort } from '@shared/types';
import type {
  ModelProfile,
  ProfilePreset,
  ProjectModelPolicy,
} from '@shared/model-profiles';
import type { AgentBackendType } from '@shared/agent-backend-types';
import { findMatchingBackendModelPresetId } from '@/features/agent/ui-backend-preset-selector';
import { resolveModelForRole } from '@shared/model-profiles';

// Presets are owned by a profile (design revision 1). Callers pass the
// *effective* profile's `presets`; there is no global preset list anymore.

/**
 * A preset only counts as selected when the picker would also show it as
 * selected. Keeping this in one place stops the overlay and the picker from
 * disagreeing about whether a preset is active (which would hide the thinking
 * selector while no preset chip is highlighted).
 *
 * A preset is selectable when its backend is enabled. Quick-list membership no
 * longer hides a preset: `quickPresetIds` decides which presets get a *chip*,
 * not which ones may be selected.
 */
export function isProfilePresetSelectable({
  preset,
  enabledBackends,
}: {
  preset: ProfilePreset;
  enabledBackends?: AgentBackendType[];
}) {
  return !(enabledBackends && !enabledBackends.includes(preset.backend));
}

/**
 * The one-tap chips the composer offers: the active profile's `quickPresetIds`,
 * in the order the profile lists them, restricted to presets that still exist
 * and whose backend is enabled.
 *
 * Every chip is therefore by construction consistent with the profile it came
 * from — switching profile switches the chips.
 */
export function getQuickPresets({
  profile,
  enabledBackends,
}: {
  profile?: ModelProfile | null;
  enabledBackends?: AgentBackendType[];
}): ProfilePreset[] {
  if (!profile) return [];

  return profile.quickPresetIds
    .map((id) => profile.presets.find((preset) => preset.id === id))
    .filter(
      (preset): preset is ProfilePreset =>
        preset !== undefined &&
        isProfilePresetSelectable({ preset, enabledBackends }),
    );
}

/**
 * Pure *visibility* logic — which preset chip is highlighted — with no opinion
 * on the resulting model or thinking effort. Those come from
 * `resolveModelForRole`.
 */
function resolveVisiblePreset({
  presets,
  quickPresetIds,
  backend,
  defaultModel,
  draftModelPreference,
  draftAgentBackend,
  draftPresetId,
  shouldAutoSelectPreset,
  enabledBackends,
}: {
  presets: ProfilePreset[];
  quickPresetIds?: string[];
  backend: AgentBackendType | null;
  defaultModel: ModelPreference;
  draftModelPreference?: ModelPreference | null;
  draftAgentBackend?: AgentBackendType | null;
  draftPresetId?: string | null;
  shouldAutoSelectPreset?: boolean;
  enabledBackends?: AgentBackendType[];
}): ProfilePreset | null {
  const isSelectable = (preset: ProfilePreset) =>
    isProfilePresetSelectable({ preset, enabledBackends });

  // On a completely untouched draft, the profile's first quick preset for the
  // current backend is the implicit default.
  const firstQuickPresetId =
    quickPresetIds && !draftModelPreference && !draftAgentBackend
      ? (quickPresetIds
          .map((id) => presets.find((preset) => preset.id === id))
          .find(
            (preset) =>
              preset !== undefined &&
              preset.backend === backend &&
              isSelectable(preset),
          )?.id ?? null)
      : null;

  const resolvedPresetId =
    shouldAutoSelectPreset === false
      ? (draftPresetId ?? null)
      : (draftPresetId ??
        findMatchingBackendModelPresetId({
          presets,
          backend,
          model: draftModelPreference ?? (backend ? defaultModel : undefined),
        }) ??
        firstQuickPresetId);

  const resolvedPreset = resolvedPresetId
    ? presets.find((preset) => preset.id === resolvedPresetId)
    : undefined;

  return resolvedPreset && isSelectable(resolvedPreset) ? resolvedPreset : null;
}

/**
 * Resolves the preset + model shown for a not-yet-created task.
 *
 * The four-source reconciliation this used to do (default backend → per-backend
 * default model → per-(backend, model) thinking effort → maybe a matching
 * preset) now lives in `resolveModelForRole`: this function only decides which
 * preset chip is *visible*, hands the draft to the resolver as a step override,
 * and clamps the result against the backend's dynamic model list.
 *
 * The clamp stays here on purpose: only the renderer knows which models the
 * backend actually advertises right now, and it must not run before that list
 * has loaded or a perfectly valid dynamic model would be downgraded.
 */
export function resolveBackendModelSelection({
  presets,
  quickPresetIds,
  backend,
  defaultModel,
  draftModelPreference,
  draftAgentBackend,
  draftPresetId,
  shouldAutoSelectPreset,
  enabledBackends,
  availableModels,
  areModelsFetched,
  profiles,
  activeProfileId,
  projectProfileId,
  policy,
}: {
  /** The effective profile's presets — never a global list. */
  presets: ProfilePreset[];
  /** The effective profile's quick list, in display order. */
  quickPresetIds?: string[];
  backend: AgentBackendType | null;
  defaultModel: ModelPreference;
  draftModelPreference?: ModelPreference | null;
  draftAgentBackend?: AgentBackendType | null;
  draftPresetId?: string | null;
  shouldAutoSelectPreset?: boolean;
  enabledBackends?: AgentBackendType[];
  availableModels?: ModelPreference[];
  areModelsFetched?: boolean;
  /** Global profile definitions; the `agent` role backs this selection. */
  profiles?: ModelProfile[];
  activeProfileId?: string | null;
  /**
   * The project's explicitly picked profile, which beats a `prefer` pin. Must
   * be threaded alongside `policy` — see `resolveAgentModelSelection`.
   */
  projectProfileId?: string | null;
  /** Effective project policy, when the caller knows it. */
  policy?: ProjectModelPolicy | null;
}): {
  presetId: string | null;
  preset: ProfilePreset | null;
  model: ModelPreference;
  thinkingEffort: ThinkingEffort;
} {
  const preset = resolveVisiblePreset({
    presets,
    quickPresetIds,
    backend,
    defaultModel,
    draftModelPreference,
    draftAgentBackend,
    draftPresetId,
    shouldAutoSelectPreset,
    enabledBackends,
  });

  const resolved = resolveModelForRole({
    role: 'agent',
    profiles: profiles ?? [],
    activeProfileId: activeProfileId ?? null,
    projectProfileId: projectProfileId ?? null,
    policy: policy ?? null,
    enabledBackends,
    // The visible preset belongs to the caller's (profile's) list, so its
    // triple is applied here rather than left to the resolver's `presetId`
    // lookup — which only sees the *effective* profile and would drop it.
    override: {
      backend: draftAgentBackend ?? preset?.backend ?? null,
      model: draftModelPreference ?? preset?.model ?? null,
      thinkingEffort: preset?.thinkingEffort ?? null,
      presetId: preset?.id ?? null,
    },
    ...(backend ? { fallback: { backend, model: defaultModel } } : {}),
  });

  const selection = {
    presetId: preset?.id ?? null,
    preset,
    model: resolved.model,
    thinkingEffort: resolved.thinkingEffort,
  };

  // No model list means nothing to validate against — clamping here would
  // silently downgrade a perfectly valid model to 'default'.
  if (preset || !backend || !availableModels || areModelsFetched !== true) {
    return selection;
  }

  return availableModels.includes(selection.model)
    ? selection
    : { ...selection, model: 'default' };
}
