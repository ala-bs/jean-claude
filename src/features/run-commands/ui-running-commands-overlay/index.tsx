import {
  ChevronRight,
  Loader2,
  Play,
  Plus,
  RotateCw,
  Square,
  Star,
  Terminal,
  X,
} from 'lucide-react';
import {
  startTransition,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';
import { createPortal } from 'react-dom';
import FocusLock from 'react-focus-lock';



import {
  type CommandRunStatus,
  getProjectRootRunId,
  getRunCommandDisplayName,
  isPortsInUseError,
  parseProjectRootRunId,
  type PortsInUseErrorData,
  type ProjectCommand,
} from '@shared/run-command-types';
import {
  useAllProjectCommands,
  useFavoriteProjectCommands,
  useUpdateProjectCommand,
} from '@/hooks/use-project-commands';
import { useTask, useTasks } from '@/hooks/use-tasks';
import { api } from '@/lib/api';
import { ConfirmRunModal } from '@/features/agent/ui-run-button/confirm-run-modal';
import { IconButton } from '@/common/ui/icon-button';
import { InteractiveLog } from '@/features/common/interactive-log';
import { Kbd } from '@/common/ui/kbd';
import { KillPortsModal } from '@/features/agent/ui-run-button/kill-ports-modal';
import { useCommands } from '@/common/hooks/use-commands';
import { useKeyboardLayer } from '@/common/context/keyboard-bindings';
import { useOverlaysStore } from '@/stores/overlays';
import { useProjects } from '@/hooks/use-projects';
import { useTaskMessagesStore } from '@/stores/task-messages';
import { useToastStore } from '@/stores/toasts';



/** Keys the overlay handles itself — don't forward to PTY. */
const OVERLAY_IGNORED_KEYS = new Set(['Escape']);

interface RunningCommand {
  taskId: string;
  taskName: string;
  projectName: string;
  commandStatus: CommandRunStatus;
}

export function RunningCommandsOverlay({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const returnFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const layer = useKeyboardLayer('overlay', {
    exclusive: true,
    passthrough: ['global-nav'],
  });

  const runCommandRunning = useTaskMessagesStore((s) => s.runCommandRunning);
  const target = useOverlaysStore((s) => s.runningCommandTarget);
  const { data: tasks } = useTasks();
  const { data: projects } = useProjects();
  const [selectedKey, setSelectedKey] = useState<string | null>(() =>
    target ? makeKey(target.taskId, target.runCommandId) : null,
  );
  const [stoppingKeys, setStoppingKeys] = useState<Set<string>>(new Set());
  const addToast = useToastStore((s) => s.addToast);
  const resetRunCommandLogs = useTaskMessagesStore(
    (s) => s.resetRunCommandLogs,
  );

  useEffect(
    () => () => {
      const returnFocus = returnFocusRef.current;
      setTimeout(() => returnFocus?.focus(), 0);
    },
    [],
  );

  const runningCommands = useMemo(() => {
    const result: RunningCommand[] = [];
    const taskMap = new Map(tasks?.map((t) => [t.id, t]));
    const projectMap = new Map(projects?.map((p) => [p.id, p]));

    for (const [taskId, status] of Object.entries(runCommandRunning)) {
      const rootProjectId = parseProjectRootRunId(taskId);
      const task = taskMap.get(taskId);
      const project = rootProjectId
        ? projectMap.get(rootProjectId)
        : task
          ? projectMap.get(task.projectId)
          : undefined;

      for (const cmd of status.commands) {
        const isTarget =
          target?.taskId === taskId && target.runCommandId === cmd.id;
        if (cmd.status !== 'running' && !isTarget) continue;
        result.push({
          taskId,
          taskName: rootProjectId
            ? 'Project root'
            : (task?.name ??
              task?.prompt.split('\n')[0].slice(0, 30) ??
              taskId),
          projectName: project?.name ?? 'Unknown Project',
          commandStatus: cmd,
        });
      }
    }

    if (
      target &&
      !result.some(
        (command) =>
          command.taskId === target.taskId &&
          command.commandStatus.id === target.runCommandId,
      )
    ) {
      const task = taskMap.get(target.taskId);
      const project = task ? projectMap.get(task.projectId) : undefined;
      result.push({
        taskId: target.taskId,
        taskName:
          task?.name ??
          task?.prompt.split('\n')[0].slice(0, 30) ??
          target.taskId,
        projectName: project?.name ?? 'Unknown Project',
        commandStatus: {
          id: target.runCommandId,
          name: null,
          command: target.runCommandId,
          status: 'stopped',
        },
      });
    }
    return result;
  }, [runCommandRunning, tasks, projects, target]);
  const runningCount = runningCommands.filter(
    (command) => command.commandStatus.status === 'running',
  ).length;


  const [startingFavoriteIds, setStartingFavoriteIds] = useState<Set<string>>(
    new Set(),
  );
  const [portConflict, setPortConflict] = useState<{
    error: PortsInUseErrorData;
    command: ProjectCommand;
    runTaskId: string;
  } | null>(null);
  const [isKillingPorts, setIsKillingPorts] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{
    command: ProjectCommand;
    runTaskId: string;
  } | null>(null);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [togglingFavoriteIds, setTogglingFavoriteIds] = useState<Set<string>>(
    new Set(),
  );

  // Both lists go through React Query so project settings and this overlay
  // stay in sync — the update mutation invalidates the shared key.
  const { data: favoriteCommands } = useFavoriteProjectCommands();
  const { data: pickerCommands, isPending: isPickerPending } =
    useAllProjectCommands({ enabled: isPickerOpen });
  const updateProjectCommand = useUpdateProjectCommand();
  const updateProjectCommandAsync = updateProjectCommand.mutateAsync;

  const favoriteIds = useMemo(
    () => new Set((favoriteCommands ?? []).map((command) => command.id)),
    [favoriteCommands],
  );

  const handleToggleFavorite = useCallback(
    async (command: ProjectCommand) => {
      const nextIsFavorite = !favoriteIds.has(command.id);
      setTogglingFavoriteIds((prev) => new Set(prev).add(command.id));
      try {
        await updateProjectCommandAsync({
          id: command.id,
          data: { isFavorite: nextIsFavorite },
        });
      } catch (error) {
        addToast({
          type: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Failed to update favorites',
        });
      } finally {
        setTogglingFavoriteIds((prev) => {
          const next = new Set(prev);
          next.delete(command.id);
          return next;
        });
      }
    },
    [addToast, favoriteIds, updateProjectCommandAsync],
  );

  const pickerItems = useMemo(() => {
    const projectMap = new Map(projects?.map((p) => [p.id, p]));
    return (pickerCommands ?? []).map((command) => ({
      command,
      projectName: projectMap.get(command.projectId)?.name ?? 'Unknown Project',
      isFavorite: favoriteIds.has(command.id),
    }));
  }, [favoriteIds, pickerCommands, projects]);

  const favorites = useMemo(() => {
    const projectMap = new Map(projects?.map((p) => [p.id, p]));
    return (favoriteCommands ?? []).map((command) => {
      const runTaskId = getProjectRootRunId(command.projectId);
      const status = runCommandRunning[runTaskId]?.commands.find(
        (c) => c.id === command.id,
      );
      return {
        command,
        runTaskId,
        projectName: projectMap.get(command.projectId)?.name ?? 'Unknown Project',
        isRunning: status?.status === 'running',
      };
    });
  }, [favoriteCommands, projects, runCommandRunning]);

  // A running favorite already has a row (with its own stop/restart controls)
  // in the Favorites section — don't list it twice.
  const otherRunningCommands = useMemo(() => {
    const favoriteKeys = new Set(
      favorites.map((favorite) =>
        makeKey(favorite.runTaskId, favorite.command.id),
      ),
    );
    return runningCommands.filter(
      (command) =>
        !favoriteKeys.has(makeKey(command.taskId, command.commandStatus.id)),
    );
  }, [favorites, runningCommands]);

  // Keyboard navigation must follow what the user sees: Favorites first (only
  // the ones that actually have a row in `runningCommands`), then Running.
  // `runningCommands` itself is in `runCommandRunning` insertion order, which
  // has no relation to render order.
  const navigableCommands = useMemo(() => {
    const byKey = new Map(
      runningCommands.map((command) => [
        makeKey(command.taskId, command.commandStatus.id),
        command,
      ]),
    );
    const favoriteRows = favorites
      .map((favorite) =>
        byKey.get(makeKey(favorite.runTaskId, favorite.command.id)),
      )
      .filter((command): command is RunningCommand => command !== undefined);
    return [...favoriteRows, ...otherRunningCommands];
  }, [favorites, otherRunningCommands, runningCommands]);

  const handleRunFavorite = useCallback(
    async (favorite: { command: ProjectCommand; runTaskId: string }) => {
      const { command, runTaskId } = favorite;
      setStartingFavoriteIds((prev) => new Set(prev).add(command.id));
      try {
        // Restart semantics: clear the previous logs first. The service stops
        // any previous run of this command itself.
        const generation = resetRunCommandLogs(runTaskId, command.id);
        await api.runCommands.resetLogs({
          taskId: runTaskId,
          runCommandId: command.id,
          generation,
        });

        const result = await api.runCommands.startFavorite({
          projectId: command.projectId,
          runCommandId: command.id,
        });
        if (isPortsInUseError(result)) {
          setPortConflict({ error: result, command, runTaskId });
          return;
        }
        setPortConflict((current) =>
          current?.command.id === command.id ? null : current,
        );
        setSelectedKey(makeKey(runTaskId, command.id));
      } catch (error) {
        addToast({
          type: 'error',
          message:
            error instanceof Error ? error.message : 'Failed to start command',
        });
      } finally {
        setStartingFavoriteIds((prev) => {
          const next = new Set(prev);
          next.delete(command.id);
          return next;
        });
      }
    },
    [addToast, resetRunCommandLogs],
  );

  // Commands flagged `confirmBeforeRun` must be confirmed here too — favorites
  // run against the real project checkout, not a disposable worktree.
  const requestRunFavorite = useCallback(
    (favorite: { command: ProjectCommand; runTaskId: string }) => {
      if (favorite.command.confirmBeforeRun) {
        setPendingConfirm(favorite);
        return;
      }
      void handleRunFavorite(favorite);
    },
    [handleRunFavorite],
  );

  const handleConfirmKillPorts = useCallback(async () => {
    const conflict = portConflict;
    if (!conflict) return;
    setIsKillingPorts(true);
    try {
      const commandIds = [
        ...new Set(conflict.error.portsInUse.map((port) => port.commandId)),
      ];
      for (const commandId of commandIds) {
        await api.runCommands.killPortsForCommand(
          conflict.command.projectId,
          commandId,
        );
      }
      setPortConflict(null);
      await handleRunFavorite(conflict);
    } catch (error) {
      addToast({
        type: 'error',
        message:
          error instanceof Error ? error.message : 'Failed to free the ports',
      });
    } finally {
      setIsKillingPorts(false);
    }
  }, [addToast, handleRunFavorite, portConflict]);

  useEffect(() => {
    if (target) {
      startTransition(() =>
        setSelectedKey(makeKey(target.taskId, target.runCommandId)),
      );
    }
  }, [target]);

  // Auto-select first command if nothing selected or selected got removed
  useEffect(() => {
    if (runningCommands.length === 0) {
      startTransition(() => setSelectedKey(null));
      return;
    }
    const stillExists = selectedKey
      ? runningCommands.some(
          (c) => makeKey(c.taskId, c.commandStatus.id) === selectedKey,
        )
      : false;
    if (!stillExists) {
      startTransition(() =>
        setSelectedKey(
          target
            ? makeKey(target.taskId, target.runCommandId)
            : makeKey(
                runningCommands[0].taskId,
                runningCommands[0].commandStatus.id,
              ),
        ),
      );
    }
  }, [runningCommands, selectedKey, target]);

  // Keep the highlighted row visible — the sidebar scrolls, and arrow nav can
  // otherwise move the selection off-screen with no visible feedback.
  const selectedRowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedKey]);

  const selectedCommand = useMemo(
    () =>
      runningCommands.find(
        (c) => makeKey(c.taskId, c.commandStatus.id) === selectedKey,
      ),
    [runningCommands, selectedKey],
  );
  const selectedCommandKey = selectedCommand
    ? makeKey(selectedCommand.taskId, selectedCommand.commandStatus.id)
    : null;
  const canStopSelected =
    selectedCommand?.commandStatus.status === 'running' &&
    selectedCommandKey !== null &&
    !stoppingKeys.has(selectedCommandKey);

  const handleStop = useCallback(
    async (taskId: string, runCommandId: string) => {
      const key = makeKey(taskId, runCommandId);
      setStoppingKeys((prev) => new Set(prev).add(key));
      try {
        await api.runCommands.stopCommand({ taskId, runCommandId });
      } catch (error) {
        addToast({
          type: 'error',
          message:
            error instanceof Error ? error.message : 'Failed to stop command',
        });
      } finally {
        setStoppingKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [addToast],
  );

  const handleStopSelected = useCallback(() => {
    if (!selectedCommand || !canStopSelected) return;
    void handleStop(selectedCommand.taskId, selectedCommand.commandStatus.id);
  }, [canStopSelected, selectedCommand, handleStop]);

  const handleClearSelectedLogs = useCallback(() => {
    if (!selectedCommand) return;
    const generation = resetRunCommandLogs(
      selectedCommand.taskId,
      selectedCommand.commandStatus.id,
    );
    void api.runCommands.resetLogs({
      taskId: selectedCommand.taskId,
      runCommandId: selectedCommand.commandStatus.id,
      generation,
    });
  }, [resetRunCommandLogs, selectedCommand]);

  const handleArrowNavigation = useCallback(
    (direction: 'up' | 'down') => {
      if (navigableCommands.length === 0) return;
      const currentIndex = navigableCommands.findIndex(
        (c) => makeKey(c.taskId, c.commandStatus.id) === selectedKey,
      );
      let nextIndex: number;
      if (direction === 'up') {
        nextIndex =
          currentIndex <= 0 ? navigableCommands.length - 1 : currentIndex - 1;
      } else {
        nextIndex =
          currentIndex >= navigableCommands.length - 1 ? 0 : currentIndex + 1;
      }
      const next = navigableCommands[nextIndex];
      setSelectedKey(makeKey(next.taskId, next.commandStatus.id));
    },
    [navigableCommands, selectedKey],
  );

  useCommands(
    'running-commands-overlay',
    [
      {
        label: 'Close Running Commands Overlay',
        shortcut: 'escape',
        handler: () => {
          // Escape backs out of the favorite picker before closing the overlay.
          if (isPickerOpen) {
            setIsPickerOpen(false);
            return;
          }
          onClose();
        },
        hideInCommandPalette: true,
      },
      {
        label: 'Stop Selected Command',
        shortcut: 'cmd+backspace',
        handler: handleStopSelected,
        hideInCommandPalette: true,
      },
      {
        label: 'Clear Selected Command Logs',
        shortcut: 'cmd+k',
        handler: handleClearSelectedLogs,
        hideInCommandPalette: true,
      },
      {
        label: 'Select Previous Command',
        shortcut: 'up',
        handler: () => handleArrowNavigation('up'),
        hideInCommandPalette: true,
        // Don't hijack arrows/clear while typing in the favorite filter.
        ignoreIfInput: true,
      },
      {
        label: 'Select Next Command',
        shortcut: 'down',
        handler: () => handleArrowNavigation('down'),
        hideInCommandPalette: true,
        ignoreIfInput: true,
      },
    ],
    { layer },
  );

  return createPortal(
    <FocusLock returnFocus>
      <div
        className="bg-bg-0/40 fixed inset-0 z-50 flex items-start justify-center p-4 pt-[10vh]"
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="bg-bg-0/85 border-glass-border flex max-h-[75svh] w-[min(1000px,96vw)] flex-col overflow-hidden rounded-xl border shadow-2xl shadow-black/50 backdrop-blur-xl"
          onClick={(event) => event.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-glass-border bg-gradient-to-r from-glass-subtle to-transparent px-4 py-3">
            <div className="flex items-center gap-2">
              <Terminal className="text-status-done h-4 w-4" />
              <div>
                <h2 id={titleId} className="text-ink-0 text-sm font-semibold">
                  Running Commands
                </h2>
                <p className="text-ink-2 mt-0.5 text-xs">
                  {runningCount === 0
                    ? 'No running commands'
                    : `${runningCount} running`}
                </p>
              </div>
            </div>
            <IconButton
              variant="ghost"
              size="sm"
              onClick={onClose}
              icon={<X />}
              tooltip="Close"
            />
          </div>

          {/* Content */}
          <div className="flex min-h-0 flex-1">
              {/* Left: command list */}
              <div className="w-64 shrink-0 overflow-y-auto border-glass-border border-r p-2">
                <div className="mb-2">
                    <div className="text-ink-4 flex items-center gap-1.5 px-3 py-1 text-[10px] font-semibold tracking-wider uppercase">
                      <Star className="h-3 w-3" />
                      <span className="flex-1">Favorites</span>
                      <button
                        type="button"
                        aria-label={
                          isPickerOpen
                            ? 'Close favorite picker'
                            : 'Add a favorite command'
                        }
                        aria-expanded={isPickerOpen}
                        onClick={() => setIsPickerOpen((open) => !open)}
                        className={clsx(
                          'cursor-pointer rounded p-0.5 transition-colors hover:bg-glass-light',
                          isPickerOpen ? 'text-ink-1' : 'text-ink-4',
                        )}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {isPickerOpen && (
                      <FavoritePicker
                        items={pickerItems}
                        isLoading={isPickerPending}
                        togglingIds={togglingFavoriteIds}
                        onToggle={(command) =>
                          void handleToggleFavorite(command)
                        }
                      />
                    )}
                    {favorites.length === 0 && !isPickerOpen && (
                      <p className="text-ink-4 px-3 py-1 text-[11px]">
                        No favorites yet — add one with +
                      </p>
                    )}
                    {favorites.map((favorite) => {
                      const isStarting = startingFavoriteIds.has(
                        favorite.command.id,
                      );
                      const favoriteKey = makeKey(
                        favorite.runTaskId,
                        favorite.command.id,
                      );
                      const isSelected = selectedKey === favoriteKey;
                      return (
                        <div
                          key={favorite.command.id}
                          ref={isSelected ? selectedRowRef : undefined}
                          className={clsx(
                            'group flex w-full items-start rounded-lg transition-colors',
                            isSelected
                              ? 'text-ink-0 bg-glass-medium'
                              : 'text-ink-2 hover:text-ink-1 hover:bg-glass-light',
                          )}
                        >
                          <button
                            type="button"
                            aria-pressed={isSelected}
                            disabled={isStarting}
                            onClick={() => {
                              if (favorite.isRunning) {
                                setSelectedKey(
                                  makeKey(
                                    favorite.runTaskId,
                                    favorite.command.id,
                                  ),
                                );
                                return;
                              }
                              requestRunFavorite(favorite);
                            }}
                            className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 px-3 py-2 text-left disabled:opacity-60"
                          >
                            {isStarting || favorite.isRunning ? (
                              <Loader2
                                className={clsx(
                                  'mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin',
                                  favorite.isRunning
                                    ? 'text-status-done'
                                    : 'text-ink-4',
                                )}
                              />
                            ) : (
                              <Play className="text-ink-4 mt-0.5 h-3.5 w-3.5 shrink-0" />
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-medium">
                                {getRunCommandDisplayName(favorite.command)}
                              </span>
                              <span className="text-ink-4 block truncate text-[11px]">
                                {favorite.projectName} · Project root
                              </span>
                            </span>
                          </button>
                          {favorite.isRunning && (
                            <button
                              type="button"
                              aria-label={`Stop ${getRunCommandDisplayName(favorite.command)}`}
                              disabled={stoppingKeys.has(
                                makeKey(favorite.runTaskId, favorite.command.id),
                              )}
                              className="text-ink-4 hover:bg-status-fail/20 hover:text-status-fail mt-2 shrink-0 cursor-pointer rounded p-1 transition-colors disabled:cursor-not-allowed"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleStop(
                                  favorite.runTaskId,
                                  favorite.command.id,
                                );
                              }}
                            >
                              <Square className="h-3 w-3" />
                            </button>
                          )}
                          {favorite.isRunning && (
                            <button
                              type="button"
                              aria-label={`Restart ${getRunCommandDisplayName(favorite.command)}`}
                              disabled={isStarting}
                              className="text-ink-4 hover:text-ink-1 mt-2 mr-2 shrink-0 cursor-pointer rounded p-1 transition-colors hover:bg-glass-light disabled:cursor-not-allowed"
                              onClick={(e) => {
                                e.stopPropagation();
                                requestRunFavorite(favorite);
                              }}
                            >
                              <RotateCw className="h-3 w-3" />
                            </button>
                          )}
                          <button
                            type="button"
                            aria-label={`Remove ${getRunCommandDisplayName(favorite.command)} from favorites`}
                            disabled={togglingFavoriteIds.has(
                              favorite.command.id,
                            )}
                            className="text-ink-4 hover:text-ink-1 mt-2 mr-2 shrink-0 cursor-pointer rounded p-1 opacity-0 transition-colors group-hover:opacity-100 hover:bg-glass-light focus-visible:opacity-100 disabled:cursor-not-allowed"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleToggleFavorite(favorite.command);
                            }}
                          >
                            <Star className="h-3 w-3" fill="currentColor" />
                          </button>
                        </div>
                      );
                    })}
                </div>
                {otherRunningCommands.length > 0 && favorites.length > 0 && (
                  <div className="text-ink-4 px-3 py-1 text-[10px] font-semibold tracking-wider uppercase">
                    Running
                  </div>
                )}
                {otherRunningCommands.map((cmd) => {
                  const key = makeKey(cmd.taskId, cmd.commandStatus.id);
                  const isSelected = selectedKey === key;
                  const isStopping = stoppingKeys.has(key);
                  return (
                    <div
                      key={key}
                      ref={isSelected ? selectedRowRef : undefined}
                      className={clsx(
                        'group flex w-full items-start rounded-lg transition-colors',
                        isSelected
                          ? 'text-ink-0 bg-glass-medium'
                          : 'text-ink-2 hover:text-ink-1 hover:bg-glass-light',
                      )}
                    >
                      <button
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => setSelectedKey(key)}
                        className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 px-3 py-2 text-left"
                      >
                        {cmd.commandStatus.status === 'running' ? (
                          <Loader2 className="text-status-done mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
                        ) : (
                          <Terminal className="text-ink-4 mt-0.5 h-3.5 w-3.5 shrink-0" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">
                            {getRunCommandDisplayName(cmd.commandStatus)}
                          </span>
                          <span className="text-ink-3 mt-0.5 block truncate text-[11px]">
                            {cmd.taskName}
                          </span>
                          <span className="text-ink-4 block truncate text-[11px]">
                            {cmd.projectName}
                          </span>
                        </span>
                      </button>
                      {cmd.commandStatus.status === 'running' && <button
                        type="button"
                        aria-label={`${isStopping ? 'Stopping' : 'Stop'} ${getRunCommandDisplayName(cmd.commandStatus)}`}
                        aria-busy={isStopping}
                        disabled={isStopping}
                        className={clsx(
                          'mt-2 mr-2 shrink-0 cursor-pointer rounded p-1 transition-colors',
                          isStopping
                            ? 'text-ink-4 cursor-not-allowed'
                            : 'text-ink-4 hover:bg-status-fail/20 hover:text-status-fail',
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleStop(cmd.taskId, cmd.commandStatus.id);
                        }}
                      >
                        <Square className="h-3 w-3" />
                      </button>}
                    </div>
                  );
                })}
              </div>

              {/* Right: log viewer */}
              <div className="flex min-w-0 flex-1 flex-col">
                {selectedCommand ? (
                  <LogViewer
                    taskId={selectedCommand.taskId}
                    runCommandId={selectedCommand.commandStatus.id}
                    command={getRunCommandDisplayName(
                      selectedCommand.commandStatus,
                    )}
                    subtitle={`${selectedCommand.projectName} · ${selectedCommand.taskName}`}
                    isRunning={selectedCommand.commandStatus.status === 'running'}
                    isStopping={stoppingKeys.has(
                      makeKey(
                        selectedCommand.taskId,
                        selectedCommand.commandStatus.id,
                      ),
                    )}
                    onStop={
                      selectedCommand.commandStatus.status === 'running'
                        ? () =>
                            handleStop(
                              selectedCommand.taskId,
                              selectedCommand.commandStatus.id,
                            )
                        : undefined
                    }
                  />
                ) : (
                  <div className="text-ink-4 flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center text-sm">
                    <Terminal className="text-ink-4 h-8 w-8" />
                    {runningCommands.length === 0 && favorites.length === 0
                      ? 'No commands are currently running.'
                      : 'Select a command to view logs'}
                    <span className="text-ink-4 text-xs">
                      Use + to favorite a project command and run it from the
                      project root.
                    </span>
                  </div>
                )}
              </div>
          </div>

          {/* Footer with shortcut hints */}
          <div
            data-testid="running-commands-footer"
            className="border-glass-border flex items-center gap-4 border-t px-4 py-2"
          >
            <div className="text-ink-3 flex items-center gap-1.5 text-[11px]">
              <Kbd shortcut="up" />
              <Kbd shortcut="down" />
              <span>Navigate</span>
            </div>
            {canStopSelected && (
              <div className="text-ink-3 flex items-center gap-1.5 text-[11px]">
                <Kbd shortcut="cmd+backspace" />
                <span>Stop</span>
              </div>
            )}
            <div className="text-ink-3 flex items-center gap-1.5 text-[11px]">
              <Kbd shortcut="cmd+k" />
              <span>Clear Logs</span>
            </div>
            <div className="text-ink-3 flex items-center gap-1.5 text-[11px]">
              <Kbd shortcut="escape" />
              <span>Close</span>
            </div>
          </div>
        </div>
      </div>
      {pendingConfirm && (
        <ConfirmRunModal
          commandName={getRunCommandDisplayName(pendingConfirm.command)}
          message={pendingConfirm.command.confirmMessage}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => {
            const favorite = pendingConfirm;
            setPendingConfirm(null);
            void handleRunFavorite(favorite);
          }}
        />
      )}
      {portConflict && (
        <KillPortsModal
          error={portConflict.error}
          isLoading={isKillingPorts}
          onConfirm={() => void handleConfirmKillPorts()}
          onCancel={() => {
            if (isKillingPorts) return;
            setPortConflict(null);
          }}
        />
      )}
    </FocusLock>,
    document.body,
  );
}

/** Inline picker listing every project command so favorites can be toggled. */
function FavoritePicker({
  items,
  isLoading,
  togglingIds,
  onToggle,
}: {
  items: Array<{
    command: ProjectCommand;
    projectName: string;
    isFavorite: boolean;
  }>;
  isLoading: boolean;
  togglingIds: Set<string>;
  onToggle: (command: ProjectCommand) => void;
}) {
  const [query, setQuery] = useState('');

  // `null` = untouched, so the default below applies.
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<
    string
  > | null>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (item) =>
        getRunCommandDisplayName(item.command)
          .toLowerCase()
          .includes(needle) ||
        item.command.command.toLowerCase().includes(needle) ||
        item.projectName.toLowerCase().includes(needle),
    );
  }, [items, query]);

  // One group per project, ordered by project name.
  const groups = useMemo(() => {
    const byProject = new Map<
      string,
      { projectId: string; projectName: string; items: typeof filtered }
    >();
    for (const item of filtered) {
      const existing = byProject.get(item.command.projectId);
      if (existing) {
        existing.items.push(item);
      } else {
        byProject.set(item.command.projectId, {
          projectId: item.command.projectId,
          projectName: item.projectName,
          items: [item],
        });
      }
    }
    return [...byProject.values()].sort((a, b) =>
      a.projectName.localeCompare(b.projectName),
    );
  }, [filtered]);

  const isSearching = query.trim().length > 0;
  // A single project has no ambiguity to resolve, so it starts open; with
  // several projects everything starts collapsed. Once the user clicks, their
  // explicit set wins — expansion is stored as ids, never as an inverted flag.
  const effectiveExpandedIds =
    expandedProjectIds ??
    new Set(groups.length === 1 ? [groups[0].projectId] : []);

  return (
    <div className="mb-2 rounded-lg border-glass-border bg-glass-light border p-1.5">
      <input
        type="text"
        value={query}
        autoFocus
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter commands…"
        aria-label="Filter project commands"
        className="text-ink-1 placeholder:text-ink-4 mb-1 w-full rounded-md bg-black/20 px-2 py-1 text-xs outline-none"
      />
      <div className="max-h-56 overflow-y-auto">
        {isLoading ? (
          <p className="text-ink-4 px-2 py-1.5 text-[11px]">Loading commands…</p>
        ) : groups.length === 0 ? (
          <p className="text-ink-4 px-2 py-1.5 text-[11px]">
            No project commands match.
          </p>
        ) : (
          groups.map((group) => {
            // While filtering, every matching project stays open.
            const isExpanded =
              isSearching || effectiveExpandedIds.has(group.projectId);
            const favoriteCount = group.items.filter(
              (item) => item.isFavorite,
            ).length;
            return (
              <div key={group.projectId}>
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${group.projectName} commands`}
                  onClick={() =>
                    setExpandedProjectIds(() => {
                      const next = new Set(effectiveExpandedIds);
                      if (next.has(group.projectId)) {
                        next.delete(group.projectId);
                      } else {
                        next.add(group.projectId);
                      }
                      return next;
                    })
                  }
                  className="text-ink-2 hover:text-ink-1 flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left hover:bg-glass-light"
                >
                  <ChevronRight
                    className={clsx(
                      'h-3 w-3 shrink-0 transition-transform',
                      isExpanded && 'rotate-90',
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
                    {group.projectName}
                  </span>
                  <span className="text-ink-4 shrink-0 font-mono text-[10px]">
                    {favoriteCount > 0
                      ? `${favoriteCount}/${group.items.length}`
                      : group.items.length}
                  </span>
                </button>
                {isExpanded && (
                  <div className="ml-2 border-glass-border border-l pl-1.5">
                    {group.items.map((item) => (
                      <button
                        key={item.command.id}
                        type="button"
                        disabled={togglingIds.has(item.command.id)}
                        aria-pressed={item.isFavorite}
                        onClick={() => onToggle(item.command)}
                        className="text-ink-2 hover:text-ink-1 flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-glass-light disabled:opacity-60"
                      >
                        <Star
                          className={clsx(
                            'h-3 w-3 shrink-0',
                            item.isFavorite ? 'text-status-warn' : 'text-ink-4',
                          )}
                          fill={item.isFavorite ? 'currentColor' : 'none'}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11px] font-medium">
                            {getRunCommandDisplayName(item.command)}
                          </span>
                          {item.command.name?.trim() ? (
                            <span className="text-ink-4 block truncate font-mono text-[10px]">
                              {item.command.command}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function LogViewer({
  taskId,
  runCommandId,
  command,
  subtitle,
  isRunning,
  isStopping,
  onStop,
}: {
  taskId: string;
  runCommandId: string;
  command: string;
  subtitle?: string;
  isRunning: boolean;
  isStopping: boolean;
  onStop?: () => void;
}) {
  const log = useTaskMessagesStore(
    (s) => s.runCommandLogs[taskId]?.[runCommandId] ?? null,
  );
  const { data: task } = useTask(taskId);

  return (
    <div className="flex h-full flex-col">
      {/* Log header */}
      <div className="flex items-center justify-between border-glass-border border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-ink-1 truncate font-mono text-xs">
            {command}
          </span>
          {subtitle && (
            <span className="text-ink-4 truncate text-[11px]">{subtitle}</span>
          )}
          <span className={clsx(
            'flex shrink-0 items-center gap-1 text-[11px]',
            isRunning ? 'text-status-done' : 'text-ink-3',
          )}>
            {isRunning && <Loader2 className="h-3 w-3 animate-spin" />}
            {isRunning ? 'running' : 'stopped'}
          </span>
        </div>
        {onStop && <button
          className={clsx(
            'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
            isStopping
              ? 'text-ink-4 bg-bg-1 cursor-not-allowed'
              : 'bg-status-fail/15 text-status-fail hover:bg-status-fail/25',
          )}
          disabled={isStopping}
          onClick={onStop}
        >
          <Square className="h-3 w-3" />
          {isStopping ? 'Stopping...' : 'Stop'}
        </button>}
      </div>

      <InteractiveLog
        log={log}
        taskId={taskId}
        runCommandId={runCommandId}
        isRunning={isRunning}
        workingDir={task?.worktreePath ?? undefined}
        ignoredKeys={OVERLAY_IGNORED_KEYS}
        stopKeyPropagation
      />
    </div>
  );
}

function makeKey(taskId: string, commandId: string) {
  return `${taskId}::${commandId}`;
}
