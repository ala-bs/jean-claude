import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  ChevronRight,
  GitBranch,
  GripVertical,
  Layers,
  Plus,
  Timer,
  Trash2,
  X,
} from 'lucide-react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { CSS } from '@dnd-kit/utilities';
import type { DragEndEvent } from '@dnd-kit/core';

import {
  createCommandGroupStage,
  flattenCommandGroupStages,
  getRunCommandDisplayName,
  isSequentialCommandGroup,
  MAX_COMMAND_GROUP_STAGE_DELAY_MS,
} from '@shared/run-command-types';
import type {
  ProjectCommand,
  ProjectCommandGroup,
  ProjectCommandGroupStage,
  UpdateProjectCommandGroup,
} from '@shared/run-command-types';
import { Checkbox } from '@/common/ui/checkbox';
import { IconButton } from '@/common/ui/icon-button';
import { Input } from '@/common/ui/input';
import { Select } from '@/common/ui/select';

import { useDebouncedUpdate } from './use-debounced-update';

const ADD_ENTRY_PLACEHOLDER = '__add__';
const MAX_DELAY_SECONDS = Math.floor(MAX_COMMAND_GROUP_STAGE_DELAY_MS / 1000);

function clampDelayMs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(
    Math.round(seconds * 1000),
    MAX_COMMAND_GROUP_STAGE_DELAY_MS,
  );
}

