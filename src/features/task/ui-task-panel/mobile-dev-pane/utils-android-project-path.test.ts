import { describe, expect, it } from 'vitest';

import type { MobilePreviewProjectConfig } from '@shared/types';

import { resolveAndroidProjectPath } from './utils-android-project-path';

function makeConfig(
  overrides: Partial<MobilePreviewProjectConfig>,
): MobilePreviewProjectConfig {
  return overrides as MobilePreviewProjectConfig;
}

describe('resolveAndroidProjectPath', () => {
  it('prefers the explicit project setting', () => {
    expect(
      resolveAndroidProjectPath({
        config: makeConfig({
          androidProjectPath: 'custom/android',
          detectedApps: [
            { path: 'apps/mobile', androidProjectPath: 'apps/mobile/android' },
          ] as MobilePreviewProjectConfig['detectedApps'],
        }),
        appPath: 'apps/mobile',
      }),
    ).toBe('custom/android');
  });

  it('falls back to the detected app path', () => {
    expect(
      resolveAndroidProjectPath({
        config: makeConfig({
          detectedApps: [
            { path: 'apps/mobile', androidProjectPath: 'apps/mobile/android' },
          ] as MobilePreviewProjectConfig['detectedApps'],
        }),
        appPath: 'apps/mobile',
      }),
    ).toBe('apps/mobile/android');
  });

  it('infers the conventional layout for a monorepo app', () => {
    expect(
      resolveAndroidProjectPath({
        config: makeConfig({ detectedApps: [] }),
        appPath: 'apps/mobile',
      }),
    ).toBe('apps/mobile/android');
  });

  it('infers the conventional layout at the repo root', () => {
    expect(
      resolveAndroidProjectPath({ config: null, appPath: '.' }),
    ).toBe('android');
  });

  it('ignores a detected app whose path does not match', () => {
    expect(
      resolveAndroidProjectPath({
        config: makeConfig({
          detectedApps: [
            { path: 'apps/other', androidProjectPath: 'apps/other/android' },
          ] as MobilePreviewProjectConfig['detectedApps'],
        }),
        appPath: 'apps/mobile',
      }),
    ).toBe('apps/mobile/android');
  });
});
