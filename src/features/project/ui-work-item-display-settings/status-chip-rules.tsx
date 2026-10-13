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
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronUp, GripVertical, Plus, Trash2 } from 'lucide-react';
import { useMemo } from 'react';

import { Button } from '@/common/ui/button';
import { Combobox, type ComboboxOption } from '@/common/ui/combobox';
import { Input } from '@/common/ui/input';
import type { AzureDevOpsBoardColumn } from '@/lib/api';
import type {
  AzureFieldRefName,
  WorkItemFieldMetadata,
} from '@shared/work-item-field-types';
import {
  WORK_ITEM_STATUS_CHIP_TONES,
  type WorkItemStatusChipRule,
} from '@shared/work-item-status-chip-types';

const TONE_LABELS: Record<(typeof WORK_ITEM_STATUS_CHIP_TONES)[number], string> = {
  warning: 'Warning',
  danger: 'Danger',
  info: 'Info',
  success: 'Success',
  neutral: 'Neutral',
};

const VALUE_FIELDS_WITH_BOARD_OPTIONS = new Set([
  'System.State',
  'System.BoardColumn',
]);

function optionsForValues({
  field,
  values,
  boardColumns,
}: {
  field: string;
  values: string[];
  boardColumns: AzureDevOpsBoardColumn[];
}): ComboboxOption[] {
  if (!VALUE_FIELDS_WITH_BOARD_OPTIONS.has(field) || boardColumns.length === 0) {
    return [];
  }

  const availableValues = new Set(values.filter(Boolean));
  for (const column of boardColumns) {
    if (field === 'System.BoardColumn') availableValues.add(column.name);
    if (field === 'System.State') {
      for (const state of Object.keys(column.stateMappings)) availableValues.add(state);
    }
  }

  return [...availableValues]
    .sort((left, right) => left.localeCompare(right))
    .map((value) => ({ value, label: value }));
}

