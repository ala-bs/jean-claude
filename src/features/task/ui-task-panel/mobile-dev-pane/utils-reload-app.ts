import type { MobilePreviewDevice } from '@shared/mobile-simulator-types';

import type { api as realApi } from '@/lib/api';

let nextReloadLaunchId = 0;

/**
 * Same uniqueness requirement as `createRestartLaunchRequestId`: `launchExpo`
 * keys in-flight work by `requestId` and clears the owner entry in its
 * `finally` when the id still matches, so a reused id lets one launch's
 * teardown cancel the next one with "request superseded".
 */
function createReloadLaunchRequestId(): string {
  nextReloadLaunchId += 1;
  return `mobile-dev-reload:${Date.now()}:${nextReloadLaunchId}`;
}

export type MobileDevReloadOutcome =
  /** The broadcast landed on at least one attached app. */
  | { status: 'reloaded' }
  /** The selected device was explicitly pointed at this Metro. */
  | { status: 'reattached'; metroPort: number }
  /** Nobody was attached and the selected setup cannot be re-pointed. */
  | { status: 'no-client' }
  /** Re-pointing the selected device failed. */
  | { status: 'reattach-failed'; error: unknown };

/**
 * Reloads the selected app on `metroPort`.
 *
 * Why the repair is needed: a dev client remembers one bundle URL, and only one
 * Metro can own the app at a time. When a second task's dev server hits a port
 * conflict it is started on a freshly allocated port (`getPortOverrides` ->
 * `getAvailablePort`), while the simulator's app is still holding the *first*
 * task's port. Metro's peer count is port-wide, so it cannot tell whether the
 * selected device is attached when another device shares this Metro instance.
 * When possible, reload therefore uses the selected device's deeplink path
 * directly; only setups that cannot be deeplinked use Metro's broadcast.
 *
 * The `exp://` deeplink is the only thing that rebinds a dev client to another
 * Metro, and loading this Metro's bundle *is* the reload -- hence no second
 * broadcast afterwards.
 *
 * Unlike the restart path there is no startup race to respect here: the app was
 * never killed, so it is either fully loaded under another Metro or not running
 * at all. That is what makes deeplinking safe to do immediately (see the
 * SIGSEGV note in `restartAppOnDevice`, which applies only to an app that is
 * still booting).
 */
export async function reloadAppOnMetro({
  api,
  metroPort,
  projectId,
  taskId,
  appPath,
  device,
  reattach,
}: {
  api: Pick<typeof realApi.mobilePreview, 'reloadExpo' | 'launchExpo'>;
  metroPort: number;
  projectId: string;
  taskId: string;
  appPath: string;
  device: Pick<MobilePreviewDevice, 'id' | 'platform'> | null;
  /**
   * `null` when the app cannot be deeplinked -- non-Expo app, no live dev
   * server, or physical iOS hardware. See `resolveRestartReattach`.
   */
  reattach: { metroPort: number; appScheme: string | null } | null;
}): Promise<MobileDevReloadOutcome> {
  // A peer count cannot identify the selected device. Broadcasting first would
  // reload whichever device is already attached and skip the newly selected
  // device whenever another app shares this Metro instance.
  if (reattach && device) {
    try {
      await api.launchExpo({
        requestId: createReloadLaunchRequestId(),
        taskId,
        projectId,
        appPath,
        platform: device.platform,
        deviceId: device.id,
        metroPort: reattach.metroPort,
        appScheme: reattach.appScheme,
      });
    } catch (error) {
      return { status: 'reattach-failed', error };
    }
    return { status: 'reattached', metroPort: reattach.metroPort };
  }

  const { connectedClients } = await api.reloadExpo({ metroPort });

  // `-1` means the count could not be established, not "nobody". Repairing on
  // an unknown would deeplink -- and so hard-reload -- a perfectly live app
  // every time the peer query happened to fail.
  if (connectedClients !== 0) return { status: 'reloaded' };
  return { status: 'no-client' };
}
