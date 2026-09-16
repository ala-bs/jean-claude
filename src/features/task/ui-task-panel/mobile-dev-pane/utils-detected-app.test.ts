import { describe, expect, it } from 'vitest';

import type { MobilePreviewProjectConfig } from '@shared/types';

import { resolveMobileDevDetectedApp } from './utils-detected-app';

function makeConfig(
  overrides: Partial<MobilePreviewProjectConfig>,
): MobilePreviewProjectConfig {
  return {
    mode: 'auto',
    selectedAppPath: null,
    detectedApps: [],
    detectionUpdatedAt: null,
    ...overrides,
  } as MobilePreviewProjectConfig;
}

const EXPO_APP = {
  path: 'apps/mobile',
  stacks: ['expo' as const],
  confidence: 'high' as const,
  reasons: [],
};

const BARE_RN_APP = {
  path: 'apps/legacy',
  stacks: ['react-native' as const],
  confidence: 'high' as const,
  reasons: [],
};

describe('resolveMobileDevDetectedApp', () => {
  it('detects an Expo app at the targeted path', () => {
    const result = resolveMobileDevDetectedApp({
      config: makeConfig({ detectedApps: [EXPO_APP] }),
      appPath: 'apps/mobile',
    });

    expect(result.isExpoApp).toBe(true);
  });

  it('does not inherit stacks from another detected app', () => {
    // Falling back to detectedApps[0] here would fire an Expo deeplink at a
    // bare React Native app.
    const result = resolveMobileDevDetectedApp({
      config: makeConfig({ detectedApps: [EXPO_APP, BARE_RN_APP] }),
      appPath: 'apps/legacy',
    });

    expect(result.isExpoApp).toBe(false);
  });

  it('reports a non-Expo app for an unknown path or missing config', () => {
    expect(
      resolveMobileDevDetectedApp({
        config: makeConfig({ detectedApps: [EXPO_APP] }),
        appPath: '.',
      }).isExpoApp,
    ).toBe(false);
    expect(
      resolveMobileDevDetectedApp({ config: null, appPath: 'apps/mobile' })
        .isExpoApp,
    ).toBe(false);
  });

  it('prefers the project scheme override over the detected scheme', () => {
    const result = resolveMobileDevDetectedApp({
      config: makeConfig({
        appScheme: 'override',
        detectedApps: [{ ...EXPO_APP, detectedAppScheme: 'detected' }],
      }),
      appPath: 'apps/mobile',
    });

    expect(result.appScheme).toBe('override');
  });

  it('falls back to the detected scheme, then to null', () => {
    expect(
      resolveMobileDevDetectedApp({
        config: makeConfig({
          detectedApps: [{ ...EXPO_APP, detectedAppScheme: 'detected' }],
        }),
        appPath: 'apps/mobile',
      }).appScheme,
    ).toBe('detected');
    expect(
      resolveMobileDevDetectedApp({
        config: makeConfig({ detectedApps: [EXPO_APP] }),
        appPath: 'apps/mobile',
      }).appScheme,
    ).toBeNull();
  });
});