function SortableStatusChipRule({
  rule,
  index,
  ruleCount,
  fields,
  metadataMap,
  boardColumns,
  onChange,
  onMove,
  onRemove,
}: {
  rule: WorkItemStatusChipRule;
  index: number;
  ruleCount: number;
  fields: WorkItemFieldMetadata[];
  metadataMap: Record<string, WorkItemFieldMetadata>;
  boardColumns: AzureDevOpsBoardColumn[];
  onChange: (patch: Partial<WorkItemStatusChipRule>) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: rule.id });
  const valueOptions = optionsForValues({
    field: rule.field,
    values: rule.values,
    boardColumns,
  });
  const fieldOptions = fields.map((field) => ({
    value: field.refName,
    label: `${field.name} (${field.refName})`,
  }));
  if (!metadataMap[rule.field]) {
    fieldOptions.push({ value: rule.field, label: rule.field });
  }

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.55 : 1,
      }}
      className="border-line-soft rounded-md border p-2.5"
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="text-ink-3 hover:text-ink-1 mt-5 cursor-grab touch-none"
          aria-label={`Drag ${rule.label}`}
          title="Drag to reorder"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" aria-hidden />
        </button>
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-ink-3 text-[10px] uppercase">Field</span>
          <Combobox
            label={`Field for ${rule.label}`}
            value={rule.field}
            options={fieldOptions}
            onChange={(field) => onChange({ field: field as AzureFieldRefName })}
            placeholder="Select field..."
            searchPlaceholder="Search fields..."
            size="sm"
            className="w-full"
          />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-ink-3 text-[10px] uppercase">Values</span>
          {valueOptions.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {rule.values.map((value, valueIndex) => (
                <div key={`${rule.id}-${valueIndex}`} className="flex min-w-28 flex-1 gap-1">
                  <Combobox
                    label={`Value ${valueIndex + 1} for ${rule.label}`}
                    value={value}
                    options={valueOptions}
                    onChange={(nextValue) =>
                      onChange({
                        values: rule.values.map((candidate, candidateIndex) =>
                          candidateIndex === valueIndex ? nextValue : candidate,
                        ),
                      })
                    }
                    placeholder="Select value..."
                    searchPlaceholder="Search values..."
                    size="sm"
                    className="min-w-0 flex-1"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-label={`Remove value ${valueIndex + 1} for ${rule.label}`}
                    onClick={() =>
                      onChange({
                        values: rule.values.filter(
                          (_candidate, candidateIndex) => candidateIndex !== valueIndex,
                        ),
                      })
                    }
                  >
                    <Trash2 className="h-3 w-3" aria-hidden />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label={`Add value for ${rule.label}`}
                onClick={() => onChange({ values: [...rule.values, ''] })}
              >
                <Plus className="h-3 w-3" aria-hidden />
              </Button>
            </div>
          ) : (
            <Input
              size="sm"
              aria-label={`Values for ${rule.label}`}
              value={rule.values.join(', ')}
              placeholder="Comma-separated values"
              onChange={(event) =>
                onChange({
                  values: event.target.value.split(',').map((value) => value.trim()),
                })
              }
            />
          )}
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-ink-3 text-[10px] uppercase">Chip label</span>
          <Input
            size="sm"
            aria-label={`Label for ${rule.label}`}
            value={rule.label}
            onChange={(event) => onChange({ label: event.target.value })}
          />
        </label>
        <label className="flex w-24 shrink-0 flex-col gap-1">
          <span className="text-ink-3 text-[10px] uppercase">Tone</span>
          <Combobox
            label={`Tone for ${rule.label}`}
            value={rule.tone}
            options={WORK_ITEM_STATUS_CHIP_TONES.map((tone) => ({
              value: tone,
              label: TONE_LABELS[tone],
            }))}
            onChange={(tone) =>
              onChange({ tone: tone as WorkItemStatusChipRule['tone'] })
            }
            searchPlaceholder="Search tones..."
            size="sm"
            className="w-full"
          />
        </label>
        <div className="flex shrink-0 items-end gap-0.5 pt-4">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            icon={<ChevronUp />}
            aria-label={`Move ${rule.label} up`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          />
          <Button
            type="button"
            variant="ghost"
            size="xs"
            icon={<ChevronDown />}
            aria-label={`Move ${rule.label} down`}
            disabled={index === ruleCount - 1}
            onClick={() => onMove(1)}
          />
          <Button
            type="button"
            variant="ghost"
            size="xs"
            icon={<Trash2 />}
            aria-label={`Remove ${rule.label}`}
            onClick={onRemove}
          />
        </div>
      </div>
      <label className="text-ink-3 mt-2 inline-flex items-center gap-1.5 text-[11px]">
        <input
          type="checkbox"
          checked={rule.enabled}
          onChange={(event) => onChange({ enabled: event.target.checked })}
        />
        Enabled
      </label>
    </div>
  );
}

export function StatusChipRules({
  rules,
  metadataMap,
  boardColumns,
  onChange,
}: {
  rules: WorkItemStatusChipRule[];
  metadataMap: Record<string, WorkItemFieldMetadata>;
  boardColumns?: AzureDevOpsBoardColumn[];
  onChange: (rules: WorkItemStatusChipRule[]) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const fields = useMemo(
    () => Object.values(metadataMap).sort((a, b) => a.name.localeCompare(b.name)),
    [metadataMap],
  );

  function updateRule(id: string, patch: Partial<WorkItemStatusChipRule>) {
    onChange(rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
  }

  function addRule() {
    onChange([
      ...rules,
      {
        id: `status-chip-${Date.now()}`,
        field: 'System.State',
        values: ['Blocked'],
        label: 'Blocked',
        tone: 'warning',
        enabled: true,
      },
    ]);
  }

  function moveRule(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= rules.length) return;
    const next = [...rules];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = rules.findIndex((rule) => rule.id === active.id);
    const newIndex = rules.findIndex((rule) => rule.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    onChange(arrayMove(rules, oldIndex, newIndex));
  }

  return (
    <div className="border-line-soft mt-5 border-t pt-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-ink-1 text-xs font-semibold tracking-wide uppercase">
            Feed status chips
          </p>
          <p className="text-ink-3 mt-0.5 max-w-xl text-[11px] leading-relaxed">
            Show an informational chip on linked tasks when a work item field
            matches one of these values.
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          icon={<Plus />}
          aria-label="Add rule"
          onClick={addRule}
        >
          Add rule
        </Button>
      </div>

      {rules.length === 0 ? (
        <p className="text-ink-3 mt-3 rounded-md border border-dashed border-line-soft px-3 py-2 text-xs">
          No status chips configured.
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={rules.map((rule) => rule.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="mt-3 space-y-2">
              {rules.map((rule, index) => (
                <SortableStatusChipRule
                  key={rule.id}
                  rule={rule}
                  index={index}
                  ruleCount={rules.length}
                  fields={fields}
                  metadataMap={metadataMap}
                  boardColumns={boardColumns ?? []}
                  onChange={(patch) => updateRule(rule.id, patch)}
                  onMove={(direction) => moveRule(index, direction)}
                  onRemove={() => onChange(rules.filter((entry) => entry.id !== rule.id))}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}
