import {
  Check,
  GripVertical,
  HelpCircle,
  Plus,
  Settings,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { startTransition, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CSS } from '@dnd-kit/utilities';
import { useSortable } from '@dnd-kit/sortable';



import type {
  ProjectCommand,
  ProjectSuggestionCommand,
  RunCommandEnvSource,
  RunCommandEnvVar,
  UpdateProjectCommand,
} from '@shared/run-command-types';
import { Checkbox } from '@/common/ui/checkbox';
import { IconButton } from '@/common/ui/icon-button';
import { Input } from '@/common/ui/input';
import { RUN_COMMAND_ENV_SOURCES } from '@shared/run-command-types';
import { Select } from '@/common/ui/select';
import { Tooltip } from '@/common/ui/tooltip';
import { useDropdownPosition } from '@/common/hooks/use-dropdown-position';



import { PortChipInput } from './port-chip-input';

const ENV_SOURCE_OPTIONS = RUN_COMMAND_ENV_SOURCES.map((source) => ({
  value: source.key,
  label: source.label,
}));

function getPersistedEnvVars(envVars: RunCommandEnvVar[]) {
  return envVars.filter((envVar) => envVar.name.trim());
}

function areEnvVarsEqual(
  envVarsA: RunCommandEnvVar[],
  envVarsB: RunCommandEnvVar[],
) {
  if (envVarsA.length !== envVarsB.length) return false;

  return envVarsA.every((envVar, index) => {
    const other = envVarsB[index];
    return (
      envVar.source === other.source &&
      envVar.name === other.name &&
      (envVar.value ?? '') === (other.value ?? '')
    );
  });
}

export function CommandRow({
  sortableId,
  command,
  suggestions,
  onDraftChange,
  onUpdate,
  onDelete,
}: {
  sortableId: string;
  command: ProjectCommand;
  suggestions: string[];
  onDraftChange: (data: ProjectSuggestionCommand) => void;
  onUpdate: (data: UpdateProjectCommand) => void;
  onDelete: () => void;
}) {
  const [localName, setLocalName] = useState(command.name ?? '');
  const [localCommand, setLocalCommand] = useState(command.command);
  const [localConfirmMessage, setLocalConfirmMessage] = useState(
    command.confirmMessage ?? '',
  );
  const [localEnvVars, setLocalEnvVars] = useState(command.envVars);
  const [hasLocalEnvDraftRows, setHasLocalEnvDraftRows] = useState(false);
  const [hasPendingEnvEdits, setHasPendingEnvEdits] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const commandInputWrapRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    startTransition(() => setLocalName(command.name ?? ''));
  }, [command.name]);

  useEffect(() => {
    startTransition(() => setLocalCommand(command.command));
  }, [command.command]);

  useEffect(() => {
    startTransition(() => setLocalConfirmMessage(command.confirmMessage ?? ''));
  }, [command.confirmMessage]);

  useEffect(() => {
    if (hasPendingEnvEdits) {
      if (areEnvVarsEqual(command.envVars, getPersistedEnvVars(localEnvVars))) {
        startTransition(() => setHasPendingEnvEdits(false));
      }
      return;
    }

    if (!hasLocalEnvDraftRows) {
      startTransition(() => setLocalEnvVars(command.envVars));
    }
  }, [command.envVars, hasLocalEnvDraftRows, hasPendingEnvEdits, localEnvVars]);

  const filteredSuggestions = suggestions.filter(
    (s) =>
      s.toLowerCase().includes(localCommand.toLowerCase()) &&
      s !== localCommand,
  );
  const suggestionPosition = useDropdownPosition({
    isOpen: showSuggestions && filteredSuggestions.length > 0,
    triggerRef: commandInputWrapRef,
    side: 'bottom',
    align: 'left',
    preferredMaxHeight: 192,
  });

  const handleNameBlur = () => {
    const trimmed = localName.trim();
    const newValue = trimmed || null;
    if (newValue !== (command.name ?? null)) {
      onUpdate({ name: newValue });
    }
  };

  const emitDraftChange = (update: Partial<ProjectSuggestionCommand>) => {
    onDraftChange({
      name: localName.trim() || null,
      command: localCommand,
      ports: command.ports,
      envVars: getPersistedEnvVars(localEnvVars),
      confirmBeforeRun: command.confirmBeforeRun,
      confirmMessage: localConfirmMessage.trim() || null,
      ...update,
    });
  };

  const handleNameChange = (value: string) => {
    setLocalName(value);
    emitDraftChange({ name: value.trim() || null });
  };

  const handleCommandChange = (value: string) => {
    setLocalCommand(value);
    emitDraftChange({ command: value });
    setShowSuggestions(true);
  };

  const handleCommandBlur = () => {
    setTimeout(() => setShowSuggestions(false), 150);
    if (localCommand !== command.command) {
      onUpdate({ command: localCommand });
    }
  };

  const handleSelectSuggestion = (suggestion: string) => {
    setLocalCommand(suggestion);
    emitDraftChange({ command: suggestion });
    setShowSuggestions(false);
    onUpdate({ command: suggestion });
  };

  const handlePortsChange = (ports: number[]) => {
    emitDraftChange({ ports });
    onUpdate({ ports });
  };

  const handleEnvVarsChange = (envVars: RunCommandEnvVar[]) => {
    setLocalEnvVars(envVars);
    setHasLocalEnvDraftRows(envVars.some((envVar) => !envVar.name.trim()));
    setHasPendingEnvEdits(true);
    const persistedEnvVars = getPersistedEnvVars(envVars);
    emitDraftChange({ envVars: persistedEnvVars });
    onUpdate({ envVars: persistedEnvVars });
  };

  const handleAddEnvVar = () => {
    const envVars: RunCommandEnvVar[] = [
      ...localEnvVars,
      { source: 'taskName', name: '' },
    ];
    setLocalEnvVars(envVars);
    setHasLocalEnvDraftRows(true);
  };

  const handleEnvVarChange = (
    index: number,
    update: Partial<RunCommandEnvVar>,
  ) => {
    handleEnvVarsChange(
      localEnvVars.map((envVar, currentIndex) =>
        currentIndex === index ? { ...envVar, ...update } : envVar,
      ),
    );
  };

  const handleEnvSourceChange = (
    index: number,
    source: RunCommandEnvSource,
  ) => {
    const current = localEnvVars[index];
    handleEnvVarChange(index, {
      source,
      name: current.name,
      value: source === 'custom' ? (current.value ?? '') : undefined,
    });
  };

  const handleRemoveEnvVar = (index: number) => {
    handleEnvVarsChange(
      localEnvVars.filter((_, currentIndex) => currentIndex !== index),
    );
  };

  const handleConfirmToggle = (checked: boolean) => {
    emitDraftChange({ confirmBeforeRun: checked });
    onUpdate({ confirmBeforeRun: checked });
  };

  const handleConfirmMessageChange = (value: string) => {
    setLocalConfirmMessage(value);
    emitDraftChange({ confirmMessage: value.trim() || null });
  };

  const handleConfirmMessageBlur = () => {
    const trimmed = localConfirmMessage.trim();
    const newValue = trimmed || null;
    if (newValue !== (command.confirmMessage ?? null)) {
      onUpdate({ confirmMessage: newValue });
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`border-glass-border bg-glass-subtle relative overflow-visible rounded-lg border ${showSuggestions && filteredSuggestions.length > 0 ? 'z-40' : ''} ${isDragging ? 'z-50 opacity-50' : ''}`}
    >
      <div className="flex items-center gap-2 px-2 py-2">
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label="Reorder command"
          className="text-ink-4 hover:text-ink-2 shrink-0 cursor-grab touch-none active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <div className="border-glass-border w-28 shrink-0 border-r pr-2">
          <Input
            size="sm"
            value={localName}
            onChange={(e) => handleNameChange(e.target.value)}
            onBlur={handleNameBlur}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            placeholder="Optional display name"
            className="border-0 bg-transparent px-1"
          />
        </div>
        <div className="relative flex min-w-0 flex-1 items-center gap-2">
          <Terminal className="text-acc h-3.5 w-3.5 shrink-0" />
          <div ref={commandInputWrapRef} className="relative min-w-0 flex-1">
            <Input
              size="md"
              value={localCommand}
              onChange={(e) => handleCommandChange(e.target.value)}
              onFocus={() => setShowSuggestions(true)}
              onBlur={handleCommandBlur}
              placeholder="Enter command (e.g., pnpm dev)"
              className="border-0 bg-transparent px-0 font-mono"
            />
            {showSuggestions &&
              filteredSuggestions.length > 0 &&
              suggestionPosition &&
              createPortal(
                <div
                  className="border-glass-border bg-bg-2 fixed z-[70] overflow-auto rounded-md border py-1 shadow-[0_18px_44px_rgba(0,0,0,0.55)]"
                  style={{
                    top:
                      suggestionPosition.actualSide === 'bottom'
                        ? suggestionPosition.top
                        : undefined,
                    bottom:
                      suggestionPosition.actualSide === 'top'
                        ? window.innerHeight - suggestionPosition.top
                        : undefined,
                    left:
                      suggestionPosition.actualAlign === 'left'
                        ? suggestionPosition.left
                        : undefined,
                    right:
                      suggestionPosition.actualAlign === 'right'
                        ? window.innerWidth - suggestionPosition.left
                        : undefined,
                    maxHeight: suggestionPosition.maxHeight,
                    width: suggestionPosition.width,
                    maxWidth: suggestionPosition.maxWidth,
                  }}
                >
                {filteredSuggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleSelectSuggestion(suggestion);
                    }}
                    className="text-ink-1 hover:bg-glass-medium w-full px-3 py-1.5 text-left text-sm"
                  >
                    {suggestion}
                  </button>
                ))}
                </div>,
                document.body,
              )}
          </div>
        </div>
        {!isOpen &&
          command.ports.slice(0, 2).map((port) => (
            <span
              key={port}
              className="bg-glass-light text-ink-3 rounded px-1.5 py-0.5 font-mono text-[10px]"
            >
              :{port}
            </span>
          ))}
        {!isOpen && command.ports.length > 2 && (
          <span className="bg-glass-light text-ink-3 rounded px-1.5 py-0.5 font-mono text-[10px]">
            +{command.ports.length - 2}
          </span>
        )}
        {!isOpen && localEnvVars.length > 0 && (
          <span className="bg-glass-light text-ink-3 rounded px-1.5 py-0.5 font-mono text-[10px]">
            env {localEnvVars.length}
          </span>
        )}
        {!isOpen && command.confirmBeforeRun && (
          <Check
            className="text-ink-3 h-3.5 w-3.5"
            aria-label="Requires confirmation"
          />
        )}
        <button
          type="button"
          onClick={() => setIsOpen((open) => !open)}
          className={`hover:bg-glass-light rounded-md p-1.5 ${isOpen ? 'bg-acc-soft text-acc-ink' : 'text-ink-3'}`}
          aria-label="Ports and options"
          aria-expanded={isOpen}
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
        <IconButton
          variant="ghost"
          size="md"
          onClick={onDelete}
          icon={<Trash2 />}
          tooltip="Delete command"
        />
      </div>
      {isOpen && (
        <div className="bg-bg-0/30 border-glass-border flex flex-wrap items-start gap-4 border-t px-9 py-3">
          <div className="min-w-56 flex-1">
            <label className="text-ink-3 mb-1.5 block text-xs">
              Ports to check
            </label>
            <PortChipInput ports={command.ports} onChange={handlePortsChange} />
          </div>
          <div className="min-w-64 flex-1">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <label className="text-ink-3 block text-xs">Env vars</label>
                <Tooltip
                  side="top"
                  align="left"
                  minWidth={260}
                  content={
                    <div className="space-y-1.5">
                      <p>
                        Add env vars for this command. Pick a Jean-Claude value,
                        then choose target env var name.
                      </p>
                      <p className="text-ink-3">
                        Example: map Task name to{' '}
                        <span className="text-ink-1 font-mono">TASK_NAME</span>{' '}
                        and command receives{' '}
                        <span className="text-ink-1 font-mono">
                          TASK_NAME=...
                        </span>
                        .
                      </p>
                      <p className="text-ink-3">
                        Available port is only checked when an Available port
                        row exists.
                      </p>
                      <p className="text-ink-3">
                        Add multiple rows to map same source to multiple env
                        names.
                      </p>
                    </div>
                  }
                >
                  <button
                    type="button"
                    className="text-ink-4 hover:text-ink-2 rounded-sm"
                    aria-label="Env vars help"
                  >
                    <HelpCircle className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
              </div>
            </div>
            <div className="space-y-1.5">
              {localEnvVars.map((envVar, index) => {
                return (
                  <div key={index} className="flex items-center gap-2">
                    <Select
                      size="sm"
                      value={envVar.source}
                      options={ENV_SOURCE_OPTIONS}
                      onChange={(value) =>
                        handleEnvSourceChange(
                          index,
                          value as RunCommandEnvSource,
                        )
                      }
                      className="w-36 shrink-0"
                    />
                    <Input
                      size="sm"
                      value={envVar.name}
                      onChange={(e) =>
                        handleEnvVarChange(index, { name: e.target.value })
                      }
                      placeholder="Env var name"
                      className="font-mono"
                    />
                    {envVar.source === 'custom' && (
                      <Input
                        size="sm"
                        value={envVar.value ?? ''}
                        onChange={(e) =>
                          handleEnvVarChange(index, { value: e.target.value })
                        }
                        placeholder="value"
                        className="font-mono"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => handleRemoveEnvVar(index)}
                      className="text-ink-4 hover:text-ink-2 shrink-0 rounded-md p-1"
                      aria-label="Remove env var"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                onClick={handleAddEnvVar}
                className="text-ink-3 hover:text-ink-1 hover:bg-glass-light flex items-center gap-1 rounded-md px-2 py-1 text-xs"
              >
                <Plus className="h-3.5 w-3.5" />
                Add env var
              </button>
            </div>
          </div>
          <div className="min-w-60 pt-5">
            <Checkbox
              size="sm"
              checked={command.confirmBeforeRun}
              onChange={handleConfirmToggle}
              label="Confirm before running"
            />
            {command.confirmBeforeRun && (
              <Input
                size="sm"
                value={localConfirmMessage}
                onChange={(e) => handleConfirmMessageChange(e.target.value)}
                onBlur={handleConfirmMessageBlur}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
                placeholder="Custom confirmation message (optional)"
                className="mt-2"
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
