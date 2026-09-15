import type { MobilePreviewDevice } from '@shared/mobile-simulator-types';

import { resolveRestartReattach } from './utils-restart-reattach';

let nextStartLaunchId = 0;

/**
 * Same uniqueness requirement as the restart/reload paths: `launchExpo` keys
 * in-flight work by `requestId`, so a reused id lets one launch's teardown
 * cancel the next with "request superseded".
 */
export function createStartLaunchRequestId(): string {
  nextStartLaunchId += 1;
  return `mobile-dev-start:${Date.now()}:${nextStartLaunchId}`;
}

export type MobileDevStartLaunchDecision =
  /** Nothing was requested; the effect must do nothing. */
  | { status: 'idle' }
  /** A start is pending but Metro has not reported a live port yet. */
  | { status: 'waiting' }
  /** The pending start can never be deeplinked; drop it silently. */
  | { status: 'skip' }
  | { status: 'launch'; metroPort: number; appScheme: string | null };

/**
 * Decides whether pressing Start should also fire the `exp://` deeplink that
 * opens the app on the selected device.
 *
 * Starting Metro alone leaves the device untouched: a dev client remembers the
 * bundle URL it last loaded, so the user had to press Restart (or Reload) right
 * after Start to actually see the new server. This makes Start do both.
 *
 * The launch is deliberately deferred rather than fired next to
 * `startAdHocCommand`: the runner may fall back to another free port, so the
 * port to deeplink is only known once the command reports `running` with its
 * real ports (`hasLiveDevServerPort`). Firing early would deeplink the
 * configured port and `launchExpo` rejects on the exact-port mismatch.
 *
 * Every refusal mirrors `resolveRestartReattach`, which encodes the cases
 * `launchExpo` rejects outright (non-Expo app, physical iOS hardware).
 */
export function resolveStartLaunchDecision({
  isPending,
  hasLiveDevServerPort,
  isLoadingDevices,
  device,
  isDeviceBooted,
  isExpoApp,
  metroPort,
  appScheme,
}: {
  isPending: boolean;
  hasLiveDevServerPort: boolean;
  /** The device list query has not resolved yet, so `device` is not yet known. */
  isLoadingDevices: boolean;
  device: Pick<MobilePreviewDevice, 'platform' | 'kind'> | null;
  isDeviceBooted: boolean;
  isExpoApp: boolean;
  metroPort: number;
  appScheme: string | null;
}): MobileDevStartLaunchDecision {
  if (!isPending) return { status: 'idle' };
  // Metro is still booting: keep the request alive until it reports a port.
  if (!hasLiveDevServerPort) return { status: 'waiting' };
  // `device` is resolved by matching the persisted selection against the device
  // list, so it is null *both* when nothing is selected and while the list is
  // still loading. Skipping on the latter would silently drop the deeplink
  // whenever Metro wins the race against `simctl list`. Same branch as the
  // preview pane's auto-launch ("Restoring device selection").
  if (isLoadingDevices) return { status: 'waiting' };
  // A shut-down simulator reaches `xcrun simctl openurl` and answers "Unable to
  // lookup in current state: Shutdown". Starting Metro is still a success, so
  // this drops the deeplink instead of turning it into an error toast.
  if (!device || !isDeviceBooted) return { status: 'skip' };
  const reattach = resolveRestartReattach({
    isExpoApp,
    hasLiveDevServerPort,
    device,
    metroPort,
    appScheme,
  });
  if (!reattach) return { status: 'skip' };
  return {
    status: 'launch',
    metroPort: reattach.metroPort,
    appScheme: reattach.appScheme,
  };
}
