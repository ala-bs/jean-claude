import { Loader2, RotateCw, Search, Trash2 } from 'lucide-react';
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import clsx from 'clsx';

import {
  getRunCommandLogLineCount,
  type RunCommandLogs,
  type RunCommandLogState,
  useTaskMessagesStore,
} from '@/stores/task-messages';
import { api } from '@/lib/api';
import { Button } from '@/common/ui/button';
import { ConfirmRunModal } from '@/features/agent/ui-run-button/confirm-run-modal';
import { getRunCommandDisplayName } from '@shared/run-command-types';
import { IconButton } from '@/common/ui/icon-button';
import { Input } from '@/common/ui/input';
import { InteractiveLog } from '@/features/common/interactive-log';
import { Kbd } from '@/common/ui/kbd';
import { keyEventToTerminalInput } from '@/features/common/interactive-log/key-event-to-terminal-input';
import { KillPortsModal } from '@/features/agent/ui-run-button/kill-ports-modal';
import type { ProjectCommand } from '@shared/run-command-types';
import { Separator } from '@/common/ui/separator';
import type { useProjectCommandAvailability } from '@/hooks/use-project-command-availability';
import type { useRunCommands } from '@/hooks/use-run-commands';

import {
  buildCommandLogTabs,
  buildCommandPortsById,
  commandPortsMatchQuery,
  describeCommandPorts,
  formatCommandPorts,
  getCommandLogsEmptyText,
} from './command-log-tabs';
import { isInteractiveTarget, selectActiveLog } from './utils-log-pane-focus';

const EMPTY_RUN_COMMAND_LOGS: RunCommandLogs = {};
const RUN_COMMAND_LOG_RENDER_THROTTLE_MS = 500;

function shouldFlushRunCommandLogsImmediately({
  previous,
  next,
}: {
  previous: RunCommandLogs;
  next: RunCommandLogs;
}): boolean {
  const previousIds = Object.keys(previous);
  const nextIds = new Set(Object.keys(next));

  for (const commandId of previousIds) {
    const previousLog = previous[commandId];
    const nextLog = next[commandId];

    if (!nextIds.has(commandId)) return true;
    if (
      getRunCommandLogLineCount(nextLog) < getRunCommandLogLineCount(previousLog)
    ) {
      return true;
    }
  }

  return false;
}

function useThrottledRunCommandLogs(taskId: string): RunCommandLogs {
  const getSnapshot = useCallback(
    () =>
      useTaskMessagesStore.getState().runCommandLogs[taskId] ??
      EMPTY_RUN_COMMAND_LOGS,
    [taskId],
  );

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      let lastFlushAt = 0;
      let timeout: ReturnType<typeof setTimeout> | null = null;

      const flush = () => {
        timeout = null;
        lastFlushAt = Date.now();
        onStoreChange();
      };

      const unsubscribe = useTaskMessagesStore.subscribe(
        (state, previousState) => {
          if (state.runCommandLogs === previousState.runCommandLogs) return;

          const previousLogs =
            previousState.runCommandLogs[taskId] ?? EMPTY_RUN_COMMAND_LOGS;
          const nextLogs = state.runCommandLogs[taskId] ?? EMPTY_RUN_COMMAND_LOGS;
          if (nextLogs === previousLogs) return;

          if (
            shouldFlushRunCommandLogsImmediately({
              previous: previousLogs,
              next: nextLogs,
            })
          ) {
            if (timeout) {
              clearTimeout(timeout);
              timeout = null;
            }
            flush();
            return;
          }

          const elapsed = Date.now() - lastFlushAt;
          if (elapsed >= RUN_COMMAND_LOG_RENDER_THROTTLE_MS) {
            if (timeout) {
              clearTimeout(timeout);
              timeout = null;
            }
            flush();
            return;
          }

          if (!timeout) {
            timeout = setTimeout(
              flush,
              RUN_COMMAND_LOG_RENDER_THROTTLE_MS - elapsed,
            );
          }
        },
      );

      return () => {
        unsubscribe();
        if (timeout) {
          clearTimeout(timeout);
        }
      };
    },
    [taskId],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function logIncludesQuery(
  log: RunCommandLogState | null | undefined,
  query: string,
): boolean {
  if (!log) return false;

  for (const chunk of log.chunks) {
    if (chunk.lines.some((entry) => entry.line.toLowerCase().includes(query))) {
      return true;
    }
  }

  return (
    log.pendingLines.stdout?.line.toLowerCase().includes(query) === true ||
    log.pendingLines.stderr?.line.toLowerCase().includes(query) === true
  );
}

