import type {
  ProjectCommand,
  ProjectCommandGroup,
} from '@shared/run-command-types';
import { getRunCommandDisplayName } from '@shared/run-command-types';

export type RunCommandItem =
  | { type: 'command'; item: ProjectCommand }
  | { type: 'group'; item: ProjectCommandGroup };

export type RunCommandAction =
  | { type: 'disabled'; commandIds: [] }
  | {
      type: 'run' | 'stop';
      commandIds: [string, ...string[]];
    };

function hasCommandIds(
  commandIds: string[],
): commandIds is [string, ...string[]] {
  return commandIds.length > 0;
}

export function buildRunCommandItems({
  commands,
  groups,
}: {
  commands: ProjectCommand[];
  groups: ProjectCommandGroup[];
}): RunCommandItem[] {
  return [
    ...commands.map((item) => ({ type: 'command' as const, item })),
    ...groups.map((item) => ({ type: 'group' as const, item })),
  ].sort(
    (a, b) =>
      a.item.sortOrder - b.item.sortOrder ||
      a.item.createdAt.localeCompare(b.item.createdAt),
  );
}

export function resolveRunCommandIds({
  item,
  commands,
}: {
  item: RunCommandItem;
  commands: ProjectCommand[];
}): string[] {
  if (item.type === 'command') {
    return [item.item.id];
  }

  const commandIds = new Set(commands.map((command) => command.id));
  return item.item.commandIds.filter((commandId) => commandIds.has(commandId));
}

export function getRunConfirmation({
  item,
  commands,
}: {
  item: RunCommandItem;
  commands: ProjectCommand[];
}): { label: string; message: string | null } | null {
  if (item.type === 'command') {
    if (!item.item.confirmBeforeRun) {
      return null;
    }

    return {
      label: getRunCommandDisplayName(item.item),
      message: item.item.confirmMessage,
    };
  }

  const commandsById = new Map(commands.map((command) => [command.id, command]));
  const groupCommands = item.item.commandIds.flatMap((commandId) => {
    const command = commandsById.get(commandId);
    return command ? [command] : [];
  });
  const confirmCommands = groupCommands.filter(
    (command) => command.confirmBeforeRun,
  );
  if (groupCommands.length === 0 || confirmCommands.length === 0) {
    return null;
  }

  return {
    label: item.item.name,
    message:
      confirmCommands
        .map((command) => command.confirmMessage?.trim())
        .filter((message): message is string => Boolean(message))
        .join('\n') ||
      `Run group ${item.item.name} (${groupCommands.length} commands)?`,
  };
}

export function getRunCommandAction({
  commandIds,
  runningCommandIds,
}: {
  commandIds: string[];
  runningCommandIds: string[];
}): RunCommandAction {
  if (!hasCommandIds(commandIds)) {
    return { type: 'disabled', commandIds: [] };
  }

  const runningCommandIdSet = new Set(runningCommandIds);
  const runningMembers = commandIds.filter((commandId) =>
    runningCommandIdSet.has(commandId),
  );
  if (hasCommandIds(runningMembers)) {
    return { type: 'stop', commandIds: runningMembers };
  }

  return { type: 'run', commandIds };
}
