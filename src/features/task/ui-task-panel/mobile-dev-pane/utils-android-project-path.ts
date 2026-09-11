import type { MobilePreviewProjectConfig } from '@shared/types';

import { getDefaultAndroidProjectPath } from '../mobile-preview-pane/utils-device-setup';

/**
 * Resolves the native Android project directory used to restart the app.
 *
 * The preview pane refines this with a filesystem probe (`androidProjectExists`)
 * before deciding whether to offer the action at all. This pane deliberately
 * skips the probe -- it has no setup flow to gate -- and instead falls back to
 * the conventional layout, surfacing the backend's error if the guess is wrong.
 */
export function resolveAndroidProjectPath({
  config,
  appPath,
}: {
  config: MobilePreviewProjectConfig | null | undefined;
  appPath: string;
}): string {
  const configured = config?.androidProjectPath;
  if (configured) return configured;

  const detected = getDefaultAndroidProjectPath({
    appPath,
    detectedApps: config?.detectedApps ?? [],
  });
  if (detected) return detected;

  return appPath === '.' ? 'android' : `${appPath}/android`;
}
