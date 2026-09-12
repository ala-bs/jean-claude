import type { MobilePreviewDevice } from '@shared/mobile-simulator-types';

import type { api as realApi } from '@/lib/api';

let nextRestartLaunchId = 0;

/**
 * `launchExpo` keys in-flight work by `requestId` and deletes the owner entry
 * in its `finally` when the id still matches. Reusing an id across two restarts
 * of the same device therefore lets the first launch's teardown clear the
 * second launch's claim, which then fails with "request superseded". So the id
 * must be unique per invocation, exactly like `createRequestId` in
 * `use-mobile-preview-expo-launch`.
 */
function createRestartLaunchRequestId(): string {
  nextRestartLaunchId += 1;
  return `mobile-dev-restart:${Date.now()}:${nextRestartLaunchId}`;
}

/**
 * Dispatches the platform-appropriate app restart, then re-points the app at
 * the live Metro port.
 *
 * Extracted because the two restart branches call different IPCs with different
 * parameters -- iOS takes `appPath`, Android takes the native
 * `androidProjectPath` -- so swapping them would fail only at runtime, on one
 * platform, with a confusing error.
 *
 * The re-attach exists because terminating and relaunching the native process
 * does not tell the dev client which Metro to use: it reconnects to the bundle
 * URL it remembered from its previous run, which is stale whenever Metro moved
 * off the configured port. Only the `exp://` deeplink rebinds it.
 */
export async function restartAppOnDevice({
  api,
  device,
  projectId,
  taskId,
  appPath,
  androidProjectPath,
  reattach,
}: {
  api: Pick<
    typeof realApi.mobilePreview,
    'restartIosApp' | 'restartAndroidApp' | 'launchExpo'
  >;
  device: Pick<MobilePreviewDevice, 'id' | 'platform'>;
  projectId: string;
  taskId: string;
  appPath: string;
  androidProjectPath: string;
  /**
   * `null` when the app is not an Expo app, or when the dev server is not
   * running -- `launchExpo` rejects unless a running dev-server command is
   * serving exactly `metroPort`, so calling it then only produces noise.
   */
  reattach: { metroPort: number; appScheme: string | null } | null;
}): Promise<{
  label: string;
  reattachedPort: number | null;
  /**
   * Reported separately from a thrown error: the app really did restart, so
   * surfacing a re-attach failure as "restart failed" would be a lie.
   */
  reattachError: unknown | null;
}> {
  let label: string;
  if (device.platform === 'ios') {
    const result = await api.restartIosApp({
      projectId,
      taskId,
      appPath,
      deviceId: device.id,
    });
    label = result.bundleId;
  } else {
    const result = await api.restartAndroidApp({
      projectId,
      taskId,
      androidProjectPath,
      deviceId: device.id,
    });
    label = result.packageName;
  }

  if (!reattach) return { label, reattachedPort: null, reattachError: null };

  try {
    await api.launchExpo({
      requestId: createRestartLaunchRequestId(),
      taskId,
      projectId,
      appPath,
      platform: device.platform,
      deviceId: device.id,
      metroPort: reattach.metroPort,
      appScheme: reattach.appScheme,
    });
    return { label, reattachedPort: reattach.metroPort, reattachError: null };
  } catch (error) {
    return { label, reattachedPort: null, reattachError: error };
  }
}
