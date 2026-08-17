vi.mock('./mobile-preview-process', () => ({
  MOBILE_PREVIEW_DEEPLINK_OPEN_TIMEOUT_MS: 25,
  commandExists: vi.fn(),
  runCommand: vi.fn(),
  spawnManaged: vi.fn(),
}));
vi.mock('./mobile-preview-window-utils', () => ({
  IOS_SIMULATOR_PROCESS_NAMES: ['Simulator'],
  minimizeMobilePreviewWindows: vi.fn(),
}));
vi.mock('../lib/debug', () => ({
  dbg: { mobilePreview: vi.fn() },
}));

import { describe, expect, it, vi } from 'vitest';
import {
  installIosPreviewTestHooks,
  iosIdbAdapter,
  mobilePreviewDebugMock,
  mockIosAppStatusCommands,
  rawIosIdbAdapter,
  runCommandMock,
} from './mobile-preview-ios-test-helpers';
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('mobile preview iOS bundle resolver', () => {
  installIosPreviewTestHooks();

  it('resolves an Expo bundle id and checks whether it is installed', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-app-status-'));
    try {
      await writeFile(
        join(appPath, 'app.json'),
        JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.expo' } } }),
      );
      mockIosAppStatusCommands(
        JSON.stringify({
          'com.example.expo': {
            ApplicationType: 'User',
            Bundle: '/simulator/data/Containers/Bundle/Application/app.app',
            BundleIdentifier: 'com.example.expo',
          },
        }),
      );

      await expect(
        iosIdbAdapter.getIosAppStatus({ appPath, deviceId: 'device-1' }),
      ).resolves.toEqual({
        appInstalled: true,
        bundleId: 'com.example.expo',
        nativeProjectExists: false,
      });
      expect(runCommandMock).toHaveBeenCalledWith(
        'xcrun',
        ['simctl', 'listapps', 'device-1', '--json'],
        { signal: expect.any(AbortSignal) },
      );
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('rejects Expo config symlinks outside the trusted app root', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-app-symlink-'));
    const outsidePath = await mkdtemp(join(tmpdir(), 'jc-ios-outside-'));
    try {
      await writeFile(
        join(outsidePath, 'app.json'),
        JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.evil.app' } } }),
      );
      await symlink(join(outsidePath, 'app.json'), join(appPath, 'app.json'));

      await expect(
        iosIdbAdapter.getIosAppStatus({ appPath, deviceId: 'device-1' }),
      ).rejects.toThrow('iOS app path resolves outside trusted root');
    } finally {
      await rm(appPath, { recursive: true, force: true });
      await rm(outsidePath, { recursive: true, force: true });
    }
  });

  it('rejects an app directory swapped to an external symlink after service validation', async () => {
    const trustedRoot = await mkdtemp(join(tmpdir(), 'jc-ios-trusted-root-'));
    const outsidePath = await mkdtemp(join(tmpdir(), 'jc-ios-swapped-outside-'));
    const appPath = join(trustedRoot, 'apps', 'mobile');
    try {
      await mkdir(appPath, { recursive: true });
      await writeFile(
        join(outsidePath, 'app.json'),
        JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.evil.app' } } }),
      );
      await rm(appPath, { recursive: true });
      await symlink(outsidePath, appPath);

      await expect(
        iosIdbAdapter.getIosAppStatus({
          trustedRoot,
          appPath,
          deviceId: 'device-1',
        }),
      ).rejects.toThrow('outside trusted root');
      expect(runCommandMock).not.toHaveBeenCalled();
    } finally {
      await rm(trustedRoot, { recursive: true, force: true });
      await rm(outsidePath, { recursive: true, force: true });
    }
  });

  it('rejects a trusted root replaced with an external symlink after service validation', async () => {
    const parentPath = await mkdtemp(join(tmpdir(), 'jc-ios-root-swap-parent-'));
    const trustedRoot = join(parentPath, 'trusted');
    const movedRoot = join(parentPath, 'trusted-original');
    const outsidePath = await mkdtemp(join(tmpdir(), 'jc-ios-root-swap-outside-'));
    const appPath = join(trustedRoot, 'apps', 'mobile');
    try {
      await mkdir(appPath, { recursive: true });
      await mkdir(join(outsidePath, 'apps', 'mobile'), { recursive: true });
      await writeFile(
        join(outsidePath, 'apps', 'mobile', 'app.json'),
        JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.evil.app' } } }),
      );
      await rename(trustedRoot, movedRoot);
      await symlink(outsidePath, trustedRoot);

      await expect(
        rawIosIdbAdapter.getIosAppStatus({
          trustedRoot,
          appPath,
          deviceId: 'device-1',
        }),
      ).rejects.toThrow('trusted root changed');
      expect(runCommandMock).not.toHaveBeenCalled();
    } finally {
      await rm(parentPath, { recursive: true, force: true });
      await rm(outsidePath, { recursive: true, force: true });
    }
  });

  it('rejects ios directory symlinks outside the trusted app root', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-dir-symlink-'));
    const outsidePath = await mkdtemp(join(tmpdir(), 'jc-ios-outside-'));
    try {
      await mkdir(join(outsidePath, 'Example.xcodeproj'), { recursive: true });
      await writeFile(
        join(outsidePath, 'Example.xcodeproj', 'project.pbxproj'),
        '// project',
      );
      await symlink(outsidePath, join(appPath, 'ios'));

      await expect(
        iosIdbAdapter.getIosAppStatus({ appPath, deviceId: 'device-1' }),
      ).rejects.toThrow('iOS app path resolves outside trusted root');
    } finally {
      await rm(appPath, { recursive: true, force: true });
      await rm(outsidePath, { recursive: true, force: true });
    }
  });

  it('rejects Xcode project file symlinks outside the trusted app root', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-project-symlink-'));
    const outsidePath = await mkdtemp(join(tmpdir(), 'jc-ios-outside-'));
    try {
      const projectPath = join(appPath, 'ios', 'Example.xcodeproj');
      await mkdir(projectPath, { recursive: true });
      await writeFile(join(outsidePath, 'project.pbxproj'), '// project');
      await symlink(
        join(outsidePath, 'project.pbxproj'),
        join(projectPath, 'project.pbxproj'),
      );

      await expect(
        iosIdbAdapter.getIosAppStatus({ appPath, deviceId: 'device-1' }),
      ).rejects.toThrow('iOS app path resolves outside trusted root');
    } finally {
      await rm(appPath, { recursive: true, force: true });
      await rm(outsidePath, { recursive: true, force: true });
    }
  });

  it('resolves app.config.json and reports a generated native iOS project', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-app-config-'));
    try {
      const xcodeProject = join(appPath, 'ios', 'Example.xcodeproj');
      await mkdir(xcodeProject, { recursive: true });
      await writeFile(join(xcodeProject, 'project.pbxproj'), '// project');
      await writeFile(
        join(appPath, 'app.config.json'),
        JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.config' } } }),
      );
      mockIosAppStatusCommands('{}');

      await expect(
        iosIdbAdapter.getIosAppStatus({ appPath, deviceId: 'device-1' }),
      ).resolves.toMatchObject({
        bundleId: 'com.example.config',
        nativeProjectExists: true,
      });
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('prefers app.config.json over app.json', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-config-precedence-'));
    try {
      await writeFile(
        join(appPath, 'app.json'),
        JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.stale' } } }),
      );
      await writeFile(
        join(appPath, 'app.config.json'),
        JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.current' } } }),
      );
      mockIosAppStatusCommands('{}');

      await expect(
        iosIdbAdapter.getIosAppStatus({ appPath, deviceId: 'device-1' }),
      ).resolves.toMatchObject({ bundleId: 'com.example.current' });
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it.each([
    ['pnpm', 'pnpm', ['exec', 'expo', 'config', '--json']],
    ['yarn', 'yarn', ['expo', 'config', '--json']],
    ['bun', 'bunx', ['--no-install', 'expo', 'config', '--json']],
    [null, 'npm', ['exec', '--offline', '--', 'expo', 'config', '--json']],
  ] as const)(
    'resolves dynamic Expo config offline with %s',
    async (packageManager, command, args) => {
      const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-dynamic-config-'));
      try {
        await writeFile(join(appPath, 'app.config.ts'), 'export default {};\n');
        await writeFile(
          join(appPath, 'app.json'),
          JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.stale' } } }),
        );
        runCommandMock.mockImplementation(async (runCommand, runArgs) => {
          if (runCommand === command && runArgs[0] === args[0]) {
            return {
              stdout: JSON.stringify({
                expo: { ios: { bundleIdentifier: ' com.example.dynamic ' } },
              }),
              stderr: '',
            };
          }
          if (runArgs[1] === 'list' && runArgs[2] === 'devices') {
            return {
              stdout: JSON.stringify({
                devices: {
                  'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
                    { name: 'iPhone 16', udid: 'device-1', state: 'Booted' },
                  ],
                },
              }),
              stderr: '',
            };
          }
          return { stdout: '{}', stderr: '' };
        });

        await expect(
          iosIdbAdapter.getIosAppStatus({
            appPath,
            deviceId: 'device-1',
            packageManager,
          }),
        ).resolves.toMatchObject({
          bundleId: 'com.example.dynamic',
          nativeProjectExists: false,
        });
        expect(runCommandMock).toHaveBeenCalledWith(command, args, {
          cwd: appPath,
          env: expect.objectContaining({ EXPO_OFFLINE: '1', CI: '1' }),
          timeoutMs: expect.any(Number),
          signal: expect.any(AbortSignal),
        });
      } finally {
        await rm(appPath, { recursive: true, force: true });
      }
    },
  );

  it('uses configured bundle id when dynamic Expo config fails', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-config-fallback-'));
    try {
      await writeFile(join(appPath, 'app.config.js'), 'module.exports = {};\n');
      runCommandMock.mockImplementation(async (command, args) => {
        if (command === 'npm') {
          throw new Error('command unavailable: secret output');
        }
        if (args[1] === 'list' && args[2] === 'devices') {
          return {
            stdout: JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
                  { name: 'iPhone 16', udid: 'device-1', state: 'Booted' },
                ],
              },
            }),
            stderr: '',
          };
        }
        return { stdout: '{}', stderr: '' };
      });

      await expect(
        iosIdbAdapter.getIosAppStatus({
          appPath,
          deviceId: 'device-1',
          iosBundleId: ' com.example.fallback ',
        }),
      ).resolves.toMatchObject({
        bundleId: 'com.example.fallback',
        appInstalled: false,
      });
      expect(mobilePreviewDebugMock).toHaveBeenCalledWith(
        expect.stringContaining('Expo config resolution failed'),
        expect.any(String),
      );
      expect(JSON.stringify(mobilePreviewDebugMock.mock.calls)).not.toContain(
        'secret output',
      );
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('prefers nested app packageManager metadata over project config', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-nested-package-manager-'));
    try {
      await writeFile(join(appPath, 'app.config.js'), 'module.exports = {};\n');
      await writeFile(
        join(appPath, 'package.json'),
        JSON.stringify({ packageManager: 'yarn@4.9.2' }),
      );
      runCommandMock.mockImplementation(async (command, args) => {
        if (command === 'yarn') {
          return {
            stdout: JSON.stringify({
              ios: { bundleIdentifier: 'com.example.nested' },
            }),
            stderr: '',
          };
        }
        if (args[1] === 'list' && args[2] === 'devices') {
          return {
            stdout: JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
                  { name: 'iPhone 16', udid: 'device-1', state: 'Booted' },
                ],
              },
            }),
            stderr: '',
          };
        }
        return { stdout: '{}', stderr: '' };
      });

      await expect(
        iosIdbAdapter.getIosAppStatus({
          appPath,
          deviceId: 'device-1',
          packageManager: 'pnpm',
        }),
      ).resolves.toMatchObject({ bundleId: 'com.example.nested' });
      expect(runCommandMock).toHaveBeenCalledWith(
        'yarn',
        ['expo', 'config', '--json'],
        expect.objectContaining({ cwd: appPath }),
      );
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('prefers a nested app lockfile over project package manager config', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-nested-lockfile-'));
    try {
      await writeFile(join(appPath, 'app.config.ts'), 'export default {};\n');
      await writeFile(join(appPath, 'bun.lockb'), '');
      runCommandMock.mockImplementation(async (command, args) => {
        if (command === 'bunx') {
          return {
            stdout: JSON.stringify({
              expo: { ios: { bundleIdentifier: 'com.example.bun' } },
            }),
            stderr: '',
          };
        }
        if (args[1] === 'list' && args[2] === 'devices') {
          return {
            stdout: JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
                  { name: 'iPhone 16', udid: 'device-1', state: 'Booted' },
                ],
              },
            }),
            stderr: '',
          };
        }
        return { stdout: '{}', stderr: '' };
      });

      await iosIdbAdapter.getIosAppStatus({
        appPath,
        deviceId: 'device-1',
        packageManager: 'npm',
      });

      expect(runCommandMock).toHaveBeenCalledWith(
        'bunx',
        ['--no-install', 'expo', 'config', '--json'],
        expect.objectContaining({ cwd: appPath }),
      );
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('leaves dynamic Expo config unresolved after CLI failure without fallback', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-config-unresolved-'));
    try {
      await writeFile(join(appPath, 'app.config.js'), 'module.exports = {};\n');
      runCommandMock.mockRejectedValue(new Error('command unavailable'));

      await expect(
        iosIdbAdapter.getIosAppStatus({ appPath, deviceId: 'device-1' }),
      ).resolves.toEqual({
        appInstalled: null,
        bundleId: null,
        nativeProjectExists: false,
      });
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('normalizes an explicit configured bundle id fallback', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-explicit-fallback-'));
    try {
      mockIosAppStatusCommands('{}');
      await expect(
        iosIdbAdapter.getIosAppStatus({
          appPath,
          deviceId: 'device-1',
          iosBundleId: ' com.example.fallback ',
        }),
      ).resolves.toMatchObject({ bundleId: 'com.example.fallback' });
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('requires a readable xcode project file for nativeProjectExists', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-invalid-native-'));
    try {
      await mkdir(join(appPath, 'ios', 'Empty.xcodeproj'), { recursive: true });

      await expect(
        iosIdbAdapter.getIosAppStatus({ appPath, deviceId: 'device-1' }),
      ).resolves.toEqual({
        appInstalled: null,
        bundleId: null,
        nativeProjectExists: false,
      });
      expect(runCommandMock).not.toHaveBeenCalled();
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('uses resolved Xcode application settings instead of test and extension targets', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-xcode-settings-'));
    try {
      const projectPath = join(appPath, 'ios', 'Example.xcodeproj');
      await mkdir(projectPath, { recursive: true });
      await writeFile(join(projectPath, 'project.pbxproj'), '// project');
      runCommandMock.mockImplementation(async (_command, args) => {
        if (args[1] === 'list' && args[2] === 'devices') {
          return {
            stdout: JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
                  { name: 'iPhone 16', udid: 'device-1', state: 'Booted' },
                ],
              },
            }),
            stderr: '',
          };
        }
        if (args[0] === 'xcodebuild') {
          return {
            stdout: JSON.stringify([
              {
                target: 'ExampleTests',
                buildSettings: {
                  PRODUCT_BUNDLE_IDENTIFIER: 'com.example.tests',
                  PRODUCT_TYPE: 'com.apple.product-type.bundle.unit-test',
                },
              },
              {
                target: 'ShareExtension',
                buildSettings: {
                  PRODUCT_BUNDLE_IDENTIFIER: 'com.example.share',
                  PRODUCT_TYPE: 'com.apple.product-type.app-extension',
                },
              },
              {
                target: 'Example',
                buildSettings: {
                  PRODUCT_BUNDLE_IDENTIFIER: 'com.example.resolved',
                  PRODUCT_TYPE: 'com.apple.product-type.application',
                },
              },
            ]),
            stderr: '',
          };
        }
        return {
          stdout: JSON.stringify({ 'com.example.resolved': {} }),
          stderr: '',
        };
      });

      await expect(
        iosIdbAdapter.getIosAppStatus({ appPath, deviceId: 'device-1' }),
      ).resolves.toMatchObject({ bundleId: 'com.example.resolved' });
      expect(runCommandMock).toHaveBeenCalledWith(
        'xcrun',
        [
          'xcodebuild',
          '-project',
          projectPath,
          '-alltargets',
          '-showBuildSettings',
          '-json',
          '-disableAutomaticPackageResolution',
          '-skipPackageUpdates',
        ],
        {
          cwd: join(appPath, 'ios'),
          timeoutMs: 15_000,
          signal: expect.any(AbortSignal),
        },
      );
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('prefers the native Xcode bundle id over stale Expo config', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-native-precedence-'));
    try {
      const projectPath = join(appPath, 'ios', 'Example.xcodeproj');
      await mkdir(projectPath, { recursive: true });
      await writeFile(join(projectPath, 'project.pbxproj'), '// project');
      await writeFile(
        join(appPath, 'app.json'),
        JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.stale' } } }),
      );
      runCommandMock.mockImplementation(async (_command, args) => {
        if (args[1] === 'list' && args[2] === 'devices') {
          return {
            stdout: JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
                  { name: 'iPhone 16', udid: 'device-1', state: 'Booted' },
                ],
              },
            }),
            stderr: '',
          };
        }
        if (args[0] === 'xcodebuild') {
          return {
            stdout: JSON.stringify([
              {
                target: 'Example',
                buildSettings: {
                  PRODUCT_BUNDLE_IDENTIFIER: 'com.example.native',
                  PRODUCT_TYPE: 'com.apple.product-type.application',
                },
              },
            ]),
            stderr: '',
          };
        }
        return {
          stdout: JSON.stringify({ 'com.example.native': {} }),
          stderr: '',
        };
      });

      await expect(
        iosIdbAdapter.getIosAppStatus({
          appPath,
          deviceId: 'device-1',
          iosBundleId: 'com.example.configured',
        }),
      ).resolves.toMatchObject({
        appInstalled: true,
        bundleId: 'com.example.native',
        nativeProjectExists: true,
      });
      expect(runCommandMock).toHaveBeenLastCalledWith(
        'xcrun',
        ['simctl', 'listapps', 'device-1', '--json'],
        { signal: expect.any(AbortSignal) },
      );
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('falls back to PRODUCT_BUNDLE_IDENTIFIER in a native Xcode project', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-native-status-'));
    try {
      const xcodeProject = join(appPath, 'ios', 'Example.xcodeproj');
      await mkdir(xcodeProject, { recursive: true });
      await writeFile(
        join(xcodeProject, 'project.pbxproj'),
        `
          AAAAAAAAAAAAAAAAAAAAAAAA = {
            isa = PBXNativeTarget;
            buildConfigurationList = BBBBBBBBBBBBBBBBBBBBBBBB;
            productType = "com.apple.product-type.application";
          };
          BBBBBBBBBBBBBBBBBBBBBBBB = {
            isa = XCConfigurationList;
            buildConfigurations = (CCCCCCCCCCCCCCCCCCCCCCCC,);
          };
          CCCCCCCCCCCCCCCCCCCCCCCC = {
            isa = XCBuildConfiguration;
            buildSettings = {
              PRODUCT_BUNDLE_IDENTIFIER = "com.example.$(PRODUCT_NAME:rfc1034identifier)";
              PRODUCT_NAME = NativeApp;
            };
          };
        `,
      );
      runCommandMock.mockImplementation(async (_command, args) => {
        if (args[0] === 'xcodebuild') throw new Error('Xcode settings unavailable');
        if (args[1] === 'list' && args[2] === 'devices') {
          return {
            stdout: JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
                  { name: 'iPhone 16', udid: 'device-1', state: 'Booted' },
                ],
              },
            }),
            stderr: '',
          };
        }
        return {
          stdout: JSON.stringify({ 'com.example.NativeApp': {} }),
          stderr: '',
        };
      });

      await expect(
        iosIdbAdapter.getIosAppStatus({ appPath, deviceId: 'device-1' }),
      ).resolves.toEqual({
        appInstalled: true,
        bundleId: 'com.example.NativeApp',
        nativeProjectExists: true,
      });
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('does not select an extension id from the static Xcode fallback', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-extension-fallback-'));
    try {
      const xcodeProject = join(appPath, 'ios', 'Example.xcodeproj');
      await mkdir(xcodeProject, { recursive: true });
      await writeFile(
        join(xcodeProject, 'project.pbxproj'),
        `
          AAAAAAAAAAAAAAAAAAAAAAAA = {
            isa = PBXNativeTarget;
            buildConfigurationList = BBBBBBBBBBBBBBBBBBBBBBBB;
            productType = "com.apple.product-type.app-extension";
          };
          BBBBBBBBBBBBBBBBBBBBBBBB = {
            isa = XCConfigurationList;
            buildConfigurations = (CCCCCCCCCCCCCCCCCCCCCCCC,);
          };
          CCCCCCCCCCCCCCCCCCCCCCCC = {
            isa = XCBuildConfiguration;
            buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = com.example.share; };
          };
        `,
      );
      runCommandMock.mockRejectedValue(new Error('Xcode settings unavailable'));

      await expect(
        iosIdbAdapter.getIosAppStatus({ appPath, deviceId: 'device-1' }),
      ).resolves.toEqual({
        appInstalled: null,
        bundleId: null,
        nativeProjectExists: true,
      });
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('selects the application id from a mixed app and extension static fallback', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-mixed-fallback-'));
    try {
      const xcodeProject = join(appPath, 'ios', 'Example.xcodeproj');
      await mkdir(xcodeProject, { recursive: true });
      await writeFile(
        join(xcodeProject, 'project.pbxproj'),
        `
          AAAAAAAAAAAAAAAAAAAAAAAA = { isa = PBXNativeTarget; buildConfigurationList = BBBBBBBBBBBBBBBBBBBBBBBB; productType = "com.apple.product-type.application"; };
          DDDDDDDDDDDDDDDDDDDDDDDD = { isa = PBXNativeTarget; buildConfigurationList = EEEEEEEEEEEEEEEEEEEEEEEE; productType = "com.apple.product-type.app-extension"; };
          BBBBBBBBBBBBBBBBBBBBBBBB = { isa = XCConfigurationList; buildConfigurations = (CCCCCCCCCCCCCCCCCCCCCCCC,); };
          EEEEEEEEEEEEEEEEEEEEEEEE = { isa = XCConfigurationList; buildConfigurations = (FFFFFFFFFFFFFFFFFFFFFFFF,); };
          CCCCCCCCCCCCCCCCCCCCCCCC = { isa = XCBuildConfiguration; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = com.example.main; }; };
          FFFFFFFFFFFFFFFFFFFFFFFF = { isa = XCBuildConfiguration; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = com.example.share; }; };
        `,
      );
      runCommandMock.mockImplementation(async (_command, args) => {
        if (args[0] === 'xcodebuild') throw new Error('Xcode settings unavailable');
        if (args[1] === 'list' && args[2] === 'devices') {
          return {
            stdout: JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
                  { name: 'iPhone 16', udid: 'device-1', state: 'Booted' },
                ],
              },
            }),
            stderr: '',
          };
        }
        return { stdout: JSON.stringify({ 'com.example.main': {} }), stderr: '' };
      });

      await expect(
        iosIdbAdapter.getIosAppStatus({ appPath, deviceId: 'device-1' }),
      ).resolves.toMatchObject({ bundleId: 'com.example.main' });
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'two application targets',
      `
        AAAAAAAAAAAAAAAAAAAAAAAA = { isa = PBXNativeTarget; buildConfigurationList = BBBBBBBBBBBBBBBBBBBBBBBB; productType = "com.apple.product-type.application"; };
        DDDDDDDDDDDDDDDDDDDDDDDD = { isa = PBXNativeTarget; buildConfigurationList = EEEEEEEEEEEEEEEEEEEEEEEE; productType = "com.apple.product-type.application"; };
        BBBBBBBBBBBBBBBBBBBBBBBB = { isa = XCConfigurationList; buildConfigurations = (CCCCCCCCCCCCCCCCCCCCCCCC,); };
        EEEEEEEEEEEEEEEEEEEEEEEE = { isa = XCConfigurationList; buildConfigurations = (FFFFFFFFFFFFFFFFFFFFFFFF,); };
        CCCCCCCCCCCCCCCCCCCCCCCC = { isa = XCBuildConfiguration; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = com.example.one; }; };
        FFFFFFFFFFFFFFFFFFFFFFFF = { isa = XCBuildConfiguration; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = com.example.two; }; };
      `,
    ],
    [
      'variable application id',
      `
        AAAAAAAAAAAAAAAAAAAAAAAA = { isa = PBXNativeTarget; buildConfigurationList = BBBBBBBBBBBBBBBBBBBBBBBB; productType = "com.apple.product-type.application"; };
        BBBBBBBBBBBBBBBBBBBBBBBB = { isa = XCConfigurationList; buildConfigurations = (CCCCCCCCCCCCCCCCCCCCCCCC,); };
        CCCCCCCCCCCCCCCCCCCCCCCC = { isa = XCBuildConfiguration; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = "$(APP_BUNDLE_ID)"; }; };
      `,
    ],
  ])('returns null for ambiguous static fallback with %s', async (_name, project) => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-ambiguous-fallback-'));
    try {
      const xcodeProject = join(appPath, 'ios', 'Example.xcodeproj');
      await mkdir(xcodeProject, { recursive: true });
      await writeFile(join(xcodeProject, 'project.pbxproj'), project);
      runCommandMock.mockRejectedValue(new Error('Xcode settings unavailable'));

      await expect(
        iosIdbAdapter.getIosAppStatus({ appPath, deviceId: 'device-1' }),
      ).resolves.toMatchObject({ bundleId: null });
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });
});
