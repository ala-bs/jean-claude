import type { MobilePlatform } from '@shared/mobile-simulator-types';
import type { ProjectCommand } from '@shared/run-command-types';

import {
  abbreviateDeviceId,
  formatMobileBuildTabName,
} from '../command-logs-pane/command-log-tabs';
import { parseMobileBuildCommandId } from '../mobile-preview-pane/utils-setup-operation';

/** Just enough of `MobilePreviewDevice` to name a build after its device. */
type NamedDevice = { platform: MobilePlatform; id: string; name: string };

/**
 * The pane's streams are ad-hoc run commands, so the shared tab builder has no
 * `ProjectCommand` to name or order them by. Synthesizing one here is what gives
 * Metro and the build a real name and the leading slots in the rail.
 *
 * These are *candidates*, not guarantees: `buildCommandLogTabs` still applies
 * the one visibility rule (running, or has output) to them.
 */
function makeVirtualTab({
  id,
  projectId,
  name,
  sortOrder,
}: {
  id: string;
  projectId: string;
  name: string;
  sortOrder: number;
}): ProjectCommand {
  return {
    id,
    projectId,
    name,
    command: '',
    // Always empty: the tab rail labels ports exclusively from the live run
    // status (`buildCommandPortsById`), so nothing ever reads this.
    ports: [],
    portConflictStrategy: 'prompt',
    portOverrideProvider: 'env',
    portOverrideEnvVar: null,
    portOverrideArgs: null,
    envVars: [],
    sortOrder,
    confirmBeforeRun: false,
    confirmMessage: null,
    isFavorite: false,
    isHidden: false,
    createdAt: '',
  };
}

/**
 * The device part of a build tab's label, preferring the human name.
 *
 * Falls back to the abbreviated id when the device is not in the live list
 * (unplugged handset, deleted simulator, or a build that outlived it), and
 * appends the id when two devices on one platform share a name -- duplicate
 * simulator names are allowed, and two identical labels is exactly the bug this
 * exists to prevent.
 */
function resolveDeviceLabel({
  platform,
  deviceId,
  devices,
}: {
  platform: MobilePlatform;
  deviceId: string | undefined;
  devices: NamedDevice[];
}): string | null {
  if (!deviceId) return null;

  const device = devices.find(
    (candidate) => candidate.platform === platform && candidate.id === deviceId,
  );
  if (!device?.name) return abbreviateDeviceId(deviceId);

  const isAmbiguous = devices.some(
    (candidate) =>
      candidate.platform === platform &&
      candidate.id !== device.id &&
      candidate.name === device.name,
  );
  return isAmbiguous
    ? `${device.name} (${abbreviateDeviceId(device.id)})`
    : device.name;
}

/**
 * Candidate log tabs owned by the Mobile Dev pane: Metro first, then the
 * selected device's build, then -- if different -- the build the user was last
 * shown.
 *
 * That last one is the point: build command ids are device-scoped, so switching
 * device (or stopping Metro, which clears the selection) would otherwise yank a
 * running build's tab out from under the user while its output kept
 * accumulating out of reach.
 *
 * Still needed now that tabs survive on log lines alone: a build with no output
 * yet would have nothing to survive on, and one that does have output would
 * only come back as a *historical* tab -- last in the rail, behind every project
 * command, instead of keeping its slot next to Metro.
 */
export function buildMobileDevVirtualTabs({
  projectId,
  devServerCommandId,
  buildCommandId,
  stickyBuildCommandId,
  activeDevice,
  devices = [],
}: {
  projectId: string;
  devServerCommandId: string;
  buildCommandId: string | null;
  stickyBuildCommandId: string | null;
  activeDevice: { platform: MobilePlatform } | null;
  /**
   * Live device list, used only to name build tabs after their device. Optional
   * because a missing list degrades to the abbreviated device id rather than
   * losing the distinction between two builds.
   */
  devices?: NamedDevice[];
}): ProjectCommand[] {
  const tabs: ProjectCommand[] = [
    makeVirtualTab({
      id: devServerCommandId,
      projectId,
      name: 'Metro',
      sortOrder: -2,
    }),
  ];

  const pushBuildTab = (commandId: string, platform?: MobilePlatform) => {
    // The id is the source of truth for the device: even for the current
    // selection it is what the log stream is keyed by, so naming from it keeps
    // the tab pointing at the stream it actually shows.
    const parsed = parseMobileBuildCommandId(commandId);
    const resolved = parsed?.platform ?? platform ?? null;
    tabs.push(
      makeVirtualTab({
        id: commandId,
        projectId,
        name: resolved
          ? formatMobileBuildTabName({
              platform: resolved,
              deviceLabel: resolveDeviceLabel({
                platform: resolved,
                deviceId: parsed?.deviceId,
                devices,
              }),
            })
          : 'Build',
        sortOrder: -1,
      }),
    );
  };

  if (buildCommandId) pushBuildTab(buildCommandId, activeDevice?.platform);

  if (stickyBuildCommandId && stickyBuildCommandId !== buildCommandId) {
    pushBuildTab(stickyBuildCommandId);
  }

  return tabs;
}
