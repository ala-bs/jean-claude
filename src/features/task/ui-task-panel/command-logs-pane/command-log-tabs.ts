import type { MobilePlatform } from '@shared/mobile-simulator-types';
import type {
  CommandRunStatus,
  ProjectCommand,
} from '@shared/run-command-types';
import { getRunCommandLogLineCount } from '@/stores/task-messages';
import { parseMobileBuildCommandId } from '../mobile-preview-pane/utils-setup-operation';
import { parseMobileDevServerCommandId } from '@/lib/mobile-preview-runtime';
import type { RunCommandLogs } from '@/stores/task-messages';

/**
 * Shortens a device id enough to fit a tab label while keeping both ends, which
 * is what distinguishes otherwise similar ids: iOS UDIDs are 36 chars and share
 * no common prefix, Android AVD names are already short and pass through.
 */
export function abbreviateDeviceId(deviceId: string): string {
  if (deviceId.length <= 14) return deviceId;
  return `${deviceId.slice(0, 8)}…${deviceId.slice(-4)}`;
}

/**
 * The one place build tabs are named, so a build reads the same wherever its tab
 * is emitted from.
 *
 * `deviceLabel` is what makes the label unique: build command ids are
 * device-scoped, so two builds on two simulators of the same platform would
 * otherwise render two tabs reading exactly "iOS build" with nothing (not even
 * the tooltip, since builds declare no ports) to tell them apart. Builds with no
 * device (the `no-device` sentinel) keep the plain label.
 */
export function formatMobileBuildTabName({
  platform,
  deviceLabel,
}: {
  platform: MobilePlatform;
  deviceLabel?: string | null;
}): string {
  const base = platform === 'ios' ? 'iOS build' : 'Android build';
  return deviceLabel ? `${base} · ${deviceLabel}` : base;
}

/**
 * Human label for command ids the app itself mints (mobile dev server / builds),
 * so their logs are not shown as anonymous "Removed command" tabs.
 *
 * Only the id is available here, so a build is disambiguated by its abbreviated
 * device id rather than the device's name. The Mobile Dev pane names its own
 * (virtual) build tabs from the live device list and so can use the real name --
 * see `buildMobileDevVirtualTabs`. A build therefore reads
 * "iOS build · iPhone 15" while the pane owns it and "iOS build · ABCD1234…9F2C"
 * once it falls through to here; the asymmetry is unavoidable (this function is
 * called from `buildCommandLogTabs`, which is shared by panes that have no
 * device list at all) and both forms stay unique per device, which is the point.
 */
export function describeWellKnownCommandId(commandId: string): string | null {
  if (parseMobileDevServerCommandId(commandId)) return 'Mobile dev server';

  const build = parseMobileBuildCommandId(commandId);
  if (build) {
    return formatMobileBuildTabName({
      platform: build.platform,
      deviceLabel: build.deviceId
        ? abbreviateDeviceId(build.deviceId)
        : null,
    });
  }

  return null;
}

export function buildCommandLogTabs({
  commands,
  projectId,
  runCommandLogs,
  runningCommandIds,
  virtualTabs = [],
}: {
  commands: ProjectCommand[];
  projectId: string;
  runCommandLogs: RunCommandLogs;
  runningCommandIds: Set<string>;
  /**
   * Tabs owned by another pane (mobile dev server / builds), emitted first and
   * in order. They obey the same visibility rule as configured commands.
   */
  virtualTabs?: ProjectCommand[];
}): ProjectCommand[] {
  const virtualIds = new Set(virtualTabs.map((command) => command.id));

  // A tab survives its process exiting -- that is how you read what happened.
  // It only goes away once its output is cleared *and* nothing is running.
  const hasSomethingToShow = (commandId: string) =>
    getRunCommandLogLineCount(runCommandLogs[commandId]) > 0 ||
    runningCommandIds.has(commandId);

  const visibleVirtualTabs = virtualTabs.filter((command) =>
    hasSomethingToShow(command.id),
  );
  const configuredTabs = commands.filter(
    (command) => !virtualIds.has(command.id) && hasSomethingToShow(command.id),
  );
  const configuredIds = new Set([
    ...virtualIds,
    ...commands.map((command) => command.id),
  ]);
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
        name:
          describeWellKnownCommandId(commandId) ??
          `Removed command (${commandId.slice(0, 8)})`,
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

  return [...visibleVirtualTabs, ...configuredTabs, ...historicalTabs];
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
