import { FileText, Loader2, Play, Square } from 'lucide-react';
import { type MutableRefObject, useMemo, useState } from 'react';
import clsx from 'clsx';

import {
  type CommandRunStatus,
  getRunCommandDisplayName,
} from '@shared/run-command-types';
import { Dropdown, DropdownDivider, DropdownItem } from '@/common/ui/dropdown';
import {
  getRunCommandAction,
  getRunConfirmation,
  resolveRunCommandIds,
} from '@/lib/run-command-items';
import {
  getRunCommandLogLineCount,
  useTaskMessagesStore,
} from '@/stores/task-messages';
import { Button } from '@/common/ui/button';
import { Chip } from '@/common/ui/chip';
import { Kbd } from '@/common/ui/kbd';
import { useProjectCommandAvailability } from '@/hooks/use-project-command-availability';
import { useRunCommands } from '@/hooks/use-run-commands';
import { useToastStore } from '@/stores/toasts';

import { ConfirmRunModal } from './confirm-run-modal';
import { KillPortsModal } from './kill-ports-modal';

export function RunButton({
  taskId,
  projectId,
  workingDir,
  onToggleLogs,
  onRunCommand,
  isLogsPaneOpen,
  dropdownRef,
  showAvailabilityState = true,
}: {
  taskId: string;
  projectId: string;
  workingDir: string;
  onToggleLogs: () => void;
  onRunCommand: (runCommandIds: string[]) => void;
  isLogsPaneOpen: boolean;
  dropdownRef?: MutableRefObject<{ toggle: () => void } | null>;
  showAvailabilityState?: boolean;
}) {
  const commandAvailability = useProjectCommandAvailability(projectId);
  const { commands, groups, items: menuItems } = commandAvailability;
  const {
    status,
    statusByCommandId,
    isCommandStarting,
    isCommandStopping,
    isStartingAnyCommand,
    startCommand,
    startGroup,
    stopCommand,
    stopGroup,
    portsInUseError,
    confirmKillPorts,
    dismissPortsError,
  } = useRunCommands({ taskId, projectId, workingDir });
  const addToast = useToastStore((state) => state.addToast);

  const [pendingConfirm, setPendingConfirm] = useState<{
    commandIds: string[];
    label: string;
    message: string | null;
  } | null>(null);

  const hasRunCommandLogEntries = useTaskMessagesStore((state) => {
    const runCommandLogs = state.runCommandLogs[taskId];
    if (!runCommandLogs) return false;

    return Object.values(runCommandLogs).some(
      (entry) => getRunCommandLogLineCount(entry) > 0,
    );
  });

  const hasLogEntries =
    hasRunCommandLogEntries || (status?.commands.length ?? 0) > 0;
  const logsButton = hasLogEntries ? (
    <Button
      onClick={onToggleLogs}
      variant={isLogsPaneOpen ? 'primary' : 'secondary'}
      size="xs"
      icon={<FileText />}
      aria-label="Open command logs"
      title="Open command logs (⌘L)"
    >
      <Kbd
        shortcut="cmd+l"
        className={clsx(
          isLogsPaneOpen && 'border-white/25 bg-white/10 text-white/90',
        )}
      />
    </Button>
  ) : null;

  const configuredCommandIds = useMemo(
    () => new Set(commands.map((command) => command.id)),
    [commands],
  );
  const adHocRunningCommands = useMemo(
    () =>
      (status?.commands ?? []).filter(
        (command) =>
          command.status === 'running' && !configuredCommandIds.has(command.id),
      ),
    [configuredCommandIds, status?.commands],
  );

  if (commandAvailability.state === 'loading') {
    return showAvailabilityState ? (
      <div className="flex items-center gap-2">
        <span className="text-ink-3 flex items-center gap-1.5 text-xs">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          Loading commands...
        </span>
        {logsButton}
      </div>
    ) : null;
  }

  if (commandAvailability.state === 'error') {
    return showAvailabilityState ? (
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => void commandAvailability.retry()}
        >
          Retry commands
        </Button>
        {logsButton}
      </div>
    ) : null;
  }

  // Keep historical logs reachable after command configuration is removed.
  if (menuItems.length === 0 && adHocRunningCommands.length === 0 && !hasLogEntries) {
    return null;
  }

  const runningCommandIds = Object.values(statusByCommandId)
    .filter((command) => command.status === 'running')
    .map((command) => command.id);
  const runningCount = runningCommandIds.length;
  const runningCommandIdSet = new Set(runningCommandIds);
  const firstRunningMenuIndex = menuItems.findIndex((menuItem) =>
    resolveRunCommandIds({ item: menuItem, commands }).some((commandId) =>
      runningCommandIdSet.has(commandId),
    ),
  );

  // Start/stop failures reject out of useRunCommands. Without this the promise
  // is discarded and a rejected launch looks like the button did nothing.
  const reportFailure = (action: string) => (error: unknown) => {
    addToast({
      type: 'error',
      message: error instanceof Error ? error.message : `Failed to ${action}`,
    });
  };

  const executeCommand = (runCommandId: string) => {
    onRunCommand([runCommandId]);
    void startCommand(runCommandId).catch(reportFailure('start command'));
  };

  const executeGroup = (runCommandIds: string[]) => {
    if (runCommandIds.length === 0) return;
    onRunCommand(runCommandIds);
    void startGroup(runCommandIds).catch(reportFailure('start commands'));
  };

  const handleCommandAction = (runCommandId: string) => {
    if (isCommandStarting(runCommandId) || isCommandStopping(runCommandId)) {
      return;
    }

    const command = commands.find((entry) => entry.id === runCommandId);
    if (!command) {
      return;
    }

    const action = getRunCommandAction({
      commandIds: [runCommandId],
      runningCommandIds,
    });
    if (action.type === 'stop') {
      void stopCommand(action.commandIds[0]).catch(reportFailure('stop command'));
      return;
    }

    const confirmation = getRunConfirmation({
      item: { type: 'command', item: command },
      commands,
    });
    if (confirmation) {
      setPendingConfirm({
        commandIds: [runCommandId],
        ...confirmation,
      });
      return;
    }

    executeCommand(runCommandId);
  };

  const handleRunningAdHocAction = (command: CommandRunStatus) => {
    if (isCommandStopping(command.id)) return;
    void stopCommand(command.id).catch(reportFailure('stop command'));
  };

  const handleGroupAction = (groupId: string) => {
    const group = groups.find((entry) => entry.id === groupId);
    if (!group) {
      return;
    }

    const item = { type: 'group' as const, item: group };
    const groupCommandIds = resolveRunCommandIds({ item, commands });
    const action = getRunCommandAction({
      commandIds: groupCommandIds,
      runningCommandIds,
    });
    if (action.type === 'disabled') {
      return;
    }

    if (
      groupCommandIds.some(
        (commandId) =>
          isCommandStarting(commandId) || isCommandStopping(commandId),
      )
    ) {
      return;
    }

    if (action.type === 'stop') {
      void stopGroup(action.commandIds).catch(reportFailure('stop commands'));
      return;
    }

    const confirmation = getRunConfirmation({ item, commands });
    if (confirmation) {
      setPendingConfirm({
        commandIds: action.commandIds,
        ...confirmation,
      });
      return;
    }

    executeGroup(action.commandIds);
  };

  const handleConfirmRun = () => {
    if (!pendingConfirm) {
      return;
    }

    const commandIds = pendingConfirm.commandIds.filter((id) =>
      commands.some((command) => command.id === id),
    );
    setPendingConfirm(null);

    if (commandIds.length === 1) {
      executeCommand(commandIds[0]);
      return;
    }

    if (commandIds.length > 1) {
      executeGroup(commandIds);
    }
  };

  const handleCancelConfirm = () => {
    setPendingConfirm(null);
  };

  return (
    <>
      <div className="flex items-center gap-2">
        {menuItems.length > 0 || adHocRunningCommands.length > 0 ? (
          <Dropdown
            align="right"
            dropdownRef={dropdownRef}
            initialFocusIndex={
              firstRunningMenuIndex >= 0 ? firstRunningMenuIndex : 0
            }
            trigger={
              <button
                className={clsx(
                  'flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium transition-colors',
                  runningCount > 0
                    ? 'bg-red-600 text-white hover:bg-red-700'
                    : 'bg-green-600 text-white hover:bg-green-700',
                )}
                aria-label="Run command"
              >
                {runningCount > 0 ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    <Square className="h-3 w-3" aria-hidden />
                  </>
                ) : (
                  <Play className="h-3 w-3" aria-hidden />
                )}
                <Kbd
                  shortcut="cmd+u"
                  className="border-white/25 bg-white/10 text-white/90"
                />
              </button>
            }
          >
            {adHocRunningCommands.map((command, index) => {
              const isBusy = isCommandStopping(command.id);
              return (
                <div key={`adhoc:${command.id}`}>
                  <DropdownItem onClick={() => handleRunningAdHocAction(command)}>
                    <span className="text-ink-2 mr-2 truncate text-xs">
                      {getRunCommandDisplayName(command)}
                    </span>
                    <Chip size="xs" color="red" className="uppercase">
                      {isBusy ? '...' : 'Stop'}
                    </Chip>
                  </DropdownItem>
                  {(index < adHocRunningCommands.length - 1 ||
                    menuItems.length > 0) && <DropdownDivider />}
                </div>
              );
            })}
          {menuItems.map((menuItem, index) => {
            if (menuItem.type === 'command') {
              const command = menuItem.item;
              const commandStatus = statusByCommandId[command.id];
              const isRunningCommand = commandStatus?.status === 'running';
              const isBusy =
                isCommandStarting(command.id) || isCommandStopping(command.id);

              return (
                <div key={`command:${command.id}`}>
                  <DropdownItem onClick={() => handleCommandAction(command.id)}>
                    <span className="text-ink-2 mr-2 truncate text-xs">
                      {getRunCommandDisplayName(command)}
                    </span>
                    <Chip
                      size="xs"
                      color={isRunningCommand ? 'red' : 'green'}
                      className="uppercase"
                    >
                      {isBusy ? '...' : isRunningCommand ? 'Stop' : 'Run'}
                    </Chip>
                  </DropdownItem>
                  {index < menuItems.length - 1 && <DropdownDivider />}
                </div>
              );
            }

            const group = menuItem.item;
            const groupCommandIds = resolveRunCommandIds({
              item: menuItem,
              commands,
            });
            const runningInGroup = groupCommandIds.filter(
              (commandId) => statusByCommandId[commandId]?.status === 'running',
            ).length;
            const isBusy = groupCommandIds.some(
              (commandId) =>
                isCommandStarting(commandId) || isCommandStopping(commandId),
            );

            return (
              <div key={`group:${group.id}`}>
                <DropdownItem onClick={() => handleGroupAction(group.id)}>
                  <span className="text-ink-2 mr-2 truncate text-xs">
                    {group.name}
                  </span>
                  <Chip size="xs" color="blue">
                    Group
                  </Chip>
                  <Chip
                    size="xs"
                    color={runningInGroup > 0 ? 'red' : 'green'}
                    className="uppercase"
                  >
                    {isBusy ? '...' : runningInGroup > 0 ? 'Stop' : 'Run'}
                  </Chip>
                </DropdownItem>
                {index < menuItems.length - 1 && <DropdownDivider />}
              </div>
            );
          })}
          </Dropdown>
        ) : null}

        {logsButton}
      </div>

      {pendingConfirm && (
        <ConfirmRunModal
          commandName={pendingConfirm.label}
          message={pendingConfirm.message}
          onConfirm={handleConfirmRun}
          onCancel={handleCancelConfirm}
        />
      )}

      {portsInUseError && (
        <KillPortsModal
          error={portsInUseError}
          onConfirm={() => {
            void confirmKillPorts().catch(reportFailure('start commands'));
          }}
          onCancel={dismissPortsError}
          isLoading={isStartingAnyCommand}
        />
      )}
    </>
  );
}
