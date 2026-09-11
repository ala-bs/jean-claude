import type { MobilePreviewDevice } from '@shared/mobile-simulator-types';

import type { api as realApi } from '@/lib/api';

/**
 * Dispatches the platform-appropriate app restart.
 *
 * Extracted because the two branches call different IPCs with different
 * parameters -- iOS takes `appPath`, Android takes the native
 * `androidProjectPath` -- so swapping them would fail only at runtime, on one
 * platform, with a confusing error.
 */
export async function restartAppOnDevice({
  api,
  device,
  projectId,
  taskId,
  appPath,
  androidProjectPath,
}: {
  api: Pick<typeof realApi.mobilePreview, 'restartIosApp' | 'restartAndroidApp'>;
  device: Pick<MobilePreviewDevice, 'id' | 'platform'>;
  projectId: string;
  taskId: string;
  appPath: string;
  androidProjectPath: string;
}): Promise<{ label: string }> {
  if (device.platform === 'ios') {
    const result = await api.restartIosApp({
      projectId,
      taskId,
      appPath,
      deviceId: device.id,
    });
    return { label: result.bundleId };
  }

  const result = await api.restartAndroidApp({
    projectId,
    taskId,
    androidProjectPath,
    deviceId: device.id,
  });
  return { label: result.packageName };
}
