import {
  buildRunCommandItems,
  resolveRunCommandIds,
} from '@/lib/run-command-items';
import type {
  ProjectCommand,
  ProjectCommandGroup,
} from '@shared/run-command-types';
import { useProjectCommandGroups } from '@/hooks/use-project-command-groups';
import { useProjectCommands } from '@/hooks/use-project-commands';

type CommandQuery<T> = {
  data: T[] | undefined;
  isError: boolean;
  isSuccess: boolean;
  refetch: () => Promise<unknown>;
};

export function resolveProjectCommandAvailability({
  commandsQuery,
  groupsQuery,
}: {
  commandsQuery: CommandQuery<ProjectCommand>;
  groupsQuery: CommandQuery<ProjectCommandGroup>;
}) {
  // Hidden commands stay configured but are never offered as runnable, so they
  // are filtered out before items and group members are resolved. Consumers
  // that only need to name a command (log tabs) should use `allCommands`, so
  // hiding a command does not relabel its existing logs as removed.
  const allCommands = commandsQuery.data ?? [];
  const commands = allCommands.filter((command) => !command.isHidden);
  const groups = groupsQuery.data ?? [];
  const items = buildRunCommandItems({ commands, groups }).filter(
    (item) =>
      item.type === 'command' ||
      resolveRunCommandIds({ item, commands }).length > 0,
  );
  const state =
    commandsQuery.isError || groupsQuery.isError
      ? ('error' as const)
      : commandsQuery.isSuccess && groupsQuery.isSuccess
        ? ('ready' as const)
        : ('loading' as const);

  return {
    commands,
    allCommands,
    groups,
    items,
    state,
    hasConfiguredItems: state === 'ready' && items.length > 0,
    retry: async () => {
      await Promise.all([commandsQuery.refetch(), groupsQuery.refetch()]);
    },
  };
}

export function useProjectCommandAvailability(projectId: string) {
  const commandsQuery = useProjectCommands(projectId);
  const groupsQuery = useProjectCommandGroups(projectId);

  return resolveProjectCommandAvailability({ commandsQuery, groupsQuery });
}
