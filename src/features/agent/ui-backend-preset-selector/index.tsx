import { forwardRef, useMemo } from 'react';

import type { ModelPreference, ThinkingEffort } from '@shared/types';
import { Select, type SelectOption, type SelectRef } from '@/common/ui/select';
import type { AgentBackendType } from '@shared/agent-backend-types';
import { AVAILABLE_BACKENDS } from '@/features/agent/ui-backend-selector';
import type { BindingKey } from '@/common/context/keyboard-bindings/types';
import type { ComponentSize } from '@/common/ui/styles';
import type { KeyboardLayer } from '@/common/context/keyboard-bindings';
import type { ProfilePreset } from '@shared/model-profiles';
import { useBackendsSetting } from '@/hooks/use-settings';



export type { SelectRef } from '@/common/ui/select';

const BACKEND_VALUE_PREFIX = 'backend:';
const PRESET_VALUE_PREFIX = 'preset:';

function toBackendValue(backend: AgentBackendType) {
  return `${BACKEND_VALUE_PREFIX}${backend}`;
}

function toPresetValue(presetId: string) {
  return `${PRESET_VALUE_PREFIX}${presetId}`;
}

export function findMatchingBackendModelPresetId({
  presets,
  backend,
  model,
  thinkingEffort,
}: {
  /** Presets of the effective profile (`profile.presets`). */
  presets: ProfilePreset[];
  backend: AgentBackendType | null | undefined;
  model: ModelPreference | null | undefined;
  thinkingEffort?: ThinkingEffort | null;
}) {
  if (!backend || !model) {
    return null;
  }

  return (
    presets.find(
      (preset) =>
        preset.backend === backend &&
        preset.model === model &&
        (thinkingEffort === undefined ||
          preset.thinkingEffort === thinkingEffort),
    )?.id ?? null
  );
}

export const BackendPresetSelector = forwardRef<
  SelectRef,
  {
    backend: AgentBackendType;
    selectedPresetId?: string | null;
    /**
     * Presets of the profile in effect, passed in by the owner (the picker)
     * so this component never becomes a second, project-blind source of truth.
     */
    presets: ProfilePreset[];
    enabledBackends?: AgentBackendType[];
    onChange: (selection: {
      backend: AgentBackendType;
      presetId: string | null;
      modelPreference?: ModelPreference;
      thinkingEffort?: ThinkingEffort | null;
    }) => void;
    disabled?: boolean;
    shortcut?: BindingKey | BindingKey[];
    shortcutBehavior?: 'cycle' | 'open';
    side?: 'top' | 'bottom';
    className?: string;
    size?: ComponentSize;
    layer?: KeyboardLayer;
  }
>(function BackendPresetSelector(
  {
    backend,
    selectedPresetId,
    presets,
    enabledBackends: enabledBackendsOverride,
    onChange,
    disabled,
    shortcut,
    shortcutBehavior,
    side,
    className,
    size,
    layer,
  },
  ref,
) {
  const { data: backendsSetting } = useBackendsSetting();

  const enabledBackends = useMemo(
    () =>
      enabledBackendsOverride ??
      backendsSetting?.enabledBackends ??
      ([backend] as AgentBackendType[]),
    [backend, backendsSetting?.enabledBackends, enabledBackendsOverride],
  );

  const visibleBackends = useMemo(
    () =>
      AVAILABLE_BACKENDS.filter((option) =>
        enabledBackends.includes(option.value),
      ),
    [enabledBackends],
  );

  const visiblePresets = useMemo(
    () => presets.filter((preset) => enabledBackends.includes(preset.backend)),
    [enabledBackends, presets],
  );

  const options = useMemo(() => {
    const presetOptions: SelectOption<string>[] = visiblePresets.map(
      (preset) => {
        const backendOption = AVAILABLE_BACKENDS.find(
          (option) => option.value === preset.backend,
        );

        return {
          value: toPresetValue(preset.id),
          label: preset.name.trim() || 'Untitled preset',
          description: `${backendOption?.label ?? preset.backend} - ${preset.model} - ${preset.thinkingEffort} thinking`,
          group: 'Presets',
        };
      },
    );

    const backendOptions: SelectOption<string>[] = visibleBackends.map(
      (option) => ({
        value: toBackendValue(option.value),
        label: option.label,
        description: option.description,
        badge: option.badge,
        group: presetOptions.length > 0 ? 'Backends' : undefined,
      }),
    );

    return [...presetOptions, ...backendOptions];
  }, [visibleBackends, visiblePresets]);

  const selectedPreset = visiblePresets.find(
    (preset) => preset.id === selectedPresetId,
  );
  const value = selectedPreset
    ? toPresetValue(selectedPreset.id)
    : toBackendValue(backend);

  if (options.length <= 1 && visiblePresets.length === 0) {
    return null;
  }

  return (
    <Select
      ref={ref}
      value={value}
      options={options}
      onChange={(nextValue) => {
        if (nextValue.startsWith(PRESET_VALUE_PREFIX)) {
          const presetId = nextValue.slice(PRESET_VALUE_PREFIX.length);
          const preset = visiblePresets.find((item) => item.id === presetId);
          if (!preset) return;

          onChange({
            backend: preset.backend,
            presetId: preset.id,
            modelPreference: preset.model,
            thinkingEffort: preset.thinkingEffort,
          });
          return;
        }

        const nextBackend = nextValue.slice(
          BACKEND_VALUE_PREFIX.length,
        ) as AgentBackendType;
        onChange({ backend: nextBackend, presetId: null });
      }}
      disabled={disabled}
      label="Agent backend or preset"
      shortcut={shortcut}
      shortcutBehavior={shortcutBehavior}
      side={side}
      className={className}
      size={size}
      layer={layer}
    />
  );
});
