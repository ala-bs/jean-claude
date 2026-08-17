import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { Download, GitBranch, Plus, Upload } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { DragEndEvent } from '@dnd-kit/core';



import type {
  ProjectCommand,
  ProjectCommandGroup,
  ProjectSuggestionCommand,
  RunCommandConfigItem,
  UpdateProjectCommand,
  UpdateProjectCommandGroup,
} from '@shared/run-command-types';
import {
  useCreateProjectCommand,
  useDeleteProjectCommand,
  useProjectCommands,
  useUpdateProjectCommand,
} from '@/hooks/use-project-commands';
import {
  useCreateProjectCommandGroup,
  useDeleteProjectCommandGroup,
  useProjectCommandGroups,
  useUpdateProjectCommandGroup,
} from '@/hooks/use-project-command-groups';
import {
  useProjectSuggestions,
  useSaveProjectSuggestions,
} from '@/hooks/use-project-suggestions';
import { usePackageScripts } from '@/hooks/use-package-scripts';
import { useReorderProjectRunConfig } from '@/hooks/use-project-run-config';



import { CommandRow } from './command-row';
import { GroupRow } from './group-row';

const EMPTY_SHARED_RUN_COMMANDS: ProjectSuggestionCommand[] = [];

export function RunCommandsConfig({
  projectId,
  projectPath,
}: {
  projectId: string;
  projectPath: string;
}) {
  const { data: commands = [] } = useProjectCommands(projectId);
  const { data: groups = [] } = useProjectCommandGroups(projectId);
  const { data: scriptsData } = usePackageScripts(projectPath);
  const { data: projectSuggestions } = useProjectSuggestions(projectPath);
  const createCommand = useCreateProjectCommand();
  const updateCommand = useUpdateProjectCommand();
  const deleteCommand = useDeleteProjectCommand();
  const createGroup = useCreateProjectCommandGroup();
  const updateGroup = useUpdateProjectCommandGroup();
  const deleteGroup = useDeleteProjectCommandGroup();
  const reorderRunConfig = useReorderProjectRunConfig();
  const saveProjectSuggestions = useSaveProjectSuggestions();
  const [pendingImportedCommands, setPendingImportedCommands] = useState<
    string[]
  >([]);
  const [sessionImportedCommands, setSessionImportedCommands] = useState<
    string[]
  >([]);
  const [commandDrafts, setCommandDrafts] = useState<
    Record<string, ProjectSuggestionCommand>
  >({});

  const items = useMemo(
    () =>
      [
        ...commands.map((item) => ({ type: 'command' as const, item })),
        ...groups.map((item) => ({ type: 'group' as const, item })),
      ].sort(
        (a, b) =>
          a.item.sortOrder - b.item.sortOrder ||
          a.item.createdAt.localeCompare(b.item.createdAt),
      ),
    [commands, groups],
  );
  const itemIds = useMemo(
    () => items.map((item) => `${item.type}:${item.item.id}`),
    [items],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const workspaceScripts =
    scriptsData?.workspacePackages?.flatMap((p) => p.scripts) ?? [];
  const sharedRunCommands =
    projectSuggestions?.runCommands ?? EMPTY_SHARED_RUN_COMMANDS;
  const savedCommandValues = useMemo(
    () => new Set(commands.map((command) => command.command)),
    [commands],
  );
  const unsavedSharedRunCommands = useMemo(() => {
    const pendingCommands = new Set(pendingImportedCommands);
    const importedCommands = new Set(sessionImportedCommands);
    return sharedRunCommands.filter(
      (command) =>
        !savedCommandValues.has(command.command) &&
        !pendingCommands.has(command.command) &&
        !importedCommands.has(command.command),
    );
  }, [pendingImportedCommands, savedCommandValues, sessionImportedCommands, sharedRunCommands]);
  const suggestions = [
    ...new Set([
      ...(scriptsData?.scripts ?? []),
      ...workspaceScripts,
      ...sharedRunCommands.map((command) => command.command),
    ]),
  ];

  const handleAddCommand = () => {
    createCommand.mutate({
      projectId,
      name: null,
      command: '',
      ports: [],
      portConflictStrategy: 'prompt',
      portOverrideProvider: 'env',
      portOverrideEnvVar: null,
      portOverrideArgs: null,
      envVars: [],
      confirmBeforeRun: false,
      confirmMessage: null,
    });
  };

  const handleAddSuggestedCommand = (command: ProjectSuggestionCommand) => {
    setPendingImportedCommands((current) => [...current, command.command]);
    createCommand.mutate(
      {
        ...command,
        projectId,
      },
      {
        onSuccess: () => {
          setPendingImportedCommands((current) =>
            current.filter((value) => value !== command.command),
          );
          setSessionImportedCommands((current) => [...current, command.command]);
        },
        onError: () => {
          setPendingImportedCommands((current) =>
            current.filter((value) => value !== command.command),
          );
        },
      },
    );
  };

  const handleImportAllSuggestedCommands = async () => {
    const commandValues = unsavedSharedRunCommands.map(
      (command) => command.command,
    );
    setPendingImportedCommands((current) => [...current, ...commandValues]);
    await Promise.all(
      unsavedSharedRunCommands.map((command) =>
        createCommand
          .mutateAsync({ ...command, projectId })
          .then(() => {
            setPendingImportedCommands((current) =>
              current.filter((value) => value !== command.command),
            );
            setSessionImportedCommands((current) => [
              ...current,
              command.command,
            ]);
          })
          .catch((error: unknown) => {
            setPendingImportedCommands((current) =>
              current.filter((value) => value !== command.command),
            );
            throw error;
          }),
      ),
    );
  };

  const handleSaveSuggestions = () => {
    saveProjectSuggestions.mutate({
      projectPath,
      suggestions: {
        runCommands: commands.map(
          (command) =>
            commandDrafts[command.id] ?? {
              name: command.name,
              command: command.command,
              ports: command.ports,
              portConflictStrategy: command.portConflictStrategy,
              portOverrideProvider: command.portOverrideProvider,
              portOverrideEnvVar: command.portOverrideEnvVar,
              portOverrideArgs: command.portOverrideArgs,
              envVars: command.envVars,
              confirmBeforeRun: command.confirmBeforeRun,
              confirmMessage: command.confirmMessage,
            },
        ),
      },
    });
  };

  const handleDraftChange = (
    id: string,
    draft: ProjectSuggestionCommand,
  ) => {
    setCommandDrafts((current) => ({ ...current, [id]: draft }));
  };

  const handleUpdateCommand = (id: string, data: UpdateProjectCommand) => {
    updateCommand.mutate({ id, data });
  };

  const handleDeleteCommand = (id: string) => {
    const command = commands.find((item) => item.id === id);
    if (command) {
      setSessionImportedCommands((current) =>
        current.filter((value) => value !== command.command),
      );
      setCommandDrafts((current) => {
        const { [id]: _removed, ...rest } = current;
        return rest;
      });
    }
    deleteCommand.mutate(id);
  };

  const handleAddGroup = () => {
    createGroup.mutate({
      projectId,
      name: `Group ${groups.length + 1}`,
      commandIds: [],
    });
  };

  const handleUpdateGroup = (id: string, data: UpdateProjectCommandGroup) => {
    updateGroup.mutate({ id, data });
  };

  const handleDeleteGroup = (id: string) => {
    deleteGroup.mutate(id);
  };

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = itemIds.indexOf(active.id as string);
      const newIndex = itemIds.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;

      const newOrder = arrayMove(
        items,
        oldIndex,
        newIndex,
      ).map<RunCommandConfigItem>((item, index) => ({
        type: item.type,
        id: item.item.id,
        sortOrder: index,
      }));
      reorderRunConfig.mutate({ projectId, items: newOrder });
    },
    [itemIds, items, projectId, reorderRunConfig],
  );

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4">
        <div className="flex items-baseline gap-3">
          <h2 className="text-ink-0 text-lg font-semibold tracking-tight">
            Run Commands
          </h2>
          <span className="text-ink-3 font-mono text-[11px]">
            {commands.length} command{commands.length === 1 ? '' : 's'} /{' '}
            {groups.length} group{groups.length === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            onClick={handleSaveSuggestions}
            disabled={saveProjectSuggestions.isPending}
            className="border-glass-border text-ink-2 hover:border-glass-border-strong hover:text-ink-1 ml-auto flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs disabled:opacity-50"
          >
            <Upload className="h-3.5 w-3.5" />
            Save suggestions
          </button>
        </div>
        <p className="text-ink-2 mt-1 max-w-2xl text-sm leading-6">
          Save commands you run often from tasks. Bundle commands into groups to
          launch them together in parallel.
        </p>
      </div>

      {unsavedSharedRunCommands.length > 0 && (
        <div className="border-glass-border bg-glass-subtle mb-4 rounded-lg border p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-ink-1 text-sm font-medium">
                Suggested commands
              </h3>
              <p className="text-ink-3 mt-0.5 text-xs">
                From .jean-claude/suggestions.json in this project.
              </p>
            </div>
            <button
              type="button"
              onClick={handleImportAllSuggestedCommands}
              disabled={createCommand.isPending}
              className="border-glass-border text-ink-2 hover:border-glass-border-strong hover:text-ink-1 flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
              Import all
            </button>
          </div>
          <div className="space-y-2">
            {unsavedSharedRunCommands.map((command) => (
              <div
                key={`${command.name ?? ''}:${command.command}`}
                className="border-glass-border bg-bg-1/30 flex items-center gap-3 rounded-md border px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  {command.name && (
                    <div className="text-ink-1 truncate text-sm font-medium">
                      {command.name}
                    </div>
                  )}
                  <div className="text-ink-2 truncate font-mono text-xs">
                    {command.command}
                  </div>
                </div>
                {command.ports.map((port) => (
                  <span
                    key={port}
                    className="bg-glass-light text-ink-3 rounded px-1.5 py-0.5 font-mono text-[10px]"
                  >
                    :{port}
                  </span>
                ))}
                <button
                  type="button"
                  onClick={() => handleAddSuggestedCommand(command)}
                  disabled={createCommand.isPending}
                  className="border-glass-border text-ink-2 hover:border-glass-border-strong hover:text-ink-1 flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs disabled:opacity-50"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {items.map((item) =>
              item.type === 'command' ? (
                <CommandRow
                  key={`command:${item.item.id}`}
                  sortableId={`command:${item.item.id}`}
                  command={item.item as ProjectCommand}
                  suggestions={suggestions}
                  onDraftChange={(data) => handleDraftChange(item.item.id, data)}
                  onUpdate={(data) => handleUpdateCommand(item.item.id, data)}
                  onDelete={() => handleDeleteCommand(item.item.id)}
                />
              ) : (
                <GroupRow
                  key={`group:${item.item.id}`}
                  sortableId={`group:${item.item.id}`}
                  group={item.item as ProjectCommandGroup}
                  commands={commands}
                  onUpdate={(data) => handleUpdateGroup(item.item.id, data)}
                  onDelete={() => handleDeleteGroup(item.item.id)}
                />
              ),
            )}
          </div>
        </SortableContext>
      </DndContext>

      <div className="border-glass-border bg-bg-1/20 mt-4 flex items-center gap-2 rounded-lg border border-dashed p-2">
        <button
          type="button"
          onClick={handleAddCommand}
          disabled={createCommand.isPending}
          className="bg-acc text-bg-0 hover:bg-acc/90 flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          Add command
        </button>
        <button
          type="button"
          onClick={handleAddGroup}
          disabled={createGroup.isPending}
          className="border-glass-border text-ink-2 hover:border-glass-border-strong hover:text-ink-1 flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
        >
          <GitBranch className="h-4 w-4" />
          Add group
        </button>
        <div className="flex-1" />
        <p className="text-ink-3 hidden text-xs sm:block">
          Drag items to reorder. Groups run selected commands in parallel.
        </p>
      </div>
    </div>
  );
}
