import { describe, expect, it } from 'vitest';

import { getMobilePreviewConfigForApp } from './utils-mobile-preview-app-selection';
import type { MobilePreviewProjectConfig } from '@shared/types';

describe('mobile preview app selection migration', () => {
  it('moves detected defaults while preserving custom commands', () => {
    const config: MobilePreviewProjectConfig = {
      mode: 'enabled',
      selectedAppPath: 'apps/old',
      detectedApps: [
        {
          path: 'apps/old',
          stacks: ['expo'],
          confidence: 'high',
          reasons: [],
          androidProjectPath: 'apps/old/android',
          detectedMetroStartCommand: 'old metro',
          detectedAndroidPrebuildCommand: 'old android prebuild',
          detectedIosPrebuildCommand: 'old ios prebuild',
          detectedAndroidBuildCommand: 'old android build',
          detectedIosBuildCommand: 'old ios build',
        },
        {
          path: 'apps/new',
          stacks: ['expo'],
          confidence: 'high',
          reasons: [],
          androidProjectPath: 'apps/new/android',
          detectedMetroStartCommand: 'new metro',
          detectedAndroidPrebuildCommand: 'new android prebuild',
          detectedIosPrebuildCommand: 'new ios prebuild',
          detectedAndroidBuildCommand: 'new android build',
          detectedIosBuildCommand: 'new ios build',
        },
      ],
      detectionUpdatedAt: null,
      packageManager: 'npm',
      androidProjectPath: 'apps/old/android',
      metroStartCommand: 'old metro',
      androidPrebuildCommand: 'custom android prebuild',
      iosPrebuildCommand: 'old ios prebuild',
      androidBuildCommand: 'old android build',
      iosBuildCommand: 'old ios build',
    };

    expect(
      getMobilePreviewConfigForApp({
        config,
        selectedAppPath: 'apps/new',
      }),
    ).toMatchObject({
      selectedAppPath: 'apps/new',
      androidProjectPath: 'apps/new/android',
      metroStartCommand: 'new metro',
      androidPrebuildCommand: 'custom android prebuild',
      iosPrebuildCommand: 'new ios prebuild',
      androidBuildCommand: 'new android build',
      iosBuildCommand: 'new ios build',
    });
  });
});