function filterLogByQuery(
  log: RunCommandLogState | null,
  query: string,
): RunCommandLogState | null {
  if (!log || !query) return log;

  let totalLineCount = 0;
  const chunks = log.chunks
    .map((chunk) => {
      const lines = chunk.lines.filter((entry) =>
        entry.line.toLowerCase().includes(query),
      );
      totalLineCount += lines.length;
      return { ...chunk, lines, lineCount: lines.length };
    })
    .filter((chunk) => chunk.lineCount > 0);

  return {
    ...log,
    chunks,
    pendingLines: {
      stdout:
        log.pendingLines.stdout?.line.toLowerCase().includes(query) === true
          ? log.pendingLines.stdout
          : null,
      stderr:
        log.pendingLines.stderr?.line.toLowerCase().includes(query) === true
          ? log.pendingLines.stderr
          : null,
    },
    totalLineCount,
  };
}

/**
 * The reusable body of the command logs UI: toolbar (search + restart + clear),
 * tab rail, focus strip and the interactive log itself.
 *
 * `runCommands` and `commandAvailability` are injected rather than created here
 * so a host that already owns a `useRunCommands` instance (the Mobile Dev pane)
 * shares one instance instead of running two that desync.
 */
export function CommandLogsSection({
  taskId,
  projectId,
  workingDir,
  runCommands,
  commandAvailability,
  virtualTabs,
  selectedCommandId,
  onSelectCommand,
  keyScopeRef,
  className,
  emptyText,
}: {
  taskId: string;
  projectId: string;
  workingDir: string;
  runCommands: ReturnType<typeof useRunCommands>;
  commandAvailability: ReturnType<typeof useProjectCommandAvailability>;
  virtualTabs?: ProjectCommand[];
  selectedCommandId: string | null;
  onSelectCommand: (commandId: string | null) => void;
  keyScopeRef: RefObject<HTMLElement | null>;
  className?: string;
  /**
   * Shown when no tab is visible. A host whose tabs are mostly its own
   * (Mobile Dev: Metro and builds) overrides this, because the default talks
   * about *project* commands and would blame the wrong thing.
   */
  emptyText?: string;
}) {
  // `commands` gates restarting (hidden commands are not runnable), while
  // `allCommands` names the tabs so hiding a command does not turn its existing
  // log tab into a "Removed command" entry.
  const { commands, allCommands } = commandAvailability;
  const {
    status,
    isCommandStarting,
    isStartingAnyCommand,
    startCommand,
    portsInUseError,
    confirmKillPorts,
    dismissPortsError,
  } = runCommands;
  const runCommandLogs = useThrottledRunCommandLogs(taskId);
  const resetRunCommandLogs = useTaskMessagesStore(
    (state) => state.resetRunCommandLogs,
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [pendingConfirm, setPendingConfirm] = useState<{
    commandId: string;
    label: string;
    message: string | null;
  } | null>(null);
  const sectionRef = useRef<HTMLDivElement>(null);
  const restartInFlightRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const runningCommandIds = useMemo(
    () =>
      new Set(
        (status?.commands ?? [])
          .filter((entry) => entry.status === 'running')
          .map((entry) => entry.id),
      ),
    [status],
  );

  // Keyed by command id so the focus strip can tell "never started" (no entry)
  // apart from "stopped" and "errored".
  const commandStatusById = useMemo(
    () =>
      new Map(
        (status?.commands ?? []).map((entry) => [entry.id, entry.status]),
      ),
    [status],
  );

  const portsByCommandId = useMemo(
    () => buildCommandPortsById(status?.commands),
    [status],
  );

  const normalizedSearchQuery = searchQuery.trim().toLowerCase();

  const tabs = useMemo(
    () =>
      buildCommandLogTabs({
        commands: allCommands,
        projectId,
        runCommandLogs,
        runningCommandIds,
        virtualTabs,
      }),
    [allCommands, projectId, runCommandLogs, runningCommandIds, virtualTabs],
  );

  const filteredTabs = useMemo(() => {
    if (!normalizedSearchQuery) return tabs;

    return tabs.filter((tab) => {
      if (
        getRunCommandDisplayName(tab)
          .toLowerCase()
          .includes(normalizedSearchQuery)
      ) {
        return true;
      }

      if (
        commandPortsMatchQuery({
          ports: portsByCommandId.get(tab.id),
          query: normalizedSearchQuery,
        })
      ) {
        return true;
      }

      return logIncludesQuery(runCommandLogs[tab.id], normalizedSearchQuery);
    });
  }, [normalizedSearchQuery, portsByCommandId, runCommandLogs, tabs]);

  const selectableTabs = normalizedSearchQuery ? filteredTabs : tabs;
  const activeCommandId =
    selectedCommandId &&
    selectableTabs.some((tab) => tab.id === selectedCommandId)
      ? selectedCommandId
      : (selectableTabs[0]?.id ?? null);
  const activeLog = activeCommandId ? runCommandLogs[activeCommandId] : null;
  const isActiveRunning = !!(
    activeCommandId && runningCommandIds.has(activeCommandId)
  );
  const isActiveStarting = !!(
    activeCommandId && isCommandStarting(activeCommandId)
  );
  const isActiveConfigured = commands.some(
    (command) => command.id === activeCommandId,
  );
  const activePortsLabel = describeCommandPorts(
    activeCommandId ? portsByCommandId.get(activeCommandId) : undefined,
  );
  const activeCommandName = useMemo(() => {
    const tab = tabs.find((entry) => entry.id === activeCommandId);
    return tab ? getRunCommandDisplayName(tab) : '';
  }, [activeCommandId, tabs]);
  const activeStatusLabel = isActiveStarting
    ? 'Starting'
    : isActiveRunning
      ? 'Running'
      : activeCommandId
        ? (commandStatusById.get(activeCommandId) ?? 'not started')
        : 'not started';

  const restartCommand = useCallback(
    async (commandId: string) => {
      if (restartInFlightRef.current) return;
      restartInFlightRef.current = true;
      try {
        await startCommand(commandId);
      } finally {
        restartInFlightRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const requestRestartActiveCommand = useCallback(() => {
    if (
      !activeCommandId ||
      !isActiveConfigured ||
      isActiveStarting ||
      restartInFlightRef.current
    ) {
      return;
    }

    const command = commands.find((entry) => entry.id === activeCommandId);
    if (command?.confirmBeforeRun) {
      setPendingConfirm({
        commandId: activeCommandId,
        label: getRunCommandDisplayName(command),
        message: command.confirmMessage,
      });
      return;
    }

    void restartCommand(activeCommandId);
  }, [
    activeCommandId,
    commands,
    isActiveConfigured,
    isActiveStarting,
    restartCommand,
  ]);

  const handleConfirmRestart = useCallback(() => {
    if (!pendingConfirm) return;

    const commandId = pendingConfirm.commandId;
    setPendingConfirm(null);
    void restartCommand(commandId);
  }, [pendingConfirm, restartCommand]);

  const clearActiveLogs = useCallback(() => {
    if (!activeCommandId) return;
    const generation = resetRunCommandLogs(taskId, activeCommandId);
    void api.runCommands.resetLogs({
      taskId,
      runCommandId: activeCommandId,
      generation,
    });
  }, [activeCommandId, resetRunCommandLogs, taskId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      const scope = keyScopeRef.current;
      const target = event.target;
      if (!(target instanceof Node) || !scope?.contains(target)) return;

      if ((event.metaKey || event.ctrlKey) && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === 'f' && !event.shiftKey) {
          event.preventDefault();
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
          return;
        }

        if (key === 'a' && !event.shiftKey && !isInteractiveTarget(target)) {
          event.preventDefault();
          const section = sectionRef.current;
          if (section) selectActiveLog(section);
          return;
        }

        if (key === 'k' && !event.shiftKey) {
          event.preventDefault();
          clearActiveLogs();
          return;
        }

        if (key === 'u' && event.shiftKey && !event.repeat) {
          event.preventDefault();
          requestRestartActiveCommand();
        }
      }

      if (!activeCommandId || !isActiveRunning || isInteractiveTarget(target)) {
        return;
      }

      const input = keyEventToTerminalInput(event);
      if (input === null) return;

      event.preventDefault();
      void api.runCommands.sendInput({
        taskId,
        runCommandId: activeCommandId,
        input,
      });
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    activeCommandId,
    clearActiveLogs,
    isActiveRunning,
    keyScopeRef,
    requestRestartActiveCommand,
    taskId,
  ]);

  const activeLogView = useMemo(() => {
    return filterLogByQuery(activeLog, normalizedSearchQuery);
  }, [activeLog, normalizedSearchQuery]);
  const hasAnyTabs = tabs.length > 0;
  const showNoSearchMatches =
    normalizedSearchQuery.length > 0 && filteredTabs.length === 0;

  return (
    <div
      ref={sectionRef}
      data-command-logs-section
      className={clsx('flex min-h-0 flex-1 flex-col', className)}
    >
      <div className="flex shrink-0 items-center gap-1 px-4 py-2">
        <Input
          ref={searchInputRef}
          size="sm"
          className="flex-1"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search commands and logs..."
          icon={<Search />}
        />
        <Button
          type="button"
          onClick={requestRestartActiveCommand}
          size="xs"
          variant="secondary"
          icon={<RotateCw />}
          loading={isActiveStarting}
          disabled={!activeCommandId || !isActiveConfigured}
          aria-label="Restart command"
          title="Restart command (⌘⇧U)"
        >
          <Kbd shortcut="cmd+shift+u" />
        </Button>
        <IconButton
          onClick={clearActiveLogs}
          size="sm"
          icon={<Trash2 />}
          tooltip="Clear logs (⌘K)"
        />
      </div>

      <Separator />

      {hasAnyTabs && !showNoSearchMatches ? (
        <>
          <div className="flex shrink-0 gap-1 overflow-x-auto px-2 py-2">
            {filteredTabs.map((tab) => {
              const isRunning = runningCommandIds.has(tab.id);
              const isActive = activeCommandId === tab.id;
              const displayName = getRunCommandDisplayName(tab);
              const portsDescription = describeCommandPorts(
                portsByCommandId.get(tab.id),
              );
              const portsLabel = formatCommandPorts(
                portsByCommandId.get(tab.id),
              );

              return (
                <Button
                  key={tab.id}
                  type="button"
                  variant="tab"
                  size="xs"
                  active={isActive}
                  aria-pressed={isActive}
                  onClick={() => onSelectCommand(tab.id)}
                  className={clsx(
                    'max-w-56 shrink-0',
                    isActive && 'ring-acc ring-1 ring-inset',
                  )}
                  title={`${displayName}${portsDescription ? ` — ${portsDescription}` : ''}${isRunning ? ' (running)' : ''}`}
                  aria-label={`${displayName}${portsDescription ? `, ${portsDescription}` : ''}${isRunning ? ', running' : ''}`}
                >
                  <span
                    className={clsx(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      isRunning ? 'bg-status-done animate-pulse' : 'bg-ink-3/40',
                    )}
                    aria-hidden
                  />
                  <span className="truncate">{displayName}</span>
                  {portsLabel ? (
                    <span className="text-ink-3 shrink-0 font-mono text-[10px]">
                      :{portsLabel}
                    </span>
                  ) : null}
                </Button>
              );
            })}
          </div>
          <Separator />

          {/* Focus strip: the single unambiguous answer to "which command am I
              looking at?" — the toolbar controls all act on this command. */}
          <div className="bg-glass-light flex shrink-0 items-center gap-2 px-4 py-1.5">
            <span
              className="bg-acc h-3.5 w-0.5 shrink-0 rounded-full"
              aria-hidden
            />
            <span className="text-ink-0 truncate font-mono text-xs">
              {activeCommandName}
            </span>
            {activePortsLabel ? (
              <span
                className="text-ink-2 border-line-soft shrink-0 rounded border px-1 py-px font-mono text-[10px]"
                title={`Configured ${activePortsLabel} for this command`}
              >
                {activePortsLabel}
              </span>
            ) : null}
            <span
              className={clsx(
                'ml-auto flex shrink-0 items-center gap-1 text-[10px] font-semibold tracking-wide uppercase',
                isActiveRunning
                  ? 'text-status-done'
                  : activeStatusLabel === 'errored'
                    ? 'text-status-fail'
                    : 'text-ink-3',
              )}
            >
              {isActiveStarting && (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              )}
              {activeStatusLabel}
            </span>
          </div>
          <Separator />

          <InteractiveLog
            log={activeLogView}
            taskId={taskId}
            runCommandId={activeCommandId}
            isRunning={isActiveRunning}
            workingDir={workingDir}
            ignoreBrowserShortcuts
            emptyText={
              normalizedSearchQuery
                ? `No log lines match "${searchQuery.trim()}".`
                : 'Waiting for output...'
            }
          />
        </>
      ) : (
        <div className="text-ink-3 flex flex-1 items-center justify-center px-4 text-sm">
          <span>
            {normalizedSearchQuery
              ? `No command logs match "${searchQuery.trim()}".`
              : (emptyText ??
                getCommandLogsEmptyText({
                  availabilityState: commandAvailability.state,
                  hasConfiguredItems: commandAvailability.hasConfiguredItems,
                }))}
          </span>
          {!normalizedSearchQuery && commandAvailability.state === 'error' ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="ml-2"
              onClick={() => void commandAvailability.retry()}
            >
              Retry
            </Button>
          ) : null}
        </div>
      )}

      {portsInUseError && (
        <KillPortsModal
          error={portsInUseError}
          onConfirm={confirmKillPorts}
          onCancel={dismissPortsError}
          isLoading={isStartingAnyCommand}
        />
      )}

      {pendingConfirm && (
        <ConfirmRunModal
          commandName={pendingConfirm.label}
          message={pendingConfirm.message}
          onConfirm={handleConfirmRestart}
          onCancel={() => setPendingConfirm(null)}
        />
      )}
    </div>
  );
}
