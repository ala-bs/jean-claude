import { describe, expect, it } from 'vitest';

import type { MobilePreviewDevice } from '@shared/mobile-simulator-types';
import type { MobilePreviewProjectConfig } from '@shared/types';

import { resolveMobileDevBuildCommand } from './utils-build-command';

const iosSimulator: MobilePreviewDevice = {
  id: 'ABC-123',
  name: 'iPhone 15',
  platform: 'ios',
  state: 'booted',
};

const config = (
  overrides: Partial<MobilePreviewProjectConfig>,
): MobilePreviewProjectConfig =>
  ({
    mode: 'auto',
    selectedAppPath: '.',
    detectedApps: [],
    detectionUpdatedAt: null,
    ...overrides,
  }) as MobilePreviewProjectConfig;

describe('resolveMobileDevBuildCommand', () => {
  it('reports no command id and a reason when no device is selected', () => {
    const result = resolveMobileDevBuildCommand({
      config: config({ iosBuildCommand: 'npx expo run:ios' }),
      appPath: '.',
      device: null,
    });
    expect(result.commandId).toBeNull();
    expect(result.command).toBeNull();
    expect(result.unavailableReason).toMatch(/Select a device/);
  });

  it('targets the selected device and scopes the command id to it', () => {
    const result = resolveMobileDevBuildCommand({
      config: config({ iosBuildCommand: 'npx expo run:ios' }),
      appPath: '.',
      device: iosSimulator,
    });
    expect(result.command).toBe('npx expo run:ios --device ABC-123');
    expect(result.unavailableReason).toBeNull();
    expect(result.commandId).toContain(encodeURIComponent('ABC-123'));
    expect(result.commandId).toContain(':ios:');
  });

  it('picks the command matching the device platform', () => {
    const result = resolveMobileDevBuildCommand({
      config: config({
        iosBuildCommand: 'npx expo run:ios',
        androidBuildCommand: 'npx expo run:android',
      }),
      appPath: '.',
      device: {
        id: 'Pixel_7',
        name: 'Pixel 7',
        platform: 'android',
        state: 'shutdown',
      },
    });
    expect(result.command).toBe('npx expo run:android --device Pixel_7');
  });

  it('falls back to the detected build command when none is configured', () => {
    const result = resolveMobileDevBuildCommand({
      config: config({
        detectedApps: [
          {
            path: 'apps/mobile',
            stacks: ['expo'],
            detectedIosBuildCommand: 'pnpm run ios',
            confidence: 'high',
            reasons: [],
          },
        ],
      }),
      appPath: 'apps/mobile',
      device: iosSimulator,
    });
    // Script wrapper: the flag comes from the detected stacks.
    expect(result.command).toBe('pnpm run ios --device ABC-123');
  });

  it('ignores a whitespace-only override and still uses the detected command', () => {
    const result = resolveMobileDevBuildCommand({
      config: config({
        iosBuildCommand: '   ',
        detectedApps: [
          {
            path: '.',
            stacks: ['expo'],
            detectedIosBuildCommand: 'npx expo run:ios',
            confidence: 'high',
            reasons: [],
          },
        ],
      }),
      appPath: '.',
      device: iosSimulator,
    });
    expect(result.command).toBe('npx expo run:ios --device ABC-123');
    expect(result.unavailableReason).toBeNull();
  });

  it('explains when no build command exists for the platform', () => {
    const result = resolveMobileDevBuildCommand({
      config: config({ androidBuildCommand: 'npx expo run:android' }),
      appPath: '.',
      device: iosSimulator,
    });
    expect(result.command).toBeNull();
    expect(result.unavailableReason).toMatch(/iOS build command/);
    expect(result.commandId).not.toBeNull();
  });
});
