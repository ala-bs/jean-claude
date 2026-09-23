import { describe, expect, it } from 'vitest';

import type { MobilePreviewProjectConfig } from '@shared/types';

import { resolveMobileDevAppPath } from './utils-app-path';

function makeConfig(
  overrides: Partial<MobilePreviewProjectConfig>,
): MobilePreviewProjectConfig {
  return overrides as MobilePreviewProjectConfig;
}

describe('resolveMobileDevAppPath', () => {
  it('falls back to the repo root when there is no config', () => {
    expect(resolveMobileDevAppPath(null)).toBe('.');
    expect(resolveMobileDevAppPath(undefined)).toBe('.');
  });

  it('falls back to the repo root when no apps were detected', () => {
    expect(resolveMobileDevAppPath(makeConfig({ detectedApps: [] }))).toBe('.');
  });

  it('uses the selected app when it is still detected', () => {
    const config = makeConfig({
      selectedAppPath: 'apps/mobile',
      detectedApps: [
        { path: 'apps/web', stacks: [] },
        { path: 'apps/mobile', stacks: ['expo'] },
      ] as MobilePreviewProjectConfig['detectedApps'],
    });
    expect(resolveMobileDevAppPath(config)).toBe('apps/mobile');
  });

  it('ignores a stale selection that no longer matches a detected app', () => {
    const config = makeConfig({
      selectedAppPath: 'apps/deleted',
      detectedApps: [
        { path: 'apps/mobile', stacks: ['expo'] },
      ] as MobilePreviewProjectConfig['detectedApps'],
    });
    expect(resolveMobileDevAppPath(config)).toBe('apps/mobile');
  });

  it('picks the first detected app when several exist and none is selected', () => {
    // The preview pane forces the user to disambiguate here; this pane only
    // starts Metro, so it stays usable by defaulting instead.
    const config = makeConfig({
      selectedAppPath: null,
      detectedApps: [
        { path: 'apps/mobile', stacks: ['expo'] },
        { path: 'apps/other', stacks: ['expo'] },
      ] as MobilePreviewProjectConfig['detectedApps'],
    });
    expect(resolveMobileDevAppPath(config)).toBe('apps/mobile');
  });
});
