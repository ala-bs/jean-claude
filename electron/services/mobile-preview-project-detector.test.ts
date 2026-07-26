import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectMobilePreviewProjectConfig } from './mobile-preview-project-detector';

let tempDir = '';

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value), 'utf8');
}

beforeEach(async () => {
  const tempRoot = os.tmpdir();
  await fs.mkdir(tempRoot, { recursive: true });
  tempDir = await fs.mkdtemp(path.join(tempRoot, 'jc-mobile-detect-'));
});

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

describe('detectMobilePreviewProjectConfig', () => {
  it('detects an Expo app at the project root', async () => {
    await writeJson(path.join(tempDir, 'package.json'), {
      dependencies: { expo: '^52.0.0', 'react-native': '^0.76.0' },
    });
    await writeJson(path.join(tempDir, 'app.json'), { expo: {} });

    const config = await detectMobilePreviewProjectConfig(tempDir);

    expect(config.mode).toBe('auto');
    expect(config.selectedAppPath).toBe('.');
    expect(config.detectedApps).toEqual([
      expect.objectContaining({
        path: '.',
        stacks: ['expo', 'react-native'],
        confidence: 'high',
      }),
    ]);
  });

  it('detects Android package and iOS bundle IDs from app config and native files', async () => {
    await writeJson(path.join(tempDir, 'package.json'), {
      dependencies: { expo: '^52.0.0' },
    });
    await writeJson(path.join(tempDir, 'app.json'), {
      expo: {
        android: { package: 'com.example.config' },
        ios: { bundleIdentifier: 'com.example.config' },
      },
    });
    await fs.mkdir(path.join(tempDir, 'android/app'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'android/app/build.gradle'),
      'android { defaultConfig { applicationId "com.example.android" } }',
    );
    await fs.mkdir(path.join(tempDir, 'ios/App.xcodeproj'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'ios/App.xcodeproj/project.pbxproj'),
      'PRODUCT_BUNDLE_IDENTIFIER = com.example.ios;',
    );

    const config = await detectMobilePreviewProjectConfig(tempDir);

    expect(config).toMatchObject({
      androidPackageName: 'com.example.android',
      iosBundleId: 'com.example.ios',
      detectedApps: [
        expect.objectContaining({
          detectedAndroidPackageName: 'com.example.android',
          detectedIosBundleId: 'com.example.ios',
        }),
      ],
    });
  });

  it('does not persist unresolved iOS build-variable bundle IDs', async () => {
    await writeJson(path.join(tempDir, 'package.json'), {
      dependencies: { 'react-native': '^0.76.0' },
    });
    await fs.mkdir(path.join(tempDir, 'ios/App.xcodeproj'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'ios/App.xcodeproj/project.pbxproj'),
      'PRODUCT_BUNDLE_IDENTIFIER = org.reactjs.native.example.$(PRODUCT_NAME:rfc1034identifier);',
    );

    const config = await detectMobilePreviewProjectConfig(tempDir);

    expect(config.iosBundleId).toBeNull();
    expect(config.detectedApps[0]?.detectedIosBundleId).toBeNull();
  });

  it('detects Metro and Android prebuild commands from package scripts first', async () => {
    await fs.writeFile(path.join(tempDir, 'pnpm-lock.yaml'), '');
    await writeJson(path.join(tempDir, 'package.json'), {
      dependencies: { expo: '^52.0.0', 'react-native': '^0.76.0' },
      scripts: {
        start: 'expo start --dev-client',
        prebuild: 'expo prebuild --platform android',
      },
    });
    await writeJson(path.join(tempDir, 'app.json'), { expo: {} });

    const config = await detectMobilePreviewProjectConfig(tempDir);

    expect(config.metroStartCommand).toBe('pnpm start');
    expect(config.dependenciesInstallCommand).toBe('pnpm install');
    expect(config.androidPrebuildCommand).toBe('pnpm prebuild');
  });

  it('updates package manager when lockfiles change between scans', async () => {
    await fs.writeFile(path.join(tempDir, 'pnpm-lock.yaml'), '');
    await writeJson(path.join(tempDir, 'package.json'), {
      dependencies: { expo: '^52.0.0' },
      scripts: {
        start: 'expo start',
        'prebuild:android': 'expo prebuild --platform android',
        'prebuild:ios': 'expo prebuild --platform ios',
      },
    });
    await writeJson(path.join(tempDir, 'app.json'), { expo: {} });
    const previous = await detectMobilePreviewProjectConfig(tempDir);
    expect(previous.packageManager).toBe('pnpm');

    await fs.rm(path.join(tempDir, 'pnpm-lock.yaml'));
    await writeJson(path.join(tempDir, 'package-lock.json'), {});
    const rescanned = await detectMobilePreviewProjectConfig(tempDir, {
      ...previous,
      detectedApps: [],
    });

    expect(rescanned).toMatchObject({
      packageManager: 'npm',
      dependenciesInstallCommand: 'npm install',
      metroStartCommand: 'npm run start',
      androidPrebuildCommand: 'npm run prebuild:android',
      iosPrebuildCommand: 'npm run prebuild:ios',
      androidBuildCommand: 'npx expo run:android',
      iosBuildCommand: 'npx expo run:ios',
    });
  });

  it('clears package manager and updates all generated commands when lockfiles are removed', async () => {
    await fs.writeFile(path.join(tempDir, 'pnpm-lock.yaml'), '');
    await writeJson(path.join(tempDir, 'package.json'), {
      dependencies: { expo: '^52.0.0' },
      scripts: {
        start: 'expo start --dev-client',
        'prebuild:android': 'expo prebuild --platform android',
        'prebuild:ios': 'expo prebuild --platform ios',
      },
    });
    await writeJson(path.join(tempDir, 'app.json'), { expo: {} });
    const previous = await detectMobilePreviewProjectConfig(tempDir);
    expect(previous).toMatchObject({
      packageManager: 'pnpm',
      metroStartCommand: 'pnpm start',
      androidPrebuildCommand: 'pnpm prebuild:android',
      iosPrebuildCommand: 'pnpm prebuild:ios',
      androidBuildCommand: 'pnpm exec expo run:android',
      iosBuildCommand: 'pnpm exec expo run:ios',
    });

    await fs.rm(path.join(tempDir, 'pnpm-lock.yaml'));
    const rescanned = await detectMobilePreviewProjectConfig(tempDir, previous);

    expect(rescanned).toMatchObject({
      packageManager: null,
      dependenciesInstallCommand: 'npm install',
      metroStartCommand: 'npm run start',
      androidPrebuildCommand: 'npm run prebuild:android',
      iosPrebuildCommand: 'npm run prebuild:ios',
      androidBuildCommand: 'npx expo run:android',
      iosBuildCommand: 'npx expo run:ios',
    });
  });

  it('updates generated commands for a new package manager but preserves custom commands', async () => {
    await fs.writeFile(path.join(tempDir, 'pnpm-lock.yaml'), '');
    await writeJson(path.join(tempDir, 'package.json'), {
      dependencies: { expo: '^52.0.0' },
      scripts: {
        start: 'expo start',
        'prebuild:android': 'expo prebuild --platform android',
        'prebuild:ios': 'expo prebuild --platform ios',
      },
    });
    await writeJson(path.join(tempDir, 'app.json'), { expo: {} });
    const detected = await detectMobilePreviewProjectConfig(tempDir);
    const previous = {
      ...detected,
      metroStartCommand: 'custom metro',
      androidPrebuildCommand: 'custom android prebuild',
      iosPrebuildCommand: 'custom ios prebuild',
      androidBuildCommand: 'custom android build',
      iosBuildCommand: 'custom ios build',
    };

    await fs.rm(path.join(tempDir, 'pnpm-lock.yaml'));
    await writeJson(path.join(tempDir, 'package-lock.json'), {});
    const rescanned = await detectMobilePreviewProjectConfig(tempDir, previous);

    expect(rescanned).toMatchObject({
      packageManager: 'npm',
      metroStartCommand: 'custom metro',
      androidPrebuildCommand: 'custom android prebuild',
      iosPrebuildCommand: 'custom ios prebuild',
      androidBuildCommand: 'custom android build',
      iosBuildCommand: 'custom ios build',
    });
  });

  it('detects nonstandard script names by command content', async () => {
    await writeJson(path.join(tempDir, 'package.json'), {
      dependencies: { expo: '^52.0.0' },
      scripts: {
        mobile: 'expo start --clear',
        'android:generate': 'expo prebuild --platform android --clean',
      },
    });
    await writeJson(path.join(tempDir, 'app.json'), { expo: {} });

    const config = await detectMobilePreviewProjectConfig(tempDir);

    expect(config.metroStartCommand).toBe('npm run mobile');
    expect(config.androidPrebuildCommand).toBe('npm run android:generate');
  });

  it('uses conventional bun run syntax for platform build scripts', async () => {
    await fs.writeFile(path.join(tempDir, 'bun.lockb'), '');
    await writeJson(path.join(tempDir, 'package.json'), {
      dependencies: { expo: '^52.0.0' },
      scripts: { ios: 'expo run:ios', android: 'expo run:android' },
    });

    const config = await detectMobilePreviewProjectConfig(tempDir);

    expect(config.iosBuildCommand).toBe('bun run ios');
    expect(config.androidBuildCommand).toBe('bun run android');
  });

  it('does not use an iOS-only prebuild script for Android prebuild', async () => {
    await writeJson(path.join(tempDir, 'package.json'), {
      dependencies: { expo: '^52.0.0' },
      scripts: {
        prebuild: 'expo prebuild --platform ios',
        'prebuild:android': 'expo prebuild --platform android',
      },
    });
    await writeJson(path.join(tempDir, 'app.json'), { expo: {} });

    const config = await detectMobilePreviewProjectConfig(tempDir);

    expect(config.androidPrebuildCommand).toBe('npm run prebuild:android');
  });

  it('rejects opposite-platform prebuild script names without platform flags', async () => {
    await writeJson(path.join(tempDir, 'package.json'), {
      dependencies: { expo: '^52.0.0' },
      scripts: {
        'ios:generate': 'expo prebuild',
      },
    });
    await writeJson(path.join(tempDir, 'app.json'), { expo: {} });

    const iosOnlyConfig = await detectMobilePreviewProjectConfig(tempDir);

    expect(iosOnlyConfig.androidPrebuildCommand).toBeNull();

    await writeJson(path.join(tempDir, 'package.json'), {
      dependencies: { expo: '^52.0.0' },
      scripts: {
        'android:generate': 'expo prebuild',
      },
    });

    const androidOnlyConfig = await detectMobilePreviewProjectConfig(tempDir);

    expect(androidOnlyConfig.iosPrebuildCommand).toBeNull();
  });

  it('prefers Android-specific prebuild scripts over generic prebuild scripts', async () => {
    await writeJson(path.join(tempDir, 'package.json'), {
      dependencies: { expo: '^52.0.0' },
      scripts: {
        prebuild: 'expo prebuild',
        'android:generate': 'expo prebuild --platform android',
      },
    });
    await writeJson(path.join(tempDir, 'app.json'), { expo: {} });

    const config = await detectMobilePreviewProjectConfig(tempDir);

    expect(config.androidPrebuildCommand).toBe('npm run android:generate');
  });

  it('prefers iOS-specific prebuild scripts over generic prebuild scripts', async () => {
    await writeJson(path.join(tempDir, 'package.json'), {
      dependencies: { expo: '^52.0.0' },
      scripts: {
        prebuild: 'expo prebuild',
        'ios:generate': 'expo prebuild --platform ios',
      },
    });
    await writeJson(path.join(tempDir, 'app.json'), { expo: {} });

    const config = await detectMobilePreviewProjectConfig(tempDir);

    expect(config.iosPrebuildCommand).toBe('npm run ios:generate');
    expect(config.detectedApps[0].detectedIosPrebuildCommand).toBe(
      'npm run ios:generate',
    );
  });

  it('does not use an Android-only prebuild script for iOS prebuild', async () => {
    await writeJson(path.join(tempDir, 'package.json'), {
      dependencies: { expo: '^52.0.0' },
      scripts: {
        prebuild: 'expo prebuild --platform android',
      },
    });
    await writeJson(path.join(tempDir, 'app.json'), { expo: {} });

    const config = await detectMobilePreviewProjectConfig(tempDir);

    expect(config.iosPrebuildCommand).toBeNull();
  });

  it('uses a generic Expo prebuild script for iOS prebuild', async () => {
    await fs.writeFile(path.join(tempDir, 'pnpm-lock.yaml'), '');
    await writeJson(path.join(tempDir, 'package.json'), {
      dependencies: { expo: '^52.0.0' },
      scripts: {
        prebuild: 'expo prebuild',
      },
    });
    await writeJson(path.join(tempDir, 'app.json'), { expo: {} });

    const config = await detectMobilePreviewProjectConfig(tempDir);

    expect(config.iosPrebuildCommand).toBe('pnpm prebuild');
  });

  it('detects mobile apps in shallow monorepo folders', async () => {
    await writeJson(path.join(tempDir, 'apps/mobile/package.json'), {
      dependencies: { expo: '^52.0.0' },
    });
    await fs.mkdir(path.join(tempDir, 'apps/mobile/ios'), {
      recursive: true,
    });
    await fs.mkdir(path.join(tempDir, 'apps/mobile/android'), {
      recursive: true,
    });

    const config = await detectMobilePreviewProjectConfig(tempDir);

    expect(config.selectedAppPath).toBe('apps/mobile');
    expect(config.androidProjectPath).toBe('apps/mobile/android');
    expect(config.detectedApps[0]).toEqual(
      expect.objectContaining({
        path: 'apps/mobile',
        stacks: ['expo', 'ios', 'android'],
        androidProjectPath: 'apps/mobile/android',
      }),
    );
  });

  it('excludes native-only Xcode apps from runnable detection', async () => {
    await fs.mkdir(path.join(tempDir, 'apps/native-ios/ios'), {
      recursive: true,
    });

    const config = await detectMobilePreviewProjectConfig(tempDir, {
      mode: 'enabled',
      selectedAppPath: 'apps/native-ios',
      detectedApps: [],
      detectionUpdatedAt: null,
    });

    expect(config.detectedApps).toEqual([]);
    expect(config.selectedAppPath).toBeNull();
  });

  it.each([
    ['expo', { expo: '^52.0.0' }],
    ['react-native', { 'react-native': '^0.76.0' }],
  ])('preserves %s apps that also contain an iOS project', async (_stack, dependencies) => {
    await writeJson(path.join(tempDir, 'apps/mobile/package.json'), {
      dependencies,
    });
    await fs.mkdir(path.join(tempDir, 'apps/mobile/ios'), { recursive: true });

    const config = await detectMobilePreviewProjectConfig(tempDir);

    expect(config.detectedApps).toHaveLength(1);
    expect(config.detectedApps[0].stacks).toContain('ios');
    expect(config.selectedAppPath).toBe('apps/mobile');
  });

  it('keeps native-only Android apps detectable', async () => {
    await fs.mkdir(path.join(tempDir, 'apps/native-android/android'), {
      recursive: true,
    });

    const config = await detectMobilePreviewProjectConfig(tempDir);

    expect(config.detectedApps).toEqual([
      expect.objectContaining({
        path: 'apps/native-android',
        stacks: ['android'],
      }),
    ]);
  });

  it('asks for app by leaving selection empty when multiple apps match', async () => {
    await writeJson(path.join(tempDir, 'apps/customer/package.json'), {
      dependencies: { expo: '^52.0.0' },
    });
    await writeJson(path.join(tempDir, 'apps/admin/package.json'), {
      dependencies: { 'react-native': '^0.76.0' },
    });

    const config = await detectMobilePreviewProjectConfig(tempDir);

    expect(config.selectedAppPath).toBeNull();
    expect(config.detectedApps.map((app) => app.path).sort()).toEqual([
      'apps/admin',
      'apps/customer',
    ]);
  });

  it('keeps detected commands on each app when multiple apps match', async () => {
    await fs.writeFile(path.join(tempDir, 'pnpm-lock.yaml'), '');
    await writeJson(path.join(tempDir, 'apps/customer/package.json'), {
      dependencies: { expo: '^52.0.0' },
      scripts: {
        start: 'expo start --dev-client',
        'prebuild:android': 'expo prebuild --platform android',
      },
    });
    await writeJson(path.join(tempDir, 'apps/admin/package.json'), {
      dependencies: { expo: '^52.0.0' },
      scripts: {
        mobile: 'expo start --clear',
        generate: 'expo prebuild --platform android',
      },
    });

    const config = await detectMobilePreviewProjectConfig(tempDir);

    expect(config.selectedAppPath).toBeNull();
    expect(config.metroStartCommand).toBeNull();
    expect(config.androidPrebuildCommand).toBeNull();
    expect(config.detectedApps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'apps/customer',
          detectedMetroStartCommand: 'pnpm start',
          detectedAndroidPrebuildCommand: 'pnpm prebuild:android',
        }),
        expect.objectContaining({
          path: 'apps/admin',
          detectedMetroStartCommand: 'pnpm mobile',
          detectedAndroidPrebuildCommand: 'pnpm generate',
        }),
      ]),
    );
  });

  it('selects the runnable app when a shared package has react-native dev dependency', async () => {
    await writeJson(path.join(tempDir, 'packages/app/package.json'), {
      dependencies: { expo: '^52.0.0' },
    });
    await writeJson(path.join(tempDir, 'packages/app/app.json'), { expo: {} });
    await writeJson(path.join(tempDir, 'packages/core/package.json'), {
      devDependencies: { 'react-native': '^0.76.0' },
    });

    const config = await detectMobilePreviewProjectConfig(tempDir);

    expect(config.selectedAppPath).toBe('packages/app');
    expect(config.detectedApps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'packages/core',
          reasons: ['react-native dev dependency'],
        }),
      ]),
    );
  });

  it('detects react-native optional dependency packages', async () => {
    await writeJson(path.join(tempDir, 'packages/core/package.json'), {
      optionalDependencies: { 'react-native': '^0.76.0' },
    });

    const config = await detectMobilePreviewProjectConfig(tempDir);

    expect(config.selectedAppPath).toBe('packages/core');
    expect(config.detectedApps[0]).toEqual(
      expect.objectContaining({
        path: 'packages/core',
        reasons: ['react-native optional dependency'],
      }),
    );
  });

  it('preserves enabled mode and selected app after manual rescan', async () => {
    await writeJson(path.join(tempDir, 'apps/mobile/package.json'), {
      dependencies: { expo: '^52.0.0' },
    });

    const config = await detectMobilePreviewProjectConfig(tempDir, {
      mode: 'enabled',
      selectedAppPath: 'apps/mobile',
      androidProjectPath: 'native/android',
      iosPrebuildCommand: 'pnpm generate:ios',
      iosBundleId: 'com.example.mobile',
      detectedApps: [],
      detectionUpdatedAt: null,
    });

    expect(config.mode).toBe('enabled');
    expect(config.selectedAppPath).toBe('apps/mobile');
    expect(config.androidProjectPath).toBe('native/android');
    expect(config.iosPrebuildCommand).toBe('pnpm generate:ios');
    expect(config.iosBundleId).toBe('com.example.mobile');
  });

  it('clears bundle id and migrates defaults when rescan replaces the selected app', async () => {
    await writeJson(path.join(tempDir, 'apps/a/package.json'), {
      dependencies: { expo: '^52.0.0' },
      scripts: {
        start: 'expo start',
        'prebuild:android': 'expo prebuild --platform android',
        'prebuild:ios': 'expo prebuild --platform ios',
      },
    });
    await writeJson(path.join(tempDir, 'apps/a/app.json'), { expo: {} });
    const previous = await detectMobilePreviewProjectConfig(tempDir);
    previous.iosBundleId = 'com.example.a';

    await fs.rm(path.join(tempDir, 'apps/a'), { recursive: true });
    await writeJson(path.join(tempDir, 'apps/b/package.json'), {
      dependencies: { expo: '^52.0.0' },
      scripts: {
        mobile: 'expo start',
        'android:generate': 'expo prebuild --platform android',
        'ios:generate': 'expo prebuild --platform ios',
      },
    });
    await writeJson(path.join(tempDir, 'apps/b/app.json'), { expo: {} });

    const rescanned = await detectMobilePreviewProjectConfig(tempDir, previous);

    expect(rescanned).toMatchObject({
      selectedAppPath: 'apps/b',
      iosBundleId: null,
      metroStartCommand: 'npm run mobile',
      androidPrebuildCommand: 'npm run android:generate',
      iosPrebuildCommand: 'npm run ios:generate',
      androidBuildCommand: 'npx expo run:android',
      iosBuildCommand: 'npx expo run:ios',
    });
  });

  it('uses selected app path when it is the Android project root', async () => {
    await writeJson(path.join(tempDir, 'apps/native/package.json'), {
      dependencies: { 'react-native': '^0.76.0' },
    });
    await fs.writeFile(path.join(tempDir, 'apps/native/settings.gradle'), '');

    const config = await detectMobilePreviewProjectConfig(tempDir);

    expect(config.selectedAppPath).toBe('apps/native');
    expect(config.androidProjectPath).toBe('apps/native');
    expect(config.detectedApps[0]).toEqual(
      expect.objectContaining({
        androidProjectPath: 'apps/native',
      }),
    );
  });
});