function EntryRow({
  sortableId,
  label,
  description,
  waitForExit,
  onWaitForExitChange,
  onRemove,
}: {
  sortableId: string;
  label: string;
  description?: string;
  waitForExit: boolean;
  onWaitForExitChange: (waitForExit: boolean) => void;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`border-glass-border bg-bg-0/20 flex items-center gap-2 rounded-lg border px-2 py-1.5 ${isDragging ? 'z-50 opacity-50' : ''}`}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        aria-label="Reorder command in stage"
        className="text-ink-4 hover:text-ink-2 shrink-0 cursor-grab touch-none active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="text-ink-1 truncate text-sm font-medium">{label}</div>
        {description && (
          <div className="text-ink-3 truncate font-mono text-xs">
            {description}
          </div>
        )}
      </div>
      <Checkbox
        size="sm"
        compact
        checked={waitForExit}
        onChange={onWaitForExitChange}
        label="Wait for exit"
        ariaLabel="Wait for this command to finish before the next stage"
      />
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove command from stage"
        className="text-ink-4 hover:text-ink-2 shrink-0 rounded-md p-1"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function StageSection({
  stage,
  stageIndex,
  isLast,
  commands,
  onChange,
  onRemove,
}: {
  stage: ProjectCommandGroupStage;
  stageIndex: number;
  isLast: boolean;
  commands: ProjectCommand[];
  onChange: (stage: ProjectCommandGroupStage) => void;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `stage:${stage.id}` });

  // Held locally while typing and committed on blur: writing on every keystroke
  // would issue a database write plus a refetch per character. The draft records
  // the persisted value it was based on, so if that changes underneath us
  // (refetch, another window) the draft is discarded during render rather than
  // overwriting the newer value on the next blur.
  const [delayDraft, setDelayDraft] = useState<{
    basedOn: number;
    text: string;
  } | null>(null);
  const activeDelayDraft =
    delayDraft && delayDraft.basedOn === stage.delayMs ? delayDraft : null;
  const delayInput =
    activeDelayDraft?.text ??
    (stage.delayMs > 0 ? String(stage.delayMs / 1000) : '');

  const entryIds = stage.entries.map(
    (_entry, index) => `entry:${stage.id}:${index}`,
  );

  // A command can repeat across stages (it restarts), but a repeat WITHIN a
  // stage is dropped at runtime, so it must not be offerable here.
  const stageCommandIds = new Set(
    stage.entries.map((entry) => entry.commandId),
  );
  // Hidden commands are dropped from the run plan, which can silently empty a
  // stage, so they are not offerable here.
  const addableCommands = commands.filter(
    (command) => !stageCommandIds.has(command.id) && !command.isHidden,
  );
  const addOptions = [
    { value: ADD_ENTRY_PLACEHOLDER, label: 'Add command…' },
    ...addableCommands.map((command) => ({
      value: command.id,
      label: getRunCommandDisplayName(command),
      description: command.name ? command.command : undefined,
    })),
  ];

  const handleAddEntry = (commandId: string) => {
    if (commandId === ADD_ENTRY_PLACEHOLDER) return;
    // Waiting is the safer default: a stage that does not wait silently races
    // the next one. Long-running commands opt out by unchecking it.
    onChange({
      ...stage,
      entries: [...stage.entries, { commandId, waitForExit: true }],
    });
  };

  const commitDelay = () => {
    if (activeDelayDraft === null) return;
    const text = activeDelayDraft.text;
    const delayMs = text.trim() === '' ? 0 : clampDelayMs(Number(text));
    setDelayDraft(null);
    if (delayMs !== stage.delayMs) onChange({ ...stage, delayMs });
  };

  // Browsers do not fire blur when a focused input is unmounted, so collapsing
  // the group or closing the panel mid-edit would otherwise discard the value.
  const commitDelayRef = useRef(commitDelay);
  useEffect(() => {
    commitDelayRef.current = commitDelay;
  });
  useEffect(() => () => commitDelayRef.current(), []);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`border-glass-border bg-bg-0/20 rounded-lg border p-2 ${isDragging ? 'z-50 opacity-50' : ''}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label="Reorder stage"
          className="text-ink-4 hover:text-ink-2 shrink-0 cursor-grab touch-none active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        <span className="text-ink-2 font-mono text-[11px] font-semibold tracking-wide uppercase">
          Stage {stageIndex + 1}
        </span>
        <span className="text-ink-3 font-mono text-[10px]">
          {stage.entries.length} cmd
          {stage.entries.length === 1 ? '' : 's'} in parallel
        </span>
        <div className="flex-1" />
        <IconButton
          variant="ghost"
          size="sm"
          onClick={onRemove}
          icon={<Trash2 />}
          tooltip="Remove stage"
        />
      </div>

      {stage.entries.length === 0 ? (
        <div className="border-glass-border bg-bg-0/30 text-ink-3 mb-2 rounded-lg border border-dashed px-3 py-2 text-xs">
          No commands in this stage yet.
        </div>
      ) : (
        <SortableContext items={entryIds} strategy={verticalListSortingStrategy}>
          <div className="mb-2 space-y-1.5">
            {stage.entries.map((entry, index) => {
              const command = commands.find(
                (item) => item.id === entry.commandId,
              );
              return (
                <EntryRow
                  key={`entry:${stage.id}:${index}`}
                  sortableId={`entry:${stage.id}:${index}`}
                  label={
                    command
                      ? getRunCommandDisplayName(command)
                      : 'Unknown command'
                  }
                  description={
                    command
                      ? command.name
                        ? command.command
                        : undefined
                      : entry.commandId
                  }
                  waitForExit={entry.waitForExit}
                  onWaitForExitChange={(waitForExit) =>
                    onChange({
                      ...stage,
                      entries: stage.entries.map((current, currentIndex) =>
                        currentIndex === index
                          ? { ...current, waitForExit }
                          : current,
                      ),
                    })
                  }
                  onRemove={() =>
                    onChange({
                      ...stage,
                      entries: stage.entries.filter(
                        (_current, currentIndex) => currentIndex !== index,
                      ),
                    })
                  }
                />
              );
            })}
          </div>
        </SortableContext>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Select
          size="sm"
          value={ADD_ENTRY_PLACEHOLDER}
          options={addOptions}
          onChange={handleAddEntry}
          disabled={addableCommands.length === 0}
          label="Add command to stage"
          className="w-52"
        />
        {!isLast && (
          <label className="text-ink-3 flex items-center gap-1.5 text-xs">
            <Timer className="h-3.5 w-3.5" />
            Wait
            <Input
              size="sm"
              type="number"
              min={0}
              max={MAX_DELAY_SECONDS}
              step={0.5}
              value={delayInput}
              onChange={(e) =>
                setDelayDraft({ basedOn: stage.delayMs, text: e.target.value })
              }
              onBlur={commitDelay}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              placeholder="0"
              className="w-16 text-right font-mono"
            />
            s before next stage
          </label>
        )}
      </div>
    </div>
  );
}

export function GroupRow({
  sortableId,
  group,
  commands,
  onUpdate,
  onDelete,
}: {
  sortableId: string;
  group: ProjectCommandGroup;
  commands: ProjectCommand[];
  onUpdate: (data: UpdateProjectCommandGroup) => void;
  onDelete: () => void;
}) {
  const [localName, setLocalName] = useState(group.name);
  const [isOpen, setIsOpen] = useState(true);

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const {
    schedule: scheduleUpdate,
    flush: flushUpdate,
    discard: discardUpdate,
    cancel: cancelUpdate,
    hasPending,
  } = useDebouncedUpdate<UpdateProjectCommandGroup>(onUpdate);

  useEffect(() => {
    if (hasPending('name', group.name)) return;
    startTransition(() => setLocalName(group.name));
  }, [group.name, hasPending]);

  const stages = group.stages;

  const selectedCount = useMemo(
    () =>
      flattenCommandGroupStages(stages).filter((id) =>
        commands.some((cmd) => cmd.id === id),
      ).length,
    [commands, stages],
  );
  const stageIds = useMemo(
    () => stages.map((stage) => `stage:${stage.id}`),
    [stages],
  );

  const handleNameChange = (value: string) => {
    setLocalName(value);
    const trimmed = value.trim();
    if (!trimmed || trimmed === group.name) {
      // Empty names are not persistable; drop any queued edit instead.
      discardUpdate('name');
      return;
    }
    scheduleUpdate({ name: trimmed });
  };

  const handleNameBlur = () => {
    flushUpdate();
    setLocalName((current) => current.trim() || group.name);
  };

  const handleStageChange = (nextStage: ProjectCommandGroupStage) => {
    onUpdate({
      stages: stages.map((stage) =>
        stage.id === nextStage.id ? nextStage : stage,
      ),
    });
  };

  const handleRemoveStage = (stageId: string) => {
    onUpdate({ stages: stages.filter((stage) => stage.id !== stageId) });
  };

  const handleAddStage = () => {
    onUpdate({ stages: [...stages, createCommandGroupStage()] });
  };

  const handleStageDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeId = String(active.id);
    const overId = String(over.id);

    if (activeId.startsWith('stage:') && overId.startsWith('stage:')) {
      const from = stageIds.indexOf(activeId);
      const to = stageIds.indexOf(overId);
      if (from === -1 || to === -1) return;
      onUpdate({ stages: arrayMove(stages, from, to) });
      return;
    }

    if (activeId.startsWith('entry:') && overId.startsWith('entry:')) {
      const [, activeStageId, activeIndex] = activeId.split(':');
      const [, overStageId, overIndex] = overId.split(':');
      // Cross-stage moves are not supported; use remove + add instead.
      if (activeStageId !== overStageId) return;
      onUpdate({
        stages: stages.map((stage) =>
          stage.id === activeStageId
            ? {
                ...stage,
                entries: arrayMove(
                  stage.entries,
                  Number(activeIndex),
                  Number(overIndex),
                ),
              }
            : stage,
        ),
      });
    }
  };

  const isSequential = isSequentialCommandGroup({ stages });

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`border-acc-line/70 from-acc-soft/45 bg-glass-subtle relative overflow-hidden rounded-xl border bg-gradient-to-b to-transparent ${isDragging ? 'z-50 opacity-50' : ''}`}
    >
      <div className="from-acc to-status-azure absolute inset-y-0 left-0 w-0.5 bg-gradient-to-b" />
      <div className="flex items-center gap-2 px-3 py-2 pl-4">
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label="Reorder group"
          className="text-ink-4 hover:text-ink-2 shrink-0 cursor-grab touch-none active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setIsOpen((open) => !open)}
          className="text-ink-3 hover:bg-glass-light rounded p-1"
          aria-label={isOpen ? 'Collapse group' : 'Expand group'}
          aria-expanded={isOpen}
        >
          <ChevronRight
            className={`h-3.5 w-3.5 transition-transform ${isOpen ? 'rotate-90' : ''}`}
          />
        </button>
        <div className="border-acc-line bg-acc-soft flex h-6 w-6 shrink-0 items-center justify-center rounded-md border">
          <GitBranch className="text-acc-ink h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <Input
            size="md"
            value={localName}
            onChange={(e) => handleNameChange(e.target.value)}
            onBlur={handleNameBlur}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            placeholder="Group name"
            className="border-0 bg-transparent px-0 font-semibold"
          />
        </div>
        <span className="border-status-azure/30 bg-status-azure-soft text-status-azure flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wide uppercase">
          {isSequential ? (
            <Layers className="h-3 w-3" />
          ) : (
            <GitBranch className="h-3 w-3" />
          )}
          {isSequential ? `${stages.length} stages` : 'parallel'}
        </span>
        <span
          className="text-ink-3 font-mono text-[11px]"
          aria-label={`${selectedCount} commands selected`}
        >
          {selectedCount} cmd{selectedCount === 1 ? '' : 's'}
        </span>
        <IconButton
          variant="ghost"
          size="md"
          onClick={() => {
            cancelUpdate();
            onDelete();
          }}
          icon={<Trash2 />}
          tooltip="Delete group"
        />
      </div>

      {isOpen && (
        <div className="px-3 pb-3 pl-8">
          <p className="text-ink-3 mb-2 text-xs leading-5">
            Commands in the same stage start together; stages run one after
            another. Turn on “Wait for exit” for commands that must finish
            before the next stage — leave it off for long-running commands like
            dev servers. If a waited command exits non-zero, the remaining
            stages are skipped.
          </p>
          {commands.length === 0 ? (
            <div className="border-glass-border bg-bg-0/30 text-ink-3 rounded-lg border border-dashed px-3 py-2 text-sm">
              Add a command first, then include it in this group.
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleStageDragEnd}
            >
              <SortableContext
                items={stageIds}
                strategy={verticalListSortingStrategy}
              >
                <div className="border-l-acc-line space-y-2 border-l pl-3">
                  {stages.map((stage, index) => (
                    <div key={stage.id} className="relative">
                      <span className="bg-status-azure absolute top-4 -left-[15px] h-1.5 w-1.5 rounded-full shadow-[0_0_8px_var(--color-status-azure)]" />
                      <StageSection
                        stage={stage}
                        stageIndex={index}
                        isLast={index === stages.length - 1}
                        commands={commands}
                        onChange={handleStageChange}
                        onRemove={() => handleRemoveStage(stage.id)}
                      />
                    </div>
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
          <button
            type="button"
            onClick={handleAddStage}
            className="text-ink-3 hover:text-ink-1 hover:bg-glass-light mt-2 flex items-center gap-1 rounded-md px-2 py-1 text-xs"
          >
            <Plus className="h-3.5 w-3.5" />
            Add stage
          </button>
        </div>
      )}
    </div>
  );
}
