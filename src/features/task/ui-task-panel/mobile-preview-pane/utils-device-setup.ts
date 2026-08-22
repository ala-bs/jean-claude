import type {
  MobilePlatform,
  MobilePreviewAndroidDeviceProfile,
  MobilePreviewAndroidSystemImage,
  MobilePreviewDevice,
  MobilePreviewIosDeviceType,
  MobilePreviewIosRuntime,
} from '@shared/mobile-simulator-types';
import { canAutoStartMobilePreviewDevice } from '@/features/mobile-preview/utils-mobile-preview-auto-launch';
import type { MobilePreviewProjectConfig } from '@shared/types';

export function getDefaultAndroidProjectPath({
  appPath,
  detectedApps,
}: {
  appPath: string;
  detectedApps: MobilePreviewProjectConfig['detectedApps'];
}) {
  const app = detectedApps.find((detectedApp) => detectedApp.path === appPath);
  return app?.androidProjectPath ?? null;
}

export function getSuggestedAndroidSystemImageId(hostArch: string | null | undefined) {
  if (hostArch === 'arm64') {
    return 'system-images;android-35;google_apis;arm64-v8a';
  }
  if (hostArch === 'x64' || hostArch === 'ia32') {
    return 'system-images;android-35;google_apis;x86_64';
  }

  const architecture = (
    navigator as Navigator & {
      userAgentData?: { architecture?: string; platform?: string };
    }
  ).userAgentData?.architecture?.toLowerCase();
  const platform = `${navigator.platform} ${architecture ?? ''}`.toLowerCase();
  const abi = platform.includes('mac') || platform.includes('arm') || platform.includes('aarch')
    ? 'arm64-v8a'
    : 'x86_64';
  return `system-images;android-35;google_apis;${abi}`;
}

export function getPreferredAndroidSystemImage(
  images: MobilePreviewAndroidSystemImage[] | undefined,
  hostArch: string | null | undefined,
) {
  if (!images?.length) return null;
  const preferredAbi =
    hostArch === 'arm64'
      ? 'arm64-v8a'
      : hostArch === 'x64' || hostArch === 'ia32'
        ? 'x86_64'
        : null;
  return (
    images.find(
      (image) => image.tag === 'google_apis' && image.abi === preferredAbi,
    ) ??
    images.find((image) => image.tag === 'google_apis') ??
    images[0]
  );
}

export function formatAndroidScreenSpec(
  screen: MobilePreviewAndroidDeviceProfile['screen'],
) {
  if (!screen) return 'Dimensions unknown';
  const density = screen.densityDpi ? ` @ ${screen.densityDpi} dpi` : '';
  return `${screen.width} x ${screen.height}${density}`;
}

export function formatAndroidImageTag(tag: string) {
  return tag.replaceAll('_', ' ');
}

export function getSuggestedIosDeviceName({
  deviceType,
  runtime,
}: {
  deviceType: MobilePreviewIosDeviceType | null;
  runtime: MobilePreviewIosRuntime | null;
}) {
  if (!deviceType || !runtime) return '';
  return `${deviceType.name} ${runtime.name}`;
}

export function getIosDeviceChrome(deviceType: MobilePreviewIosDeviceType) {
  const name = deviceType.name.toLowerCase();
  const isMax = /max|plus/.test(name);
  const isSe = /\bse\b/.test(name);
  const hasDynamicIsland =
    /iphone\s+(1[5-9]|[2-9]\d)|air/.test(name) ||
    /iphone\s+14\s+pro/.test(name);
  const hasClassicNotch = !isSe && !hasDynamicIsland;
  const height = isMax ? 68 : /pro|air/.test(name) ? 64 : 60;
  const aspect = deviceType.screen
    ? Math.min(deviceType.screen.width, deviceType.screen.height) /
      Math.max(deviceType.screen.width, deviceType.screen.height)
    : isSe
      ? 0.56
      : isMax
        ? 0.47
        : 0.455;

  return {
    aspect,
    height,
    hasClassicNotch,
    hasDynamicIsland,
    hasHomeButton: isSe,
  };
}

export function getAndroidImageCompatibilityWarning(
  hostArch: string | null | undefined,
  abi: string | null | undefined,
) {
  if (!hostArch || !abi) return null;
  if (hostArch === 'arm64' && abi === 'x86_64') {
    return 'x86_64 images are slower on Apple Silicon.';
  }
  if ((hostArch === 'x64' || hostArch === 'ia32') && abi === 'arm64-v8a') {
    return 'arm64 images may not run on Intel hosts.';
  }
  return null;
}

export function parseOptionalPositiveInteger(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : Number.NaN;
}

export function isOptionalPositiveInteger(value: string) {
  const parsed = parseOptionalPositiveInteger(value);
  return parsed === undefined || !Number.isNaN(parsed);
}

export function getOptionalPositiveInteger(value: string) {
  const parsed = parseOptionalPositiveInteger(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function parsePort(value: string) {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535
    ? parsed
    : null;
}

/**
 * Device coordinate space for input events. Session dimensions are captured once
 * at stream start, so when the device rotates afterwards they must be re-oriented
 * to match what is actually rendered.
 */
export function resolveDeviceSize({
  surface,
  sessionWidth,
  sessionHeight,
  fallback,
}: {
  surface: { width: number; height: number } | null;
  sessionWidth: number | null;
  sessionHeight: number | null;
  fallback: { width: number; height: number };
}) {
  if (!sessionWidth || !sessionHeight) {
    return surface ?? fallback;
  }
  if (!surface || surface.width === surface.height) {
    return { width: sessionWidth, height: sessionHeight };
  }
  const sameOrientation =
    surface.width > surface.height === sessionWidth > sessionHeight;
  return sameOrientation
    ? { width: sessionWidth, height: sessionHeight }
    : { width: sessionHeight, height: sessionWidth };
}

export function formatDeviceState(state: MobilePreviewDevice['state']) {
  if (state === 'booted') return 'Booted';
  if (state === 'shutdown') return 'Shutdown';
  return 'Unknown';
}



export function canStartDevice(device: MobilePreviewDevice | undefined) {
  return canAutoStartMobilePreviewDevice(device);
}

export function getPreviewDeviceKey(platform: MobilePlatform, deviceId: string) {
  return `${platform}:${deviceId}`;
}

