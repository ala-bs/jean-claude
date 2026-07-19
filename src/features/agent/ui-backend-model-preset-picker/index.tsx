import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { createPortal } from 'react-dom';

import {
  AVAILABLE_BACKENDS,
  type BackendModelOption,
  getModelLabel,
  getModelsForBackend,
} from '@/features/agent/ui-backend-selector';
import type { ModelPreference, ThinkingEffort } from '@shared/types';
import {
  useBackendDefaultModelsSetting,
  useBackendModelPresetsSetting,
  useBackendsSetting,
  useModelQuickSwitcherSetting,
} from '@/hooks/use-settings';
import type { AgentBackendType } from '@shared/agent-backend-types';
import { BackendPresetSelector } from '@/features/agent/ui-backend-preset-selector';
import type { BindingKey } from '@/common/context/keyboard-bindings/types';
import { getDefaultModelForBackend } from '@/lib/default-models';
import type { KeyboardLayer } from '@/common/context/keyboard-bindings';
import { ModelSelector } from '@/features/agent/ui-model-selector';
import { useBackendModels } from '@/hooks/use-backend-models';
import { useRegisterKeyboardBindings } from '@/common/context/keyboard-bindings';

const ACTIVE_PICKER_STYLE = {
  background: 'color-mix(in oklch, oklch(0.78 0.18 295) 14%, transparent)',
  border: '1px solid color-mix(in oklch, oklch(0.78 0.18 295) 30%, transparent)',
  color: 'oklch(0.78 0.18 295)',
};



