import type { BackendModelPreset, ModelPreference } from '@shared/types';
import type { AgentBackendType } from '@shared/agent-backend-types';
import { findMatchingBackendModelPresetId } from '@/features/agent/ui-backend-preset-selector';

/**
 * A preset only counts as selected when the picker would also show it as
 * selected. Keeping this in one place stops the overlay and the picker from
 * disagreeing about whether a preset is active (which would hide the thinking
 * selector while no preset chip is highlighted).
 */
export function isBackendModelPresetSelectable({
  preset,
  enabledBackends,
  quickSwitcherEnabled,
}: {
  preset: BackendModelPreset;
  enabledBackends?: AgentBackendType[];
  quickSwitcherEnabled?: boolean;
}) {
  if (enabledBackends && !enabledBackends.includes(preset.backend)) {
    return false;
  }

  return !(quickSwitcherEnabled === true && preset.showInQuickSwitcher === false);
}

/**
 * Resolves the preset + model shown for a not-yet-created task.
 *
 * Rules, in order:
 * 1. An explicit user selection always wins and is never overridden.
 * 2. Otherwise match a preset on (backend, model).
 * 3. Otherwise, with the quick switcher on and a completely untouched draft,
 *    fall back to the first quick preset for the current backend.
 * 4. The model is only clamped to 'default' once the backend model list has
 *    loaded — clamping earlier would silently downgrade a valid dynamic model.
 */
export function resolveBackendModelSelection({
  presets,
  backend,
  defaultModel,
  draftModelPreference,
  draftAgentBackend,
  draftPresetId,
  shouldAutoSelectPreset,
  enabledBackends,
  quickSwitcherEnabled,
  availableModels,
  areModelsFetched,
}: {
  presets: BackendModelPreset[];
  backend: AgentBackendType | null;
  defaultModel: ModelPreference;
  draftModelPreference?: ModelPreference | null;
  draftAgentBackend?: AgentBackendType | null;
  draftPresetId?: string | null;
  shouldAutoSelectPreset?: boolean;
  enabledBackends?: AgentBackendType[];
  quickSwitcherEnabled?: boolean;
  availableModels?: ModelPreference[];
  areModelsFetched?: boolean;
}): {
  presetId: string | null;
  preset: BackendModelPreset | null;
  model: ModelPreference;
} {
  const isSelectable = (preset: BackendModelPreset) =>
    isBackendModelPresetSelectable({
      preset,
      enabledBackends,
      quickSwitcherEnabled,
    });

  const firstQuickPresetId =
    quickSwitcherEnabled === true &&
    !draftModelPreference &&
    !draftAgentBackend
      ? (presets.find(
          (preset) => preset.backend === backend && isSelectable(preset),
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
    : null;
  const preset =
    resolvedPreset && isSelectable(resolvedPreset) ? resolvedPreset : null;

  const model = draftModelPreference ?? preset?.model ?? defaultModel;

  // No model list means nothing to validate against — clamping here would
  // silently downgrade a perfectly valid model to 'default'.
  if (preset || !backend || !availableModels || areModelsFetched !== true) {
    return { presetId: preset?.id ?? null, preset, model };
  }

  return {
    presetId: null,
    preset: null,
    model: availableModels.includes(model) ? model : 'default',
  };
}
