import type {
  MobilePreviewDevice,
  MobilePreviewExpoLaunchParams,
} from '@shared/mobile-simulator-types';

export type MobilePreviewAutoLaunchDecision =
  | { status: 'idle' }
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

export function canAutoStartMobilePreviewDevice(
  device: Pick<MobilePreviewDevice, 'id' | 'platform' | 'state'> | null | undefined,
): boolean {
  return !!device && device.state !== 'unknown';
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
  completedOwnerKey,
  isSelectedDeviceReady,
}: {
  isRunningRuntime: boolean;
  isLoadingDevices: boolean;
  selectedDevice: Pick<
    MobilePreviewDevice,
    'id' | 'platform' | 'state'
  > | null;
  isExpoApp: boolean;
  taskId: string;
  projectId: string;
  appPath: string;
  metroPort: number;
  completedOwnerKey: string | null;
  isSelectedDeviceReady: boolean;
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

  const ownerKey = [
    taskId,
    appPath,
    selectedDevice.platform,
    selectedDevice.id,
    metroPort,
  ].join('\u0000');
  if (completedOwnerKey === ownerKey) {
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