export function BackendModelPresetPicker({
  backend,
  model,
  selectedPresetId,
  enabledBackends,
  onChange,
  disabled,
  backendShortcut,
  modelShortcut,
  side,
  className,
  modelClassName,
  layer,
}: {
  backend: AgentBackendType;
  model: ModelPreference;
  selectedPresetId?: string | null;
  enabledBackends?: AgentBackendType[];
  onChange: (selection: {
    backend: AgentBackendType;
    model: ModelPreference;
    thinkingEffort?: ThinkingEffort | null;
    presetId: string | null;
  }) => void;
  disabled?: boolean;
  backendShortcut?: BindingKey | BindingKey[];
  modelShortcut?: BindingKey | BindingKey[];
  side?: 'top' | 'bottom';
  className?: string;
  modelClassName?: string;
  layer?: KeyboardLayer;
}) {
  const { data: presets = [] } = useBackendModelPresetsSetting();
  const { data: backendsSetting } = useBackendsSetting();
  const { data: quickSwitcherSetting } = useModelQuickSwitcherSetting();
  const { data: backendDefaultModels } = useBackendDefaultModelsSetting();
  const { data: dynamicModels, isFetched } = useBackendModels(backend);
  const pickerId = useId();
  const [customBackend, setCustomBackend] = useState<AgentBackendType>(backend);
  const [customModel, setCustomModel] = useState<ModelPreference>(model);
  const customModelsQuery = useBackendModels(customBackend);
  const validSelectedPresetId = useMemo(() => {
    if (!selectedPresetId) {
      return null;
    }

    const selectedPreset = presets.find(
      (preset) => preset.id === selectedPresetId,
    );
    if (!selectedPreset) {
      return null;
    }

    if (enabledBackends && !enabledBackends.includes(selectedPreset.backend)) {
      return null;
    }

    return selectedPreset.id;
  }, [enabledBackends, presets, selectedPresetId]);
  const quickPresets = useMemo(
    () =>
      presets.filter(
        (preset) =>
          preset.showInQuickSwitcher !== false &&
          (!enabledBackends || enabledBackends.includes(preset.backend)),
      ),
    [enabledBackends, presets],
  );
  const matchingQuickPresetId = useMemo(
    () =>
      quickPresets.find(
        (preset) => preset.backend === backend && preset.model === model,
      )?.id ?? null,
    [backend, model, quickPresets],
  );
  const selectedQuickPresetId =
    (validSelectedPresetId &&
      quickPresets.some((preset) => preset.id === validSelectedPresetId) &&
      validSelectedPresetId) ||
    matchingQuickPresetId;
  const [customOpen, setCustomOpen] = useState(false);
  const [submenuBackend, setSubmenuBackend] = useState<AgentBackendType | null>(
    null,
  );
  const [popoverPosition, setPopoverPosition] = useState({
    bottom: 0,
    left: 0,
  });
  const useQuickSwitcher =
    quickSwitcherSetting?.enabled === true && quickPresets.length > 0;
  const isCustomSelected = !selectedQuickPresetId;
  const customModelOptions = useMemo(() => {
    const options = getModelsForBackend(
      customBackend,
      customModelsQuery.data,
    );
    return options.some((option) => option.value === customModel)
      ? options
      : insertMissingModelOption({
          options,
          missingOption: {
            value: customModel,
            label: getModelLabel(
              customModel,
              customBackend,
              customModelsQuery.data,
            ),
            description: 'Current model',
            group: getOpenCodeModelGroup(customModel, customBackend),
          },
        });
  }, [customBackend, customModel, customModelsQuery.data]);
  const visibleBackends = useMemo(() => {
    const backendIds =
      enabledBackends ?? backendsSetting?.enabledBackends ?? [backend];
    return AVAILABLE_BACKENDS.filter((option) =>
      backendIds.includes(option.value),
    );
  }, [backend, backendsSetting?.enabledBackends, enabledBackends]);
  const pickerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!customOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !pickerRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      ) {
        setCustomOpen(false);
        setSubmenuBackend(null);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [customOpen]);

  useEffect(() => {
    if (!customOpen) return;

    const updatePopoverPosition = () => {
      const rect = pickerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPopoverPosition({
        bottom: window.innerHeight - rect.top + 8,
        left: rect.left,
      });
    };

    updatePopoverPosition();
    window.addEventListener('resize', updatePopoverPosition);
    window.addEventListener('scroll', updatePopoverPosition, true);
    return () => {
      window.removeEventListener('resize', updatePopoverPosition);
      window.removeEventListener('scroll', updatePopoverPosition, true);
    };
  }, [customOpen]);
  const baseModelOptions = getModelsForBackend(backend, dynamicModels);
  const modelOptions = baseModelOptions.some((option) => option.value === model)
    ? baseModelOptions
    : insertMissingModelOption({
        options: baseModelOptions,
        missingOption: {
          value: model,
          label: getModelLabel(model, backend, dynamicModels),
          description: isFetched
            ? 'Previously selected model'
            : 'Loading available models',
          group: getOpenCodeModelGroup(model, backend),
        },
      });

  const shortcutKeys = backendShortcut
    ? Array.isArray(backendShortcut)
      ? backendShortcut
      : [backendShortcut]
    : [];
  const shortcutBindings = Object.fromEntries(
    shortcutKeys.map((key) => [
      key,
      {
        handler: () => {
          if (!quickPresets.length) return true;
          const currentIndex = selectedQuickPresetId
            ? quickPresets.findIndex(
                (preset) => preset.id === selectedQuickPresetId,
              )
            : -1;
          const nextPreset =
            quickPresets[(currentIndex + 1) % quickPresets.length];
          if (!nextPreset) return true;
          onChange({
            backend: nextPreset.backend,
            model: nextPreset.model,
            thinkingEffort: nextPreset.thinkingEffort ?? 'default',
            presetId: nextPreset.id,
          });
          return true;
        },
        ignoreIfInput: false,
      },
    ]),
  );
  useRegisterKeyboardBindings(`backend-model-quick-switcher-${pickerId}`, shortcutBindings, {
    enabled: useQuickSwitcher && shortcutKeys.length > 0 && !disabled,
    layer,
  });

  if (useQuickSwitcher) {
    return (
      <div
        ref={pickerRef}
        className={clsx('relative inline-flex shrink-0', className)}
      >
        <div
          className="border-glass-border bg-bg-1 inline-flex items-stretch overflow-hidden rounded-md border"
          role="radiogroup"
          aria-label="Model preset"
        >
          {quickPresets.map((preset, index) => {
            const selected = selectedQuickPresetId === preset.id;

            return (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled}
                style={selected ? ACTIVE_PICKER_STYLE : undefined}
                onClick={() => {
                  setCustomOpen(false);
                  setSubmenuBackend(null);
                  onChange({
                    backend: preset.backend,
                    model: preset.model,
                    thinkingEffort: preset.thinkingEffort ?? 'default',
                    presetId: preset.id,
                  });
                }}
                className={clsx(
                  'text-ink-2 hover:text-ink-1 border-glass-border inline-flex items-center whitespace-nowrap border-r px-2.5 py-1.5 text-xs font-medium transition-colors last:border-r-0',
                  selected
                    ? ''
                    : 'bg-white/[0.03] hover:bg-white/[0.07]',
                  index === 0 && 'rounded-l-[5px]',
                  disabled && 'cursor-not-allowed opacity-50',
                )}
              >
                {preset.name.trim() || 'Untitled'}
              </button>
            );
          })}
          <button
            type="button"
            aria-label={
              isCustomSelected
                ? `Custom model: ${getModelLabel(model, backend, dynamicModels)}`
                : 'Custom backend and model'
            }
            aria-expanded={customOpen}
            disabled={disabled}
            style={isCustomSelected ? ACTIVE_PICKER_STYLE : undefined}
            onClick={() => {
              if (!customOpen) {
                setCustomBackend(backend);
                setCustomModel(model);
              }
              setCustomOpen((open) => !open);
              setSubmenuBackend(null);
            }}
            className={clsx(
              'text-ink-3 hover:text-ink-1 inline-flex items-center gap-1 border-l border-white/[0.09] bg-white/[0.03] px-2 py-1.5 text-xs transition-colors hover:bg-white/[0.07]',
              isCustomSelected && '',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            {isCustomSelected && (
              <span className="max-w-28 truncate">
                {getModelLabel(model, backend, dynamicModels)}
              </span>
            )}
            <ChevronDown className="h-3 w-3 opacity-80" />
          </button>
        </div>

        {customOpen &&
          createPortal(
            <div
              ref={popoverRef}
              className="border-glass-border bg-bg-1 fixed z-[70] max-h-[min(70vh,28rem)] w-44 overflow-visible rounded-lg border p-1 shadow-2xl"
              style={popoverPosition}
            >
            {visibleBackends.map((backendOption) => {
              const isSelected = backendOption.value === customBackend;
              const isSubmenuOpen = submenuBackend === backendOption.value;

              return (
                <div
                  key={backendOption.value}
                  className="relative"
                  onMouseEnter={() => {
                    setSubmenuBackend(backendOption.value);
                    if (customBackend !== backendOption.value) {
                      setCustomBackend(backendOption.value);
                      setCustomModel('default');
                    }
                  }}
                >
                  <div
                    className={clsx(
                      'text-ink-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-xs',
                      isSubmenuOpen && 'bg-white/[0.07] text-ink-1',
                    )}
                  >
                    <span
                      className={clsx(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        isSelected ? 'bg-acc shadow-[0_0_6px_var(--color-acc)]' : 'bg-ink-4',
                      )}
                    />
                    <span className="flex-1 truncate">{backendOption.label}</span>
                    <span className="text-ink-4">›</span>
                  </div>

                  {isSubmenuOpen && (
                    <div className="border-glass-border bg-bg-1 absolute left-full top-[-4px] z-30 ml-1 max-h-[min(60vh,24rem)] w-40 overflow-y-auto overscroll-contain rounded-lg border p-1 shadow-2xl">
                      {(() => {
                        const submenuOptions =
                          backendOption.value === customBackend
                            ? customModelOptions
                            : getModelsForBackend(backendOption.value, undefined);

                        return submenuOptions.map((option, index) => {
                          const previousGroup =
                            index > 0 ? submenuOptions[index - 1].group : null;
                        const selected =
                          isSelected && option.value === customModel;

                        return (
                          <Fragment key={option.value}>
                            {option.group && option.group !== previousGroup && (
                              <div className="text-ink-4 bg-bg-1 sticky -top-1 z-10 px-2 pt-1.5 pb-1 text-[9px] font-semibold tracking-[0.12em] uppercase">
                                {option.group}
                              </div>
                            )}
                            <button
                            key={option.value}
                            type="button"
                            style={selected ? ACTIVE_PICKER_STYLE : undefined}
                            onClick={() => {
                              setCustomBackend(backendOption.value);
                              setCustomModel(option.value);
                              setCustomOpen(false);
                              setSubmenuBackend(null);
                              onChange({
                                backend: backendOption.value,
                                model: option.value,
                                thinkingEffort: null,
                                presetId: null,
                              });
                            }}
                            className={clsx(
                              'text-ink-2 hover:text-ink-1 block w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-white/[0.07]',
                              selected && '',
                            )}
                            >
                              {option.label}
                            </button>
                          </Fragment>
                        );
                        });
                      })()}
                    </div>
                  )}
                </div>
              );
            })}
            </div>,
            document.body,
          )}
      </div>
    );
  }

  return (
    <>
      <BackendPresetSelector
        backend={backend}
        selectedPresetId={validSelectedPresetId}
        enabledBackends={enabledBackends}
        onChange={(selection) => {
          if (selection.presetId) {
            onChange({
              backend: selection.backend,
              model: selection.modelPreference ?? 'default',
              thinkingEffort: selection.thinkingEffort ?? 'default',
              presetId: selection.presetId,
            });
            return;
          }

          onChange({
            backend: selection.backend,
            model: getDefaultModelForBackend({
              backend: selection.backend,
              backendDefaultModels,
            }),
            thinkingEffort: 'default',
            presetId: null,
          });
        }}
        disabled={disabled}
        shortcut={backendShortcut}
        side={side}
        className={className}
        layer={layer}
      />

      {!validSelectedPresetId && (
        <ModelSelector
          value={model}
          onChange={(nextModel) =>
            onChange({
              backend,
              model: nextModel,
              thinkingEffort: null,
              presetId: null,
            })
          }
          disabled={disabled}
          models={modelOptions}
          shortcut={modelShortcut}
          side={side}
          className={modelClassName}
          layer={layer}
        />
      )}
    </>
  );
}

function getOpenCodeModelGroup(
  model: ModelPreference,
  backend: AgentBackendType,
): string | undefined {
  if (backend !== 'opencode') return undefined;

  const separatorIndex = model.indexOf('/');
  if (separatorIndex <= 0) return undefined;

  return model.slice(0, separatorIndex);
}

function insertMissingModelOption({
  options,
  missingOption,
}: {
  options: BackendModelOption[];
  missingOption: BackendModelOption;
}): BackendModelOption[] {
  if (!missingOption.group) {
    return [missingOption, ...options];
  }

  const insertIndex = options.findIndex(
    (option) => option.group === missingOption.group,
  );
  if (insertIndex === -1) {
    return [...options, missingOption];
  }

  return [
    ...options.slice(0, insertIndex),
    missingOption,
    ...options.slice(insertIndex),
  ];
}
