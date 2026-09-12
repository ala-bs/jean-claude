import {
  isPhysicalMobilePreviewDevice,
  type MobilePreviewDevice,
} from '@shared/mobile-simulator-types';

/**
 * Decides whether a restarted app should be re-deeplinked at the live Metro
 * port, and refuses in every case where `launchExpo` is known to reject.
 *
 * Each refusal maps to a main-process guard: asking anyway would paint an
 * error notice on a restart that actually succeeded.
 */
export function resolveRestartReattach({
  isExpoApp,
  hasLiveDevServerPort,
  device,
  metroPort,
  appScheme,
}: {
  isExpoApp: boolean;
  /** The dev server is running AND its reported port is from the live run. */
  hasLiveDevServerPort: boolean;
  device: Pick<MobilePreviewDevice, 'platform' | 'kind'>;
  metroPort: number;
  appScheme: string | null;
}): { metroPort: number; appScheme: string | null } | null {
  // A bare React Native app has no `exp://` URL to deeplink.
  if (!isExpoApp) return null;
  // The launch guard requires a *running* dev-server command serving exactly
  // this port, so a stale or fallback port only produces a spurious error.
  if (!hasLiveDevServerPort) return null;
  // `exp://` deeplinking into an already-installed app is simulator-only on
  // iOS: `openDeeplink` is `xcrun simctl openurl`, which cannot address
  // CoreDevice hardware. `assertDeeplinkLaunchSupported` rejects these up
  // front, and the preview pane's auto-launch stays idle for the same reason
  // ("Do NOT re-enable this"). Build & Run is the supported path here.
  if (device.platform === 'ios' && isPhysicalMobilePreviewDevice(device)) {
    return null;
  }
  return { metroPort, appScheme };
}
