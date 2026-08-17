import { describe, expect, it, vi } from 'vitest';

import {
  getMobilePreviewWorkspaceSelectionUpdate,
  handleMobilePreviewWorkspaceEscape,
} from './utils-mobile-preview-workspace';

describe('mobile preview workspace policy', () => {
  it('consumes Escape after closing even when preview input would handle it', () => {
    const close = vi.fn();
    const sendDeviceEscape = vi.fn();

    const handled = handleMobilePreviewWorkspaceEscape(close);
    if (!handled) sendDeviceEscape();

    expect(close).toHaveBeenCalledOnce();
    expect(handled).toBe(true);
    expect(sendDeviceEscape).not.toHaveBeenCalled();
  });

  it('does not replace an unmatched persisted runtime before command hydration', () => {
    expect(
      getMobilePreviewWorkspaceSelectionUpdate({
        isMetadataReady: true,
        areRunCommandStatusesHydrated: false,
        selectedRuntimeKey: 'persisted-runtime',
        resolvedRuntimeKey: 'fallback-runtime',
      }),
    ).toBeUndefined();
  });

  it('applies fallback after command hydration and keeps explicit valid selection', () => {
    expect(
      getMobilePreviewWorkspaceSelectionUpdate({
        isMetadataReady: true,
        areRunCommandStatusesHydrated: true,
        selectedRuntimeKey: 'persisted-runtime',
        resolvedRuntimeKey: 'fallback-runtime',
      }),
    ).toBe('fallback-runtime');
    expect(
      getMobilePreviewWorkspaceSelectionUpdate({
        isMetadataReady: true,
        areRunCommandStatusesHydrated: false,
        selectedRuntimeKey: 'explicit-runtime',
        resolvedRuntimeKey: 'explicit-runtime',
      }),
    ).toBeUndefined();
  });
});
