import type {
  CommandRunStatus,
  ProjectCommand,
} from '@shared/run-command-types';
import { getRunCommandLogLineCount } from '@/stores/task-messages';
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
        isHidden: false,
        createdAt: '',
      }),
    );

  return [...configuredTabs, ...historicalTabs];
}

/**
 * Effective (runtime) ports per command id, from the main process run status.
 *
 * These are resolved by `run-command-service` and account for
 * `use-available-port` reassignment, so they beat `ProjectCommand.ports`
 * (the declared config) as "the port the user can actually open".
 *
 * Only *running* commands are included: a tracked process that exits on its own
 * keeps its ports on the status entry, which would otherwise advertise a port
 * nothing is listening on.
 */
export function buildCommandPortsById(
  commands: Pick<CommandRunStatus, 'id' | 'ports' | 'status'>[] | undefined,
): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const entry of commands ?? []) {
    if (entry.status !== 'running') continue;
    const ports = (entry.ports ?? []).filter(
      (port) => Number.isInteger(port) && port > 0 && port <= 65_535,
    );
    if (ports.length > 0) map.set(entry.id, ports);
  }
  return map;
}

export function formatCommandPorts(ports: number[] | undefined): string | null {
  if (!ports || ports.length === 0) return null;
  return ports.join(', ');
}

/** "port 3000" / "ports 3000, 9229" */
export function describeCommandPorts(
  ports: number[] | undefined,
): string | null {
  const label = formatCommandPorts(ports);
  if (!label || !ports) return null;
  return `${ports.length > 1 ? 'ports' : 'port'} ${label}`;
}

export function commandPortsMatchQuery({
  ports,
  query,
}: {
  ports: number[] | undefined;
  query: string;
}): boolean {
  if (!ports || !query) return false;
  return ports.some((port) => String(port).includes(query));
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
