import type { LayerName } from '@/common/context/keyboard-bindings';

/**
 * The mobile preview now lives in the main content area next to the feed, so
 * it must NOT swallow app-wide bindings (feed navigation, palette, …). It only
 * needs its own layer so Escape resolves here first.
 */
export const MOBILE_PREVIEW_WORKSPACE_KEYBOARD_LAYER_OPTIONS: {
  exclusive: false;
  passthrough: LayerName[];
} = {
  exclusive: false,
  passthrough: ['global-nav'],
};

export function handleMobilePreviewWorkspaceEscape(close: () => void) {
  close();
  return true;
}

export function getMobilePreviewWorkspaceSelectionUpdate({
  isMetadataReady,
  areRunCommandStatusesHydrated,
  selectedRuntimeKey,
  resolvedRuntimeKey,
}: {
  isMetadataReady: boolean;
  areRunCommandStatusesHydrated: boolean;
  selectedRuntimeKey: string | null;
  resolvedRuntimeKey: string | null;
}): string | null | undefined {
  if (!isMetadataReady || resolvedRuntimeKey === selectedRuntimeKey) {
    return undefined;
  }
  if (!areRunCommandStatusesHydrated) return undefined;
  return resolvedRuntimeKey;
}
