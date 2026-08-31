import { getRunCommandLogLineCount } from '@/stores/task-messages';
import type { ProjectCommand } from '@shared/run-command-types';
import type { RunCommandLogs } from '@/stores/task-messages';

export function buildCommandLogTabs({
  commands,
  projectId,
  runCommandLogs,
  runningCommandIds,
}: {
  commands: ProjectCommand[];
  projectId: string;
  runCommandLogs: RunCommandLogs;
  runningCommandIds: Set<string>;
}): ProjectCommand[] {
  const configuredTabs = commands.filter(
    (command) =>
      getRunCommandLogLineCount(runCommandLogs[command.id]) > 0 ||
      runningCommandIds.has(command.id),
  );
  const configuredIds = new Set(commands.map((command) => command.id));
  const historicalTabs = Object.keys(runCommandLogs)
    .filter(
      (commandId) =>
        !configuredIds.has(commandId) &&
        getRunCommandLogLineCount(runCommandLogs[commandId]) > 0,
    )
    .map(
      (commandId): ProjectCommand => ({
        id: commandId,
        projectId,
        name: `Removed command (${commandId.slice(0, 8)})`,
        command: '',
        ports: [],
        portConflictStrategy: 'prompt',
        portOverrideProvider: 'env',
        portOverrideEnvVar: null,
        portOverrideArgs: null,
        envVars: [],
        sortOrder: Number.MAX_SAFE_INTEGER,
        confirmBeforeRun: false,
        confirmMessage: null,
        isFavorite: false,
        createdAt: '',
      }),
    );

  return [...configuredTabs, ...historicalTabs];
}

export function getCommandLogsEmptyText({
  availabilityState,
  hasConfiguredItems,
}: {
  availabilityState: 'loading' | 'error' | 'ready';
  hasConfiguredItems: boolean;
}): string {
  if (availabilityState === 'loading') return 'Loading project commands...';
  if (availabilityState === 'error') return 'Could not load project commands.';
  return hasConfiguredItems
    ? 'No commands have been run in this workspace.'
    : 'No project commands configured. No historical command logs are available.';
}
