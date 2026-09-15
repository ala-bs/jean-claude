import type { MobilePreviewDevice } from '@shared/mobile-simulator-types';
import type { MobilePreviewProjectConfig } from '@shared/types';

import {
  applyDeviceToBuildCommand,
  getDeviceBuildCommandNotice,
} from '../mobile-preview-pane/utils-device-build-command';
import { getMobileBuildCommandId } from '../mobile-preview-pane/utils-setup-operation';

const PLATFORM_LABEL = { ios: 'iOS', android: 'Android' } as const;

/** First candidate that is more than whitespace, in precedence order. */
function firstUsableCommand(
  candidates: ReadonlyArray<string | null | undefined>,
) {
  return candidates.find((candidate) => candidate?.trim()) ?? null;
}

/**
 * Resolves the build command the dev pane's Build button should run for the
 * currently selected device.
 *
 * Shares the preview pane's helpers on purpose: the command id must match
 * (`getMobileBuildCommandId`) so both panes show the same status and log stream
 * for the same build, and the device targeting rules (`{{device}}` token, CLI
 * flag table, script-runner inference) must not diverge between the two.
 *
 * Falls back to the detected build command when the project config has no
 * explicit one — detection normally writes it into the config, but a project
 * detected before that field existed would otherwise show no Build button at
 * all.
 */
export function resolveMobileDevBuildCommand({
  config,
  appPath,
  device,
}: {
  config: MobilePreviewProjectConfig | null | undefined;
  appPath: string;
  device: MobilePreviewDevice | null;
}): {
  /** Null only when no device is selected — a build is always device-scoped. */
  commandId: string | null;
  command: string | null;
  /** Why the build cannot run, for the button's tooltip. Null when runnable. */
  unavailableReason: string | null;
  /** Advisory text shown when the command could not be pointed at the device. */
  notice: string | null;
} {
  if (!device) {
    return {
      commandId: null,
      command: null,
      unavailableReason: 'Select a device to build.',
      notice: null,
    };
  }

  const detectedApp = config?.detectedApps?.find((app) => app.path === appPath);
  // Each candidate is validated before it is chosen, not after: settings
  // normalize an emptied field to null but not to whitespace, and a `"   "`
  // override winning the `??` would mask a perfectly good detected command.
  const configured =
    device.platform === 'android'
      ? firstUsableCommand([
          config?.androidBuildCommand,
          detectedApp?.detectedAndroidBuildCommand,
        ])
      : firstUsableCommand([
          config?.iosBuildCommand,
          detectedApp?.detectedIosBuildCommand,
        ]);

  const commandId = getMobileBuildCommandId({
    appPath,
    platform: device.platform,
    deviceId: device.id,
  });

  if (!configured) {
    return {
      commandId,
      command: null,
      unavailableReason: `No ${PLATFORM_LABEL[device.platform]} build command is configured (Project settings → Mobile preview).`,
      notice: null,
    };
  }

  const applied = applyDeviceToBuildCommand({
    command: configured,
    device,
    stacks: detectedApp?.stacks ?? null,
  });

  return {
    commandId,
    command: applied.command,
    unavailableReason: null,
    notice: getDeviceBuildCommandNotice(applied),
  };
}
