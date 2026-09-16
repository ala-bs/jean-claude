import type { MobilePreviewProjectConfig } from '@shared/types';

/**
 * Resolves which detected app the pane targets.
 *
 * Mirrors the mobile preview pane's rule, minus the "user must disambiguate"
 * gate: this pane only starts Metro, so falling back to the first detected app
 * is safe and keeps the pane usable without visiting project settings first.
 */
export function resolveMobileDevAppPath(
  config: MobilePreviewProjectConfig | null | undefined,
): string {
  const detectedApps = config?.detectedApps ?? [];
  const selectedAppPath = config?.selectedAppPath ?? null;
  const validSelectedAppPath =
    selectedAppPath && detectedApps.some((app) => app.path === selectedAppPath)
      ? selectedAppPath
      : null;
  return validSelectedAppPath ?? detectedApps[0]?.path ?? '.';
}
