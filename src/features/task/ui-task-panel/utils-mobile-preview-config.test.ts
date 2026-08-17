import { describe, expect, it } from 'vitest';

import {
  migrateBuildCommand,
  migrateDetectedCommand,
  migrateIosBundleId,
} from './utils-mobile-preview-config';

describe('migrateDetectedCommand', () => {
  it('replaces the current detected iOS prebuild command for a newly selected app', () => {
    expect(
      migrateDetectedCommand({
        currentCommand: 'pnpm prebuild:ios',
        currentDetectedCommand: 'pnpm prebuild:ios',
        selectedDetectedCommand: 'pnpm ios:generate',
      }),
    ).toBe('pnpm ios:generate');
  });

  it('preserves a custom iOS prebuild command when selecting another app', () => {
    expect(
      migrateDetectedCommand({
        currentCommand: 'pnpm custom:ios',
        currentDetectedCommand: 'pnpm prebuild:ios',
        selectedDetectedCommand: 'pnpm ios:generate',
      }),
    ).toBe('pnpm custom:ios');
  });
});

describe('migrateBuildCommand', () => {
  it.each([
    [
      'android',
      'pnpm exec expo run:android',
      'pnpm android',
      'pnpm exec react-native run-android',
    ],
    [
      'ios',
      'pnpm exec expo run:ios',
      'pnpm ios',
      'pnpm exec react-native run-ios',
    ],
  ])(
    'replaces generated %s build command when selecting another app',
    (_platform, currentCommand, selectedGeneratedCommand, otherGeneratedCommand) => {
      expect(
        migrateBuildCommand({
          currentCommand,
          currentGeneratedCommands: [otherGeneratedCommand, currentCommand],
          selectedGeneratedCommand,
        }),
      ).toBe(selectedGeneratedCommand);
    },
  );

  it.each([
    ['ios', 'npm run ios'],
    ['android', 'npm run android'],
  ] as const)(
    'migrates legacy null-manager %s command using npm default',
    (platform, currentCommand) => {
      expect(
        migrateBuildCommand({
          currentCommand,
          currentGeneratedCommands: [],
          selectedGeneratedCommand: `next ${platform}`,
          legacyPackageManager: null,
          platform,
        }),
      ).toBe(`next ${platform}`);
    },
  );

  it('preserves a non-conventional null-manager custom command', () => {
    expect(
      migrateBuildCommand({
        currentCommand: 'npm run build:ios',
        currentGeneratedCommands: [],
        selectedGeneratedCommand: 'npm run ios',
        legacyPackageManager: null,
        platform: 'ios',
      }),
    ).toBe('npm run build:ios');
  });

  it.each([
    ['pnpm', 'ios', 'pnpm ios'],
    ['pnpm', 'android', 'pnpm android'],
    ['npm', 'ios', 'npm run ios'],
    ['npm', 'android', 'npm run android'],
    ['yarn', 'ios', 'yarn ios'],
    ['yarn', 'android', 'yarn android'],
    ['bun', 'ios', 'bun run ios'],
    ['bun', 'android', 'bun run android'],
  ] as const)(
    'migrates legacy %s %s script command without detected build metadata',
    (packageManager, platform, currentCommand) => {
      expect(
        migrateBuildCommand({
          currentCommand,
          currentGeneratedCommands: [],
          selectedGeneratedCommand: `next ${platform}`,
          legacyPackageManager: packageManager,
          platform,
        }),
      ).toBe(`next ${platform}`);
    },
  );

  it('preserves a non-conventional legacy custom command', () => {
    expect(
      migrateBuildCommand({
        currentCommand: 'pnpm build:ios',
        currentGeneratedCommands: [],
        selectedGeneratedCommand: 'pnpm ios',
        legacyPackageManager: 'pnpm',
        platform: 'ios',
      }),
    ).toBe('pnpm build:ios');
  });

  it.each(['android', 'ios'])(
    'preserves custom %s build command when selecting another app',
    (platform) => {
      expect(
        migrateBuildCommand({
          currentCommand: `pnpm custom:${platform}`,
          currentGeneratedCommands: [`pnpm exec expo run:${platform}`],
          selectedGeneratedCommand: `pnpm ${platform}`,
        }),
      ).toBe(`pnpm custom:${platform}`);
    },
  );
});

describe('migrateIosBundleId', () => {
  it('clears an app-scoped override when selected app changes', () => {
    expect(
      migrateIosBundleId({
        currentSelectedAppPath: 'apps/a',
        selectedAppPath: 'apps/b',
        iosBundleId: 'com.example.a',
      }),
    ).toBeNull();
  });

  it('preserves an app-scoped override when selected app is unchanged', () => {
    expect(
      migrateIosBundleId({
        currentSelectedAppPath: 'apps/a',
        selectedAppPath: 'apps/a',
        iosBundleId: 'com.example.a',
      }),
    ).toBe('com.example.a');
  });
});
