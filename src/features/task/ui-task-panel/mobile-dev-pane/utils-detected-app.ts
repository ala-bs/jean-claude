import type { MobilePreviewProjectConfig } from '@shared/types';

/**
 * Resolves the Expo-relevant facts about the app the pane targets.
 *
 * Deliberately matches on `appPath` exactly, with no "first detected app"
 * fallback: `appPath` already came from `resolveMobileDevAppPath`, so a miss
 * means the pane is pointed at something that was never detected. Inheriting
 * another app's `stacks` there would fire an Expo deeplink at a bare React
 * Native app. Mirrors the preview pane's rule (`?? null`).
 */
export function resolveMobileDevDetectedApp({
  config,
  appPath,
}: {
  config: MobilePreviewProjectConfig | null | undefined;
  appPath: string;
}): { isExpoApp: boolean; appScheme: string | null } {
  const detectedApps = config?.detectedApps ?? [];
  const detectedApp = detectedApps.find((app) => app.path === appPath) ?? null;
  return {
    isExpoApp: detectedApp?.stacks.includes('expo') ?? false,
    // Project override first, detected app config second -- same precedence as
    // the preview pane, which is the only other caller of `launchExpo`.
    appScheme: config?.appScheme ?? detectedApp?.detectedAppScheme ?? null,
  };
}
