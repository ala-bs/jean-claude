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
  const commands = commandsQuery.data ?? [];
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
