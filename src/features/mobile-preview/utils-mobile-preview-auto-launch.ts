import {
  isPhysicalMobilePreviewDevice,
  type MobilePreviewDevice,
  type MobilePreviewExpoLaunchParams,
} from '@shared/mobile-simulator-types';

export type MobilePreviewAutoLaunchDecision =
  | {
      status: 'idle';
      /**
       * Set when the device simply cannot be launched (physical iPhone), as
       * opposed to the runtime being stopped. The hook must NOT drop the
       * shared completed-launch memo in that case — the memo belongs to
       * whichever simulator was launched before this device was selected.
       */
      keepCompletedLaunch?: boolean;
    }
  | {
      status: 'waiting' | 'ready' | 'unsupported';
      message: string;
    }
  | {
      status: 'launching';
      message: string;
      ownerKey: string;
      params: Omit<MobilePreviewExpoLaunchParams, 'requestId'>;
    };

/**
 * Auto-start never fires for physical hardware: booting or installing on
 * someone's real handset must always be an explicit, deliberate click.
 */
export function canAutoStartMobilePreviewDevice(
  device:
    | Pick<MobilePreviewDevice, 'id' | 'platform' | 'state' | 'kind'>
    | null
    | undefined,
): boolean {
  if (!device) return false;
  if (isPhysicalMobilePreviewDevice(device)) return false;
  return device.state !== 'unknown';
}

export function getMobilePreviewAutoLaunchDecision({
  isRunningRuntime,
  isLoadingDevices,
  selectedDevice,
  isExpoApp,
  taskId,
  projectId,
  appPath,
  metroPort,
  devServerPid = null,
  completedOwnerKey = null,
  hasCompletedLaunch,
  isSelectedDeviceReady,
  isAppInstalled = null,
}: {
  isRunningRuntime: boolean;
  isLoadingDevices: boolean;
  selectedDevice: Pick<
    MobilePreviewDevice,
    'id' | 'platform' | 'state' | 'kind'
  > | null;
  isExpoApp: boolean;
  taskId: string;
  projectId: string;
  appPath: string;
  metroPort: number;
  /** Restarting the dev server must re-attach even if the port is unchanged. */
  devServerPid?: number | null;
  completedOwnerKey?: string | null;
  /** Shared across pane remounts so re-entering the workspace never relaunches. */
  hasCompletedLaunch?: (ownerKey: string) => boolean;
  isSelectedDeviceReady: boolean;
  /** null while the install status is still unknown. */
  isAppInstalled?: boolean | null;
}): MobilePreviewAutoLaunchDecision {
  if (!isRunningRuntime) return { status: 'idle' };
  if (isLoadingDevices) {
    return { status: 'waiting', message: 'Restoring device selection' };
  }
  if (!selectedDevice) {
    return {
      status: 'waiting',
      message: 'Select a device to attach this runtime',
    };
  }
  // `exp://` deeplinking into an already-installed app is simulator-only on
  // iOS (there is no `simctl openurl` for CoreDevice hardware), so launching
  // here can only reject with the main-process guard and paint an error the
  // user cannot act on. Stay idle instead — Build & Run
  // (`expo run:ios --device`) is the supported path. Do NOT re-enable this.
  if (selectedDevice.platform === 'ios' && selectedDevice.kind === 'physical') {
    return { status: 'idle', keepCompletedLaunch: true };
  }
  if (selectedDevice.state !== 'booted' && !isSelectedDeviceReady) {
    return {
      status: 'waiting',
      message: 'Boot selected device to attach this runtime',
    };
  }
  if (!isExpoApp) {
    return {
      status: 'unsupported',
      message:
        'Automatic Metro reassignment is unavailable for vanilla React Native. Device stream remains available.',
    };
  }

  // Launching opens an `exp://` deeplink, which only resolves when the dev
  // client (or Expo Go) is installed on the device. Without it the simulator
  // answers with LSApplicationWorkspaceErrorDomain 115.
  if (isAppInstalled === false) {
    return {
      status: 'waiting',
      message: 'Install the app (or Expo Go) on this device first — Setup → Build',
    };
  }

  const ownerKey = [
    taskId,
    appPath,
    selectedDevice.platform,
    selectedDevice.id,
    metroPort,
    devServerPid ?? 'unknown-process',
  ].join('\u0000');
  if (completedOwnerKey === ownerKey || hasCompletedLaunch?.(ownerKey) === true) {
    return { status: 'ready', message: 'Expo app attached' };
  }
  return {
    status: 'launching',
    message: `Launching Expo on :${metroPort}`,
    ownerKey,
    params: {
      taskId,
      projectId,
      appPath,
      platform: selectedDevice.platform,
      deviceId: selectedDevice.id,
      metroPort,
    },
  };
}
