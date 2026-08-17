import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { GripVertical, Plus, Star, Trash2 } from 'lucide-react';
import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { CSS } from '@dnd-kit/utilities';
import { nanoid } from 'nanoid';



import {
  AVAILABLE_BACKENDS,
  getModelLabel,
  getModelsForBackend,
  getModelThinkingCapabilities,
} from '@/features/agent/ui-backend-selector';
import {
  getThinkingEffortOptions,
  normalizeThinkingEffortForModel,
} from '@shared/thinking-settings';
import { Select, type SelectOption } from '@/common/ui/select';
import {
  useBackendModelPresetsSetting,
  useBackendsSetting,
  useModelQuickSwitcherSetting,
  useUpdateBackendModelPresetsSetting,
  useUpdateModelQuickSwitcherSetting,
} from '@/hooks/use-settings';
import type { AgentBackendType } from '@shared/agent-backend-types';
import type { BackendModelPreset } from '@shared/types';
import { BackendsSettings } from '@/features/settings/ui-general-settings';
import { Button } from '@/common/ui/button';
import { ModelSelector } from '@/features/agent/ui-model-selector';
import { Switch } from '@/common/ui/switch';
import { ThinkingSelector } from '@/features/agent/ui-thinking-selector';
import { useBackendModels } from '@/hooks/use-backend-models';



const EMPTY_PRESETS: BackendModelPreset[] = [];

const BACKEND_DOT_CLASS: Record<AgentBackendType, string> = {
  'claude-code': 'bg-acc',
  opencode: 'bg-status-azure',
  codex: 'bg-status-done',
  copilot: 'bg-status-pr',
  vibe: 'bg-status-run',
};

