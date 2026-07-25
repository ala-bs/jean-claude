import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  ChevronDown,
  ChevronUp,
  GripVertical,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
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
import { Input } from '@/common/ui/input';
import { ModelSelector } from '@/features/agent/ui-model-selector';
import { Switch } from '@/common/ui/switch';
import { ThinkingSelector } from '@/features/agent/ui-thinking-selector';
import { useBackendModels } from '@/hooks/use-backend-models';



const EMPTY_PRESETS: BackendModelPreset[] = [];

function PresetCard({
  preset,
  index,
  presetCount,
  disabled,
  backendOptions,
  onChange,
  onCommit,
  onMove,
  onDelete,
}: {
  preset: BackendModelPreset;
  index: number;
  presetCount: number;
  disabled: boolean;
  backendOptions: SelectOption<AgentBackendType>[];
  onChange: (update: Partial<BackendModelPreset>, commit?: boolean) => void;
  onCommit: () => void;
  onMove: (direction: -1 | 1) => void;
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

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.55 : 1,
      }}
      className={clsx(
        'border-glass-border bg-bg-1 rounded-xl border p-4',
        isDragging && 'border-acc/60 shadow-lg',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="mt-1 flex items-center">
          <button
            ref={setActivatorNodeRef}
            type="button"
            disabled={disabled}
            className="text-ink-3 hover:bg-glass-medium hover:text-ink-1 cursor-grab rounded p-1 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={`Reorder ${preset.name || `preset ${index + 1}`}`}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>
          <div className="flex flex-col">
            <Button
              variant="ghost"
              size="sm"
              icon={<ChevronUp />}
              disabled={disabled || index === 0}
              onClick={() => onMove(-1)}
              aria-label={`Move ${preset.name || `preset ${index + 1}`} up`}
            />
            <Button
              variant="ghost"
              size="sm"
              icon={<ChevronDown />}
              disabled={disabled || index === presetCount - 1}
              onClick={() => onMove(1)}
              aria-label={`Move ${preset.name || `preset ${index + 1}`} down`}
            />
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-ink-1 text-sm font-medium">Preset name</div>
          <Input
            value={preset.name}
            onChange={(event) => onChange({ name: event.target.value }, false)}
            onBlur={onCommit}
            placeholder="Fast review, Deep planning..."
            className="mt-2"
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          icon={<Trash2 />}
          onClick={onDelete}
          aria-label={`Delete ${preset.name || 'preset'}`}
        >
          Delete
        </Button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Select
          value={preset.backend}
          onChange={(backend) =>
            onChange({
              backend,
              model: 'default',
              thinkingEffort: 'default',
            })
          }
          options={backendOptions}
          label="Backend"
        />
        <ModelSelector
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
          value={thinkingEffort}
          onChange={(nextThinkingEffort) =>
            onChange({ thinkingEffort: nextThinkingEffort })
          }
          options={thinkingOptions}
          disabled={thinkingOptions.length <= 1}
        />
      </div>
      <Switch
        checked={preset.showInQuickSwitcher !== false}
        onChange={(showInQuickSwitcher) => onChange({ showInQuickSwitcher })}
        label="Show in quick switcher"
        className="mt-4"
      />
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

  const movePreset = (index: number, direction: -1 | 1) => {
    const current = presetsRef.current;
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= current.length) return;
    commitPresets(arrayMove(current, index, nextIndex));
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

      <div className="border-glass-border bg-bg-1 rounded-xl border p-4">
        <Switch
          checked={quickSwitcherSetting?.enabled ?? false}
          onChange={(enabled) => updateQuickSwitcher.mutate({ enabled })}
          label="Use quick model switcher"
        />
        <p className="text-ink-3 mt-1 text-sm">
          Replace model dropdown with quick-switch presets in task forms.
        </p>
      </div>

      <div className="mt-2 flex items-start justify-between gap-4">
        <Button icon={<Plus />} onClick={handleAddPreset}>
          Add preset
        </Button>
      </div>

      {backendOptions.length === 0 ? (
        <div className="border-line-soft bg-bg-0 text-ink-3 mt-4 rounded-xl border px-4 py-3 text-sm">
          Enable at least one backend in Coding Agents before creating model
          presets.
        </div>
      ) : presets.length === 0 ? (
        <div className="border-line-soft bg-bg-0 text-ink-3 mt-4 rounded-xl border px-4 py-8 text-center text-sm">
          No presets yet. Create one for common backend and model combinations.
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
            <div className="mt-4 space-y-3">
              {presets.map((preset, index) => (
                <PresetCard
                  key={preset.id}
                  preset={preset}
                  index={index}
                  presetCount={presets.length}
                  disabled={presets.length < 2}
                  onMove={(direction) => movePreset(index, direction)}
                  backendOptions={backendOptions}
                  onChange={(update, commit) =>
                    updatePreset(preset.id, update, commit)
                  }
                  onCommit={() => commitPresets(presetsRef.current)}
                  onDelete={() => handleDeletePreset(preset.id)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}
