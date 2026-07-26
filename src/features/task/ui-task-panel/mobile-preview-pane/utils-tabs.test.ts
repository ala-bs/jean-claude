import { describe, expect, it } from 'vitest';

import {
  getVisibleMobilePreviewPaneTab,
  isMobilePreviewPaneTabVisible,
} from './utils-tabs';

describe('mobile preview tabs', () => {
  it('hides Network and falls back to Setup when network is disabled', () => {
    expect(
      isMobilePreviewPaneTabVisible({ tab: 'network', networkEnabled: false }),
    ).toBe(false);
    expect(
      getVisibleMobilePreviewPaneTab({ tab: 'network', networkEnabled: false }),
    ).toBe('setup');
  });

  it('keeps Network available when network is enabled', () => {
    expect(
      isMobilePreviewPaneTabVisible({ tab: 'network', networkEnabled: true }),
    ).toBe(true);
    expect(
      getVisibleMobilePreviewPaneTab({ tab: 'network', networkEnabled: true }),
    ).toBe('network');
  });

  it('keeps other tabs visible when network is disabled', () => {
    expect(
      getVisibleMobilePreviewPaneTab({ tab: 'dev-server', networkEnabled: false }),
    ).toBe('dev-server');
  });
});