function PresetRow({
  preset,
  index,
  disabled,
  backendOptions,
  onChange,
  onCommit,
  onDelete,
}: {
  preset: BackendModelPreset;
  index: number;
  disabled: boolean;
  backendOptions: SelectOption<AgentBackendType>[];
  onChange: (update: Partial<BackendModelPreset>, commit?: boolean) => void;
  onCommit: () => void;
  onDelete: () => void;
}) {
  const { data: dynamicModels, isFetched } = useBackendModels(preset.backend);
  const thinkingCapabilities = getModelThinkingCapabilities(
    preset.model,
    dynamicModels,
  );
  const thinkingOptions = getThinkingEffortOptions({
    backend: preset.backend,
    model: preset.model,
    capabilities: thinkingCapabilities,
  });
  const thinkingEffort = normalizeThinkingEffortForModel({
    backend: preset.backend,
    model: preset.model,
    effort: preset.thinkingEffort,
    capabilities: thinkingCapabilities,
  });
  const modelOptions = useMemo(() => {
    const availableModels = getModelsForBackend(preset.backend, dynamicModels);

    if (availableModels.some((model) => model.value === preset.model)) {
      return availableModels;
    }

    return [
      {
        value: preset.model,
        label: getModelLabel(preset.model, preset.backend, dynamicModels),
        description: isFetched ? 'Previously selected model' : 'Loading model',
      },
      ...availableModels,
    ];
  }, [dynamicModels, isFetched, preset.backend, preset.model]);

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: preset.id, disabled });

  const pinned = preset.showInQuickSwitcher !== false;

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.55 : 1,
      }}
      className={clsx(
        'group border-line-soft hover:bg-glass-medium/40 relative flex items-center gap-2 border-b py-2 pr-2 pl-1 last:border-b-0',
        isDragging && 'bg-bg-2',
      )}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        disabled={disabled}
        className="text-ink-4 hover:text-ink-2 shrink-0 cursor-grab rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-0"
        aria-label={`Reorder ${preset.name || `preset ${index + 1}`}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>

      <input
        value={preset.name}
        onChange={(event) => onChange({ name: event.target.value }, false)}
        onBlur={onCommit}
        placeholder="Untitled"
        title={preset.name || undefined}
        aria-label={`Name for ${preset.name || `preset ${index + 1}`}`}
        className="text-ink-1 placeholder:text-ink-4 hover:border-line-soft focus:bg-bg-2 focus:border-acc w-32 shrink-0 truncate rounded-md border border-transparent bg-transparent px-2 py-1 text-[13px] font-medium outline-none"
      />

      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        <Select
          size="sm"
          value={preset.backend}
          onChange={(backend) =>
            onChange({
              backend,
              model: 'default',
              thinkingEffort: 'default',
            })
          }
          options={backendOptions}
        />
        <ModelSelector
          size="sm"
          value={preset.model}
          onChange={(model) => {
            const capabilities = getModelThinkingCapabilities(
              model,
              dynamicModels,
            );
            onChange({
              model,
              thinkingEffort: normalizeThinkingEffortForModel({
                backend: preset.backend,
                model,
                effort: preset.thinkingEffort,
                capabilities,
              }),
            });
          }}
          models={modelOptions}
        />
        <ThinkingSelector
          size="sm"
          value={thinkingEffort}
          onChange={(nextThinkingEffort) =>
            onChange({ thinkingEffort: nextThinkingEffort })
          }
          options={thinkingOptions}
          disabled={thinkingOptions.length <= 1}
        />
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={() => onChange({ showInQuickSwitcher: !pinned })}
          title={
            pinned ? 'Shown in quick switcher' : 'Hidden from quick switcher'
          }
          aria-pressed={pinned}
          aria-label={`Toggle quick switcher for ${preset.name || 'preset'}`}
          className={clsx(
            'hover:bg-bg-3 grid h-7 w-7 place-items-center rounded-md',
            pinned ? 'text-acc-ink' : 'text-ink-4 hover:text-ink-1',
          )}
        >
          <Star className={clsx('h-3.5 w-3.5', pinned && 'fill-current')} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${preset.name || 'preset'}`}
          className="text-ink-4 hover:bg-status-fail/15 hover:text-status-fail grid h-7 w-7 place-items-center rounded-md opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export function ModelPresetsSettings() {
  const { data: backendsSetting } = useBackendsSetting();
  const { data: serverPresets } = useBackendModelPresetsSetting();
  const [presets, setPresets] = useState<BackendModelPreset[]>(EMPTY_PRESETS);
  const presetsRef = useRef<BackendModelPreset[]>(EMPTY_PRESETS);
  const { data: quickSwitcherSetting } = useModelQuickSwitcherSetting();
  const updateQuickSwitcher = useUpdateModelQuickSwitcherSetting();
  const updatePresets = useUpdateBackendModelPresetsSetting();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  useEffect(() => {
    if (!serverPresets) return;
    presetsRef.current = serverPresets;
    startTransition(() => setPresets(serverPresets));
  }, [serverPresets]);

  const commitPresets = (next: BackendModelPreset[], commit = true) => {
    presetsRef.current = next;
    setPresets(next);
    if (commit) updatePresets.mutate(next);
  };

  const enabledBackends = useMemo(
    () =>
      backendsSetting?.enabledBackends ??
      (['claude-code'] as AgentBackendType[]),
    [backendsSetting?.enabledBackends],
  );
  const backendOptions = useMemo(
    () =>
      AVAILABLE_BACKENDS.filter((backend) =>
        enabledBackends.includes(backend.value),
      ).map(
        (backend): SelectOption<AgentBackendType> => ({
          value: backend.value,
          label: backend.label,
          description: backend.description,
          badge: backend.badge,
        }),
      ),
    [enabledBackends],
  );

  const quickSwitcherEnabled = quickSwitcherSetting?.enabled ?? false;

  const pinnedPresets = useMemo(
    () => presets.filter((preset) => preset.showInQuickSwitcher !== false),
    [presets],
  );

  const updatePreset = (
    presetId: string,
    update: Partial<BackendModelPreset>,
    commit = true,
  ) => {
    commitPresets(
      presetsRef.current.map((preset) =>
        preset.id === presetId ? { ...preset, ...update } : preset,
      ),
      commit,
    );
  };

  const handleAddPreset = () => {
    const defaultBackend: AgentBackendType =
      enabledBackends[0] ?? 'claude-code';
    commitPresets([
      ...presetsRef.current,
      {
        id: nanoid(),
        name: '',
        backend: defaultBackend,
        model: 'default',
        thinkingEffort: 'default',
        showInQuickSwitcher: true,
      },
    ]);
  };

  const handleDeletePreset = (presetId: string) => {
    commitPresets(
      presetsRef.current.filter((preset) => preset.id !== presetId),
    );
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const current = presetsRef.current;
    const oldIndex = current.findIndex((preset) => preset.id === active.id);
    const newIndex = current.findIndex((preset) => preset.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    commitPresets(arrayMove(current, oldIndex, newIndex));
  };

  return (
    <div>
      <BackendsSettings />

      <div className="border-line-soft my-8 border-t" />

      <h2 className="text-ink-1 text-lg font-semibold">Model presets</h2>
      <p className="text-ink-3 mt-1 max-w-[460px] text-sm">
        Backend, model and thinking level in one shot. Starred presets appear in
        the task composer&rsquo;s quick switcher.
      </p>

      {backendOptions.length === 0 ? (
        <div className="border-line-soft bg-bg-0 text-ink-3 mt-4 rounded-xl border px-4 py-3 text-sm">
          Enable at least one backend in Coding Agents before creating model
          presets.
        </div>
      ) : (
        <>
          <div className="border-glass-border bg-bg-1 mt-4 overflow-hidden rounded-xl border">
            {presets.length === 0 ? (
              <div className="text-ink-3 px-4 py-8 text-center text-sm">
                No presets yet. Create one for common backend and model
                combinations.
              </div>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={presets.map((preset) => preset.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {presets.map((preset, index) => (
                    <PresetRow
                      key={preset.id}
                      preset={preset}
                      index={index}
                      disabled={presets.length < 2}
                      backendOptions={backendOptions}
                      onChange={(update, commit) =>
                        updatePreset(preset.id, update, commit)
                      }
                      onCommit={() => commitPresets(presetsRef.current)}
                      onDelete={() => handleDeletePreset(preset.id)}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            )}

            <div className="border-line-soft flex items-center justify-between gap-3 border-t px-2 py-1.5">
              <Button variant="ghost" size="sm" icon={<Plus />} onClick={handleAddPreset}>
                Add preset
              </Button>
              <span className="text-ink-4 font-mono text-[10.5px] tracking-wide">
                ★ = quick switcher · drag to reorder
              </span>
            </div>
          </div>

        </>
      )}

      <div className="border-glass-border bg-bg-1 mt-4 rounded-xl border p-4">
        <Switch
          checked={quickSwitcherEnabled}
          onChange={(enabled) => updateQuickSwitcher.mutate({ enabled })}
          label="Use quick model switcher"
        />
        <p className="text-ink-3 mt-1 text-sm">
          Replace model dropdown with quick-switch presets in task forms.
        </p>
        <div
          role="group"
          aria-label="Quick switcher preview"
          className={clsx(
            'border-line-soft bg-bg-0 mt-3 flex flex-wrap gap-1.5 rounded-lg border px-2.5 py-2',
            !quickSwitcherEnabled && 'opacity-45',
          )}
        >
          {pinnedPresets.length === 0 ? (
            <span className="text-ink-4 font-mono text-[10.5px]">
              No starred presets
            </span>
          ) : (
            pinnedPresets.map((preset) => (
              <span
                key={preset.id}
                className="border-line-soft bg-bg-2 text-ink-2 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
              >
                <span
                  className={clsx(
                    'h-1.5 w-1.5 rounded-full',
                    BACKEND_DOT_CLASS[preset.backend],
                  )}
                />
                {preset.name || 'Untitled'}
              </span>
            ))
          )}
          <span className="border-line-soft bg-bg-2 text-ink-4 inline-flex items-center rounded-full border px-2.5 py-1 text-xs">
            Custom…
          </span>
        </div>
      </div>
    </div>
  );
}
