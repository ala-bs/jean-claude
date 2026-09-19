import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  ArrowDown,
  ArrowUp,
  Eye,
  EyeOff,
  GripVertical,
  Plus,
  Trash2,
} from 'lucide-react';
import type {
  AzureFieldRefName,
  WorkItemFieldMetadata,
} from '@shared/work-item-field-types';
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useMemo, useState } from 'react';

import { Button } from '@/common/ui/button';
import { CSS } from '@dnd-kit/utilities';
import { WORK_ITEM_DISPLAY_CONFIG_MAX_ROWS } from '@shared/work-item-display-config-types';
import type { WorkItemRowConfig } from '@shared/work-item-display-config-types';

export type FieldMetadataMap = Record<AzureFieldRefName, WorkItemFieldMetadata>;

/** The human label for a refName; falls back to the raw refName (F2). */
export function fieldLabel(
  refName: AzureFieldRefName,
  metadataMap: FieldMetadataMap,
): string {
  return metadataMap[refName]?.name ?? refName;
}

const selectClassName =
  'border-glass-border bg-bg-1 text-ink-1 h-7 min-w-0 flex-1 rounded-md border px-2 text-xs';

/**
 * "Add a field" control. A native select on purpose: this pane must stay
 * renderable without the keyboard-binding / overlay contexts that the fancy
 * `Select` and `Combobox` components require.
 */
export function FieldPicker({
  metadataMap,
  excludeRefNames,
  listLabel,
  disabled,
  onAdd,
}: {
  metadataMap: FieldMetadataMap;
  excludeRefNames: AzureFieldRefName[];
  listLabel: string;
  disabled?: boolean;
  onAdd: (refName: AzureFieldRefName) => void;
}) {
  const [selected, setSelected] = useState('');
  const excluded = useMemo(
    () => new Set(excludeRefNames),
    [excludeRefNames],
  );
  const options = useMemo(
    () =>
      Object.values(metadataMap)
        .filter((field) => !excluded.has(field.refName))
        .sort((left, right) => left.name.localeCompare(right.name)),
    [metadataMap, excluded],
  );
  const value = options.some((option) => option.refName === selected)
    ? selected
    : '';

  return (
    <div className="flex items-center gap-2">
      <select
        aria-label={`Field to add to ${listLabel}`}
        className={selectClassName}
        disabled={disabled || options.length === 0}
        value={value}
        onChange={(event) => setSelected(event.target.value)}
      >
        <option value="">Add a field…</option>
        {options.map((option) => (
          <option key={option.refName} value={option.refName}>
            {option.name}
          </option>
        ))}
      </select>
      <Button
        type="button"
        variant="secondary"
        size="xs"
        icon={<Plus />}
        aria-label={`Add the selected field to ${listLabel}`}
        disabled={disabled || !value}
        onClick={() => {
          if (!value) return;
          onAdd(value);
          setSelected('');
        }}
      >
        Add
      </Button>
    </div>
  );
}

function SortableFieldRow({
  row,
  index,
  rowCount,
  listLabel,
  metadataMap,
  metadataResolved,
  onMove,
  onToggle,
  onRemove,
}: {
  row: WorkItemRowConfig;
  index: number;
  rowCount: number;
  listLabel: string;
  metadataMap: FieldMetadataMap;
  metadataResolved: boolean;
  onMove: (direction: -1 | 1) => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: row.refName });
  const metadata = metadataMap[row.refName];
  const label = fieldLabel(row.refName, metadataMap);
  const unavailable = metadataResolved && !metadata;
  const restrictedTo = metadata?.validWorkItemTypes ?? [];

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.55 : 1,
      }}
      className="border-glass-border bg-bg-1/55 flex items-center gap-2 rounded-lg border px-2 py-1.5"
    >
      <button
        type="button"
        className="text-ink-3 hover:text-ink-1 cursor-grab"
        aria-label={`Drag ${label} in ${listLabel}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden />
      </button>

      <div className="min-w-0 flex-1">
        <p className="text-ink-1 truncate text-xs font-medium">
          {label}
          {unavailable && (
            <span className="border-status-fail/30 bg-status-fail/10 text-status-fail ml-2 rounded border px-1 py-0.5 text-[10px] font-semibold">
              Unavailable
            </span>
          )}
        </p>
        <p className="text-ink-3 truncate font-mono text-[10px]">
          {row.refName}
          {restrictedTo.length > 0 && (
            <span className="ml-2 font-sans">
              only on: {restrictedTo.join(', ')}
            </span>
          )}
        </p>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="xs"
        icon={row.visible ? <Eye /> : <EyeOff />}
        aria-label={`${row.visible ? 'Hide' : 'Show'} ${label} in ${listLabel}`}
        title={row.visible ? 'Visible' : 'Hidden'}
        onClick={onToggle}
      />
      <Button
        type="button"
        variant="ghost"
        size="xs"
        icon={<ArrowUp />}
        aria-label={`Move ${label} up in ${listLabel}`}
        disabled={index === 0}
        onClick={() => onMove(-1)}
      />
      <Button
        type="button"
        variant="ghost"
        size="xs"
        icon={<ArrowDown />}
        aria-label={`Move ${label} down in ${listLabel}`}
        disabled={index === rowCount - 1}
        onClick={() => onMove(1)}
      />
      <Button
        type="button"
        variant="ghost"
        size="xs"
        icon={<Trash2 />}
        aria-label={`Remove ${label} from ${listLabel}`}
        onClick={onRemove}
      />
    </li>
  );
}

/** Ordered, drag-reorderable field list with per-row visibility toggles. */
export function RowListEditor({
  rows,
  listLabel,
  metadataMap,
  metadataResolved,
  onChange,
}: {
  rows: WorkItemRowConfig[];
  listLabel: string;
  metadataMap: FieldMetadataMap;
  metadataResolved: boolean;
  onChange: (rows: WorkItemRowConfig[]) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const refNames = useMemo(() => rows.map((row) => row.refName), [rows]);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = refNames.indexOf(String(active.id));
    const newIndex = refNames.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    onChange(arrayMove(rows, oldIndex, newIndex));
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= rows.length) return;
    onChange(arrayMove(rows, index, target));
  }

  return (
    <div className="space-y-2">
      {rows.length === 0 ? (
        <p className="border-glass-border bg-bg-1/40 text-ink-3 rounded-lg border border-dashed px-3 py-4 text-center text-xs">
          No fields. Add one below.
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={refNames}
            strategy={verticalListSortingStrategy}
          >
            <ul className="space-y-1.5">
              {rows.map((row, index) => (
                <SortableFieldRow
                  key={row.refName}
                  row={row}
                  index={index}
                  rowCount={rows.length}
                  listLabel={listLabel}
                  metadataMap={metadataMap}
                  metadataResolved={metadataResolved}
                  onMove={(direction) => move(index, direction)}
                  onToggle={() =>
                    onChange(
                      rows.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? { ...candidate, visible: !candidate.visible }
                          : candidate,
                      ),
                    )
                  }
                  onRemove={() =>
                    onChange(
                      rows.filter(
                        (_candidate, candidateIndex) => candidateIndex !== index,
                      ),
                    )
                  }
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      <FieldPicker
        metadataMap={metadataMap}
        excludeRefNames={refNames}
        listLabel={listLabel}
        disabled={rows.length >= WORK_ITEM_DISPLAY_CONFIG_MAX_ROWS}
        onAdd={(refName) => onChange([...rows, { refName, visible: true }])}
      />
    </div>
  );
}
