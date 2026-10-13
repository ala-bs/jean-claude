import type {
  MobilePreviewAndroidAppStatus,
  MobilePreviewDevice,
  MobilePreviewIosAppStatus,
} from '@shared/mobile-simulator-types';

import type { api as realApi } from '@/lib/api';

export type DeeplinkVerificationResult =
  | ({ platform: 'android' } & MobilePreviewAndroidAppStatus & {
      appId: string | null;
    })
  | ({ platform: 'ios' } & MobilePreviewIosAppStatus & {
      appId: string | null;
    });

/**
 * Refreshes the platform-native app identity used by deeplink verification.
 * The two status services intentionally stay behind one renderer seam so the
 * Mobile Dev pane cannot accidentally send iOS paths to Android or vice versa.
 */
export async function verifyDeeplinkOnDevice({
  api,
  device,
  projectId,
  taskId,
  appPath,
  androidProjectPath,
}: {
  api: Pick<
    typeof realApi.mobilePreview,
    'getAndroidAppStatus' | 'getIosAppStatus'
  >;
  device: Pick<MobilePreviewDevice, 'id' | 'platform'>;
  projectId: string;
  taskId: string;
  appPath: string;
  androidProjectPath: string;
}): Promise<DeeplinkVerificationResult> {
  if (device.platform === 'android') {
    const status = await api.getAndroidAppStatus({
      projectId,
      taskId,
      androidProjectPath,
      deviceId: device.id,
    });
    return {
      ...status,
      platform: 'android',
      appId: status.packageName,
    };
  }

  const status = await api.getIosAppStatus({
    projectId,
    taskId,
    appPath,
    deviceId: device.id,
    requestId: crypto.randomUUID(),
  });
  return {
    ...status,
    platform: 'ios',
    appId: status.bundleId,
  };
}
