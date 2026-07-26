import { dirname, join } from 'node:path';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  MobilePreviewIosAppRestartParams,
  MobilePreviewIosAppRestartResult,
  MobilePreviewIosAppStatus,
  MobilePreviewIosAppStatusParams,
  MobilePreviewIosCreateDeviceParams,
  MobilePreviewIosDeviceType,
  MobilePreviewIosRenameDeviceParams,
  MobilePreviewIosRuntime,
  MobilePreviewIosToolStatus,
} from '../../shared/mobile-simulator-types';

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

import {
  buildIdbInputArgs,
  createMjpegFrameParser,
  getIosActiveTouchSessionForTests,
  getPendingIosBootWaiterCountForTests,
  iosIdbAdapter as rawIosIdbAdapter,
  MAX_MJPEG_PENDING_BYTES,
  parseSimctlDeviceTypes,
  parseSimctlDevices,
  parseSimctlRuntimes,
  getIosFallbackTouchSessionForTests,
  resetCoreSimulatorFramebufferPoolForTests,
  SCREENSHOT_POLL_INTERVAL_MS,
} from './mobile-preview-ios-idb-adapter';
import {
  MOBILE_PREVIEW_DEEPLINK_OPEN_TIMEOUT_MS,
  commandExists,
  runCommand,
  spawnManaged,
} from './mobile-preview-process';
import { minimizeMobilePreviewWindows } from './mobile-preview-window-utils';
import { dbg } from '../lib/debug';

const commandExistsMock = vi.mocked(commandExists);
const runCommandMock = vi.mocked(runCommand);
const spawnManagedMock = vi.mocked(spawnManaged);
const minimizeMobilePreviewWindowsMock = vi.mocked(minimizeMobilePreviewWindows);
const mobilePreviewDebugMock = vi.mocked(dbg.mobilePreview);
const iosIdbAdapter = {
  ...rawIosIdbAdapter,
  getIosAppStatus(
    params: MobilePreviewIosAppStatusParams & {
      trustedRoot?: string;
      signal?: AbortSignal;
    },
  ) {
    return rawIosIdbAdapter.getIosAppStatus({
      ...params,
      trustedRoot: params.trustedRoot ?? params.appPath,
    });
  },
  restartIosApp(
    params: MobilePreviewIosAppRestartParams & { trustedRoot?: string },
  ) {
    return rawIosIdbAdapter.restartIosApp({
      ...params,
      trustedRoot: params.trustedRoot ?? params.appPath,
    });
  },
};

const OPENSTEP_LISTAPPS = `{
    "com.apple.Bridge" = {
        ApplicationType = System;
        Bundle = "file:///Applications/Xcode.app/Contents/Developer/Platforms/iPhoneSimulator.platform/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS.simruntime/Contents/Resources/RuntimeRoot/Applications/Bridge.app/";
        BundleIdentifier = "com.apple.Bridge";
    };
    "com.example.app" = {
        ApplicationType = User;
        BundleIdentifier = "com.example.app";
    };
}`;

function pngWithSize(width: number, height: number): Buffer {
  const png = Buffer.alloc(24);
  png.set(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

function mockSimctlCommands(state: string) {
  runCommandMock.mockImplementation(async (command, args) => {
    if (
      command === 'xcrun' &&
      args[0] === 'simctl' &&
      args[1] === 'io' &&
      args[3] === 'screenshot'
    ) {
      const screenshotPath = args.at(-1)!;
      await mkdir(dirname(screenshotPath), { recursive: true });
      await writeFile(screenshotPath, pngWithSize(2, 2));
      return { stdout: '', stderr: '' };
    }

    return {
      stdout: JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
            { name: 'iPhone 16', udid: 'device-1', state },
          ],
        },
      }),
      stderr: '',
    };
  });
}

function mockIosAppStatusCommands(listAppsStdout: string) {
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
    return { stdout: listAppsStdout, stderr: '' };
  });
}

function mockReadyHidHelper() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    pid: 123,
    stderr,
    stdin,
    stdout,
  });
  const writes: string[] = [];
  stdin.write = vi.fn((chunk, callback?: (error?: Error | null) => void) => {
    writes.push(String(chunk));
    callback?.();
    return true;
  }) as never;
  spawnManagedMock.mockReturnValue({
    child: child as never,
    stop: vi.fn().mockResolvedValue(undefined),
  });
  queueMicrotask(() => stdout.write('READY\n'));
  return { stdin, writes };
}

function mockFramebufferWithReadyHid(
  framebuffer: ReturnType<typeof spawnManaged>,
) {
  spawnManagedMock.mockImplementation((command) => {
    if (command !== 'python3') return framebuffer;
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      pid: 456,
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      stdout,
    });
    queueMicrotask(() => stdout.write('READY\n'));
    return {
      child: child as never,
      stop: vi.fn().mockResolvedValue(undefined),
    };
  });
}

describe('mobile preview iOS idb adapter', () => {
  beforeEach(async () => {
    await resetCoreSimulatorFramebufferPoolForTests();
    vi.resetAllMocks();
    await mkdir(tmpdir(), { recursive: true });
    process.env.JC_MOBILE_PREVIEW_IOS_CORE_SIMULATOR = '0';
    delete process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE;
    delete process.env.JC_MOBILE_PREVIEW_IOS_RAW_STREAM;
    delete process.env.DEVELOPER_DIR;
    commandExistsMock.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes shared iOS simulator management types', () => {
    const toolStatus: MobilePreviewIosToolStatus = {
      xcrunPath: '/usr/bin/xcrun',
      missingTools: [],
    };
    const runtime: MobilePreviewIosRuntime = {
      id: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2',
      name: 'iOS 18.2',
      version: '18.2',
      platform: 'iOS',
      available: true,
    };
    const deviceType: MobilePreviewIosDeviceType = {
      id: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
      name: 'iPhone 16',
      productFamily: 'iPhone',
      screen: null,
    };
    const createParams: MobilePreviewIosCreateDeviceParams = {
      name: 'Jean-Claude iPhone',
      deviceTypeId: deviceType.id,
      runtimeId: runtime.id,
    };
    const renameParams: MobilePreviewIosRenameDeviceParams = {
      deviceId: 'device-1',
      name: 'Jean-Claude iPhone Renamed',
    };

    expect({ toolStatus, runtime, deviceType, createParams, renameParams })
      .toMatchObject({
        toolStatus: { missingTools: [] },
        runtime: { available: true, platform: 'iOS' },
        deviceType: { productFamily: 'iPhone' },
        createParams: { deviceTypeId: deviceType.id, runtimeId: runtime.id },
        renameParams: { deviceId: 'device-1' },
      });
  });

  it('exposes shared iOS app status and restart types', () => {
    const params: MobilePreviewIosAppStatusParams = {
      appPath: '/trusted/apps/mobile',
      deviceId: 'device-1',
    };
    const restartParams: MobilePreviewIosAppRestartParams = params;
    const status: MobilePreviewIosAppStatus = {
      appInstalled: true,
      bundleId: 'com.example.mobile',
      nativeProjectExists: false,
    };
    const restartResult: MobilePreviewIosAppRestartResult = {
      bundleId: 'com.example.mobile',
      restartedAt: '2026-07-14T12:00:00.000Z',
    };

    expect({ params, restartParams, status, restartResult }).toMatchObject({
      params: { deviceId: 'device-1' },
      status: { appInstalled: true, nativeProjectExists: false },
      restartResult: { bundleId: 'com.example.mobile' },
    });
  });

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

  it('returns null install status when bundle id cannot be resolved', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-unresolved-status-'));
    try {
      await writeFile(join(appPath, 'app.json'), JSON.stringify({ expo: {} }));

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

  it('reports an app absent from simctl listapps as not installed', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-missing-status-'));
    try {
      await writeFile(
        join(appPath, 'app.json'),
        JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.missing' } } }),
      );
      mockIosAppStatusCommands(
        JSON.stringify({
          'com.example.missing.beta': {
            ApplicationType: 'User',
            BundleIdentifier: 'com.example.missing.beta',
          },
        }),
      );

      await expect(
        iosIdbAdapter.getIosAppStatus({ appPath, deviceId: 'device-1' }),
      ).resolves.toMatchObject({
        appInstalled: false,
        bundleId: 'com.example.missing',
      });
      expect(runCommandMock).not.toHaveBeenCalledWith(
        'plutil',
        expect.anything(),
        expect.anything(),
      );
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it.each([
    ['com.example.app', true],
    ['com.example', false],
  ])(
    'converts OpenStep listapps output and reports exact bundle %s installed=%s',
    async (bundleIdentifier, appInstalled) => {
      const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-openstep-status-'));
      try {
        await writeFile(
          join(appPath, 'app.json'),
          JSON.stringify({ expo: { ios: { bundleIdentifier } } }),
        );
        runCommandMock.mockImplementation(async (command, args) => {
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
          if (command === 'plutil') {
            return {
              stdout: JSON.stringify({
                'com.apple.Bridge': { ApplicationType: 'System' },
                'com.example.app': { ApplicationType: 'User' },
              }),
              stderr: '',
            };
          }
          return { stdout: OPENSTEP_LISTAPPS, stderr: '' };
        });

        await expect(
          iosIdbAdapter.getIosAppStatus({ appPath, deviceId: 'device-1' }),
        ).resolves.toMatchObject({ appInstalled, bundleId: bundleIdentifier });
        const listAppsOptions = runCommandMock.mock.calls.find(
          ([, args]) => args[1] === 'listapps',
        )?.[2];
        expect(runCommandMock).toHaveBeenCalledWith(
          'plutil',
          ['-convert', 'json', '-o', '-', '--', '-'],
          { input: OPENSTEP_LISTAPPS, signal: listAppsOptions?.signal },
        );
        expect(listAppsOptions?.signal).toBeInstanceOf(AbortSignal);
      } finally {
        await rm(appPath, { recursive: true, force: true });
      }
    },
  );

  it('reports OpenStep conversion failures without logging listapps payload', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-plutil-failure-'));
    try {
      await writeFile(
        join(appPath, 'app.json'),
        JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.app' } } }),
      );
      runCommandMock.mockImplementation(async (command, args) => {
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
        if (command === 'plutil') throw new Error('conversion failed');
        return { stdout: OPENSTEP_LISTAPPS, stderr: '' };
      });

      await expect(
        iosIdbAdapter.getIosAppStatus({ appPath, deviceId: 'device-1' }),
      ).rejects.toThrow('Invalid simctl listapps output');
      expect(mobilePreviewDebugMock).toHaveBeenCalledWith(
        'Invalid simctl listapps output deviceId=%s format=%s bytes=%d conversionError=%s',
        'device-1',
        'openstep-or-unknown',
        Buffer.byteLength(OPENSTEP_LISTAPPS),
        'Error',
      );
      expect(
        mobilePreviewDebugMock.mock.calls.some((call) =>
          call.some((value) => value === OPENSTEP_LISTAPPS),
        ),
      ).toBe(false);
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('boots a shutdown simulator before checking installed apps', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-error-status-'));
    try {
      await writeFile(
        join(appPath, 'app.json'),
        JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.app' } } }),
      );
      runCommandMock.mockImplementation(async (_command, args) => {
        if (args[1] === 'list' && args[2] === 'devices') {
          return {
            stdout: JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
                  { name: 'iPhone 16', udid: 'device-1', state: 'Shutdown' },
                ],
              },
            }),
            stderr: '',
          };
        }
        if (args[1] === 'listapps') {
          return {
            stdout: JSON.stringify({ 'com.example.app': {} }),
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      });

      await expect(
        iosIdbAdapter.getIosAppStatus({ appPath, deviceId: 'device-1' }),
      ).resolves.toMatchObject({ appInstalled: true });
      expect(runCommandMock.mock.calls).toEqual([
        [
          'xcrun',
          ['simctl', 'list', 'devices', '--json'],
          { signal: expect.any(AbortSignal) },
        ],
        [
          'xcrun',
          ['simctl', 'boot', 'device-1'],
          { signal: expect.any(AbortSignal) },
        ],
        [
          'xcrun',
          ['simctl', 'bootstatus', 'device-1', '-b'],
          { signal: expect.any(AbortSignal) },
        ],
        [
          'xcrun',
          ['simctl', 'listapps', 'device-1', '--json'],
          { signal: expect.any(AbortSignal) },
        ],
      ]);
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('deduplicates concurrent simulator boot attempts by device', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-concurrent-boot-'));
    const statusController = new AbortController();
    let releaseBoot: (() => void) | undefined;
    let bootAborted = false;
    try {
      await writeFile(
        join(appPath, 'app.json'),
        JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.app' } } }),
      );
      process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
        __dirname,
        '../native/mobile-preview-ios-hid-helper.py',
      );
      mockReadyHidHelper();
      runCommandMock.mockImplementation(async (command, args, options) => {
        if (
          command === 'xcrun' &&
          args[0] === 'simctl' &&
          args[1] === 'io' &&
          args[3] === 'screenshot'
        ) {
          const screenshotPath = args.at(-1)!;
          await mkdir(dirname(screenshotPath), { recursive: true });
          await writeFile(screenshotPath, pngWithSize(2, 2));
          return { stdout: '', stderr: '' };
        }
        if (args[1] === 'list' && args[2] === 'devices') {
          return {
            stdout: JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
                  { name: 'iPhone 16', udid: 'device-1', state: 'Shutdown' },
                ],
              },
            }),
            stderr: '',
          };
        }
        if (args[1] === 'bootstatus') {
          await new Promise<void>((resolve) => {
            releaseBoot = resolve;
          });
          bootAborted = options?.signal?.aborted ?? false;
        }
        if (args[1] === 'listapps') {
          return { stdout: '{}', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const first = iosIdbAdapter.getIosAppStatus({
        appPath,
        deviceId: 'device-1',
        signal: statusController.signal,
      });
      const second = iosIdbAdapter.startStream({
        taskId: 'task-concurrent-boot',
        deviceId: 'device-1',
        onFrame: vi.fn(),
        onSession: vi.fn(),
      });
      await vi.waitFor(() => expect(releaseBoot).toBeTypeOf('function'));
      await vi.waitFor(() =>
        expect(getPendingIosBootWaiterCountForTests('device-1')).toBe(2),
      );
      statusController.abort(new DOMException('cancel status', 'AbortError'));
      releaseBoot?.();
      await expect(first).rejects.toMatchObject({ name: 'AbortError' });
      const stream = await second;

      expect(
        runCommandMock.mock.calls.filter(([, args]) => args[1] === 'boot'),
      ).toHaveLength(1);
      expect(
        runCommandMock.mock.calls.filter(([, args]) => args[1] === 'bootstatus'),
      ).toHaveLength(1);
      expect(bootAborted).toBe(false);
      await stream.stop();
    } finally {
      releaseBoot?.();
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('cancels a pending simulator boot with the stream startup signal', async () => {
    let bootSignal: AbortSignal | undefined;
    runCommandMock.mockImplementation(async (_command, args, options) => {
      if (args[1] === 'list' && args[2] === 'devices') {
        return {
          stdout: JSON.stringify({
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
                { name: 'iPhone 16', udid: 'device-1', state: 'Shutdown' },
              ],
            },
          }),
          stderr: '',
        };
      }
      if (args[1] === 'bootstatus') {
        bootSignal = options?.signal;
        return new Promise<never>((_, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      }
      return { stdout: '', stderr: '' };
    });
    const controller = new AbortController();
    const start = iosIdbAdapter.startStream({
      taskId: 'task-1',
      deviceId: 'device-1',
      signal: controller.signal,
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    await vi.waitFor(() => expect(bootSignal).toBeDefined());

    controller.abort(new DOMException('task completed', 'AbortError'));

    await expect(start).rejects.toMatchObject({ name: 'AbortError' });
    expect(bootSignal?.aborted).toBe(true);
  });

  it('keeps a shared boot alive when one of two status waiters cancels', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-two-status-boot-'));
    const firstController = new AbortController();
    let releaseBoot: (() => void) | undefined;
    let bootAborted = false;
    try {
      await writeFile(
        join(appPath, 'app.json'),
        JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.app' } } }),
      );
      runCommandMock.mockImplementation(async (_command, args, options) => {
        if (args[1] === 'list' && args[2] === 'devices') {
          return {
            stdout: JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
                  { name: 'iPhone 16', udid: 'device-1', state: 'Shutdown' },
                ],
              },
            }),
            stderr: '',
          };
        }
        if (args[1] === 'bootstatus') {
          await new Promise<void>((resolve) => {
            releaseBoot = resolve;
          });
          bootAborted = options?.signal?.aborted ?? false;
        }
        if (args[1] === 'listapps') return { stdout: '{}', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const first = iosIdbAdapter.getIosAppStatus({
        appPath,
        deviceId: 'device-1',
        signal: firstController.signal,
      });
      const second = iosIdbAdapter.getIosAppStatus({
        appPath,
        deviceId: 'device-1',
      });
      await vi.waitFor(() => expect(releaseBoot).toBeTypeOf('function'));
      await vi.waitFor(() =>
        expect(getPendingIosBootWaiterCountForTests('device-1')).toBe(2),
      );
      firstController.abort(new DOMException('cancel first', 'AbortError'));
      releaseBoot?.();
      await expect(first).rejects.toMatchObject({ name: 'AbortError' });

      await expect(second).resolves.toMatchObject({ appInstalled: false });
      expect(bootAborted).toBe(false);
      expect(
        runCommandMock.mock.calls.filter(([, args]) => args[1] === 'boot'),
      ).toHaveLength(1);
    } finally {
      releaseBoot?.();
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('retries simulator boot after a failed pending attempt', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-boot-retry-'));
    let bootAttempts = 0;
    let bootStatusAttempts = 0;
    let deviceLookups = 0;
    try {
      await writeFile(
        join(appPath, 'app.json'),
        JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.app' } } }),
      );
      runCommandMock.mockImplementation(async (_command, args) => {
        if (args[1] === 'list' && args[2] === 'devices') {
          deviceLookups += 1;
          return {
            stdout: JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
                  {
                    name: 'iPhone 16',
                    udid: 'device-1',
                    state: deviceLookups === 1 ? 'Shutdown' : 'Booted',
                  },
                ],
              },
            }),
            stderr: '',
          };
        }
        if (args[1] === 'boot') bootAttempts += 1;
        if (args[1] === 'bootstatus' && ++bootStatusAttempts === 1) {
          throw new Error('Simulator bootstatus failed');
        }
        if (args[1] === 'listapps') {
          return { stdout: '{}', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      await expect(
        iosIdbAdapter.getIosAppStatus({ appPath, deviceId: 'device-1' }),
      ).rejects.toThrow('Simulator bootstatus failed');
      await expect(
        iosIdbAdapter.getIosAppStatus({ appPath, deviceId: 'device-1' }),
      ).resolves.toMatchObject({ appInstalled: false });
      expect(deviceLookups).toBe(2);
      expect(bootAttempts).toBe(1);
      expect(bootStatusAttempts).toBe(1);
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('aborts and awaits a pending simulator boot during disposal', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-dispose-boot-'));
    let bootStatusStarted = false;
    let bootStatusAborted = false;
    let rejectBootStatus: (() => void) | undefined;
    try {
      await writeFile(
        join(appPath, 'app.json'),
        JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.app' } } }),
      );
      runCommandMock.mockImplementation(async (_command, args, options) => {
        if (args[1] === 'list' && args[2] === 'devices') {
          return {
            stdout: JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
                  { name: 'iPhone 16', udid: 'device-1', state: 'Shutdown' },
                ],
              },
            }),
            stderr: '',
          };
        }
        if (args[1] === 'bootstatus') {
          bootStatusStarted = true;
          await new Promise<void>((_resolve, reject) => {
            rejectBootStatus = () => reject(new Error('bootstatus closed'));
            options?.signal?.addEventListener(
              'abort',
              () => {
                bootStatusAborted = true;
              },
              { once: true },
            );
          });
        }
        return { stdout: '', stderr: '' };
      });

      const status = iosIdbAdapter
        .getIosAppStatus({ appPath, deviceId: 'device-1' })
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(bootStatusStarted).toBe(true));

      let disposed = false;
      const dispose = iosIdbAdapter.dispose().then(() => {
        disposed = true;
      });
      await vi.waitFor(() => expect(bootStatusAborted).toBe(true));
      await Promise.resolve();
      expect(disposed).toBe(false);

      rejectBootStatus?.();
      await dispose;
      await expect(status).resolves.toBeInstanceOf(Error);
      expect(disposed).toBe(true);

      runCommandMock.mockClear();
      await expect(
        iosIdbAdapter.getIosAppStatus({ appPath, deviceId: 'device-1' }),
      ).rejects.toThrow('iOS preview is shutting down');
      expect(runCommandMock).not.toHaveBeenCalled();
    } finally {
      rejectBootStatus?.();
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('aborts and awaits an active app status listapps command during disposal', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-dispose-status-'));
    let listAppsStarted = false;
    let listAppsAborted = false;
    let rejectListApps: (() => void) | undefined;
    try {
      await writeFile(
        join(appPath, 'app.json'),
        JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.app' } } }),
      );
      runCommandMock.mockImplementation(async (_command, args, options) => {
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
        if (args[1] === 'listapps') {
          listAppsStarted = true;
          await new Promise<void>((_resolve, reject) => {
            rejectListApps = () => reject(new Error('listapps closed'));
            options?.signal?.addEventListener(
              'abort',
              () => {
                listAppsAborted = true;
              },
              { once: true },
            );
          });
        }
        return { stdout: '', stderr: '' };
      });

      const status = iosIdbAdapter.getIosAppStatus({
        appPath,
        deviceId: 'device-1',
      });
      const statusAssertion = expect(status).rejects.toThrow('listapps closed');
      await vi.waitFor(() => expect(listAppsStarted).toBe(true));

      let disposed = false;
      const dispose = iosIdbAdapter.dispose().then(() => {
        disposed = true;
      });
      await vi.waitFor(() => expect(listAppsAborted).toBe(true));
      await Promise.resolve();
      expect(disposed).toBe(false);

      rejectListApps?.();
      await statusAssertion;
      await dispose;
      expect(disposed).toBe(true);
    } finally {
      rejectListApps?.();
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('aborts and awaits native xcodebuild resolution during disposal', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-dispose-xcodebuild-'));
    let xcodebuildStarted = false;
    let xcodebuildAborted = false;
    let rejectXcodebuild: (() => void) | undefined;
    try {
      const projectPath = join(appPath, 'ios', 'Example.xcodeproj');
      await mkdir(projectPath, { recursive: true });
      await writeFile(join(projectPath, 'project.pbxproj'), '// project');
      runCommandMock.mockImplementation(async (_command, args, options) => {
        if (args[0] === 'xcodebuild') {
          xcodebuildStarted = true;
          await new Promise<void>((_resolve, reject) => {
            rejectXcodebuild = () => reject(new Error('xcodebuild closed'));
            options?.signal?.addEventListener(
              'abort',
              () => {
                xcodebuildAborted = true;
              },
              { once: true },
            );
          });
        }
        return { stdout: '', stderr: '' };
      });

      const status = iosIdbAdapter
        .getIosAppStatus({ appPath, deviceId: 'device-1' })
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(xcodebuildStarted).toBe(true));
      let disposed = false;
      const dispose = iosIdbAdapter.dispose().then(() => {
        disposed = true;
      });

      await vi.waitFor(() => expect(xcodebuildAborted).toBe(true));
      expect(disposed).toBe(false);
      rejectXcodebuild?.();
      await dispose;
      await expect(status).resolves.toBeInstanceOf(Error);
    } finally {
      rejectXcodebuild?.();
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('aborts a pending simulator boot and does not continue to bootstatus or listapps', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-cancel-boot-'));
    const controller = new AbortController();
    let bootStarted = false;
    try {
      await writeFile(
        join(appPath, 'app.json'),
        JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.app' } } }),
      );
      runCommandMock.mockImplementation(async (_command, args, options) => {
        if (args[1] === 'list' && args[2] === 'devices') {
          return {
            stdout: JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
                  { name: 'iPhone 16', udid: 'device-1', state: 'Shutdown' },
                ],
              },
            }),
            stderr: '',
          };
        }
        if (args[1] === 'boot') {
          bootStarted = true;
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => reject(options.signal?.reason),
              { once: true },
            );
          });
        }
        return { stdout: '{}', stderr: '' };
      });

      const status = iosIdbAdapter.getIosAppStatus({
        appPath,
        deviceId: 'device-1',
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(bootStarted).toBe(true));
      controller.abort(new DOMException('Status request cancelled', 'AbortError'));

      await expect(status).rejects.toMatchObject({ name: 'AbortError' });
      expect(runCommandMock).not.toHaveBeenCalledWith(
        'xcrun',
        ['simctl', 'bootstatus', 'device-1', '-b'],
        expect.anything(),
      );
      expect(runCommandMock).not.toHaveBeenCalledWith(
        'xcrun',
        ['simctl', 'listapps', 'device-1', '--json'],
        expect.anything(),
      );
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('starts a fresh boot before an aborted stale boot settles', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-replace-aborted-boot-'));
    const controller = new AbortController();
    let bootAttempts = 0;
    let firstBootAborted = false;
    let rejectFirstBoot: (() => void) | undefined;
    try {
      await writeFile(
        join(appPath, 'app.json'),
        JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.app' } } }),
      );
      runCommandMock.mockImplementation(async (_command, args, options) => {
        if (args[1] === 'list' && args[2] === 'devices') {
          return {
            stdout: JSON.stringify({
              devices: {
                'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
                  { name: 'iPhone 16', udid: 'device-1', state: 'Shutdown' },
                ],
              },
            }),
            stderr: '',
          };
        }
        if (args[1] === 'boot' && ++bootAttempts === 1) {
          return new Promise((_resolve, reject) => {
            rejectFirstBoot = () => reject(options?.signal?.reason);
            options?.signal?.addEventListener(
              'abort',
              () => {
                firstBootAborted = true;
              },
              { once: true },
            );
          });
        }
        if (args[1] === 'listapps') return { stdout: '{}', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const first = iosIdbAdapter.getIosAppStatus({
        appPath,
        deviceId: 'device-1',
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(bootAttempts).toBe(1));
      controller.abort(new DOMException('cancel first', 'AbortError'));
      await expect(first).rejects.toMatchObject({ name: 'AbortError' });
      expect(firstBootAborted).toBe(true);

      const replacement = iosIdbAdapter.getIosAppStatus({
        appPath,
        deviceId: 'device-1',
      });
      await expect(replacement).resolves.toMatchObject({ appInstalled: false });
      expect(bootAttempts).toBe(2);

      rejectFirstBoot?.();
      await Promise.resolve();
      expect(getPendingIosBootWaiterCountForTests('device-1')).toBe(0);
    } finally {
      rejectFirstBoot?.();
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('rejects unresolved apps immediately after disposal', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-disposed-unresolved-'));
    try {
      await iosIdbAdapter.dispose();
      runCommandMock.mockClear();

      await expect(
        iosIdbAdapter.getIosAppStatus({ appPath, deviceId: 'device-1' }),
      ).rejects.toThrow('iOS preview is shutting down');
      expect(runCommandMock).not.toHaveBeenCalled();
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('rejects malformed simctl listapps JSON', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-malformed-listapps-'));
    try {
      await writeFile(
        join(appPath, 'app.json'),
        JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.app' } } }),
      );
      mockIosAppStatusCommands('{not json');

      await expect(
        iosIdbAdapter.getIosAppStatus({ appPath, deviceId: 'device-1' }),
      ).rejects.toThrow('Invalid simctl listapps output');
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it.each(['null', '[]', '{"com.example.app":null}'])(
    'rejects malformed simctl listapps shape %s',
    async (stdout) => {
      const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-listapps-shape-'));
      try {
        await writeFile(
          join(appPath, 'app.json'),
          JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.app' } } }),
        );
        mockIosAppStatusCommands(stdout);

        await expect(
          iosIdbAdapter.getIosAppStatus({ appPath, deviceId: 'device-1' }),
        ).rejects.toThrow('Invalid simctl listapps JSON output');
        expect(runCommandMock).not.toHaveBeenCalledWith(
          'plutil',
          expect.anything(),
          expect.anything(),
        );
      } finally {
        await rm(appPath, { recursive: true, force: true });
      }
    },
  );

  it('rethrows wrapped listapps NSPOSIX runtime failures', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-listapps-runtime-'));
    try {
      await writeFile(
        join(appPath, 'app.json'),
        JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.app' } } }),
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
        throw new Error(
          'Command failed: xcrun simctl listapps device-1 --json\nAn error was encountered processing the command (domain=NSPOSIXErrorDomain, code=2): No such file or directory',
        );
      });

      await expect(
        iosIdbAdapter.getIosAppStatus({ appPath, deviceId: 'device-1' }),
      ).rejects.toThrow('NSPOSIXErrorDomain, code=2');
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('restarts the resolved iOS app through simctl', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-restart-'));
    try {
      await writeFile(
        join(appPath, 'app.json'),
        JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.restart' } } }),
      );
      runCommandMock.mockResolvedValue({ stdout: '', stderr: '' });

      await expect(
        iosIdbAdapter.restartIosApp({ appPath, deviceId: 'device-1' }),
      ).resolves.toMatchObject({ bundleId: 'com.example.restart' });
      expect(runCommandMock.mock.calls).toEqual([
        [
          'xcrun',
          ['simctl', 'terminate', 'device-1', 'com.example.restart'],
          { signal: expect.any(AbortSignal) },
        ],
        [
          'xcrun',
          ['simctl', 'launch', 'device-1', 'com.example.restart'],
          { signal: expect.any(AbortSignal) },
        ],
      ]);
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('aborts and awaits restart during disposal without launching', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-dispose-restart-'));
    let terminateStarted = false;
    let terminateAborted = false;
    let rejectTerminate: (() => void) | undefined;
    try {
      await writeFile(
        join(appPath, 'app.json'),
        JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.restart' } } }),
      );
      runCommandMock.mockImplementation(async (_command, args, options) => {
        if (args[1] === 'terminate') {
          terminateStarted = true;
          await new Promise<void>((_resolve, reject) => {
            rejectTerminate = () => reject(new Error('terminate closed'));
            options?.signal?.addEventListener(
              'abort',
              () => {
                terminateAborted = true;
              },
              { once: true },
            );
          });
        }
        return { stdout: '', stderr: '' };
      });

      const restart = iosIdbAdapter
        .restartIosApp({ appPath, deviceId: 'device-1' })
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(terminateStarted).toBe(true));
      let disposed = false;
      const dispose = iosIdbAdapter.dispose().then(() => {
        disposed = true;
      });

      await vi.waitFor(() => expect(terminateAborted).toBe(true));
      expect(disposed).toBe(false);
      rejectTerminate?.();
      await dispose;
      await expect(restart).resolves.toBeInstanceOf(Error);
      expect(
        runCommandMock.mock.calls.some(([, args]) => args[1] === 'launch'),
      ).toBe(false);
    } finally {
      rejectTerminate?.();
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('rejects restart immediately after disposal', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-disposed-restart-'));
    try {
      await iosIdbAdapter.dispose();
      runCommandMock.mockClear();

      await expect(
        iosIdbAdapter.restartIosApp({ appPath, deviceId: 'device-1' }),
      ).rejects.toThrow('iOS preview is shutting down');
      expect(runCommandMock).not.toHaveBeenCalled();
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('launches an iOS app when terminate reports it is not running', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-restart-stopped-'));
    try {
      await writeFile(
        join(appPath, 'app.json'),
        JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.restart' } } }),
      );
      runCommandMock
        .mockRejectedValueOnce(
          new Error('An error was encountered: found nothing to terminate'),
        )
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      await expect(
        iosIdbAdapter.restartIosApp({ appPath, deviceId: 'device-1' }),
      ).resolves.toMatchObject({ bundleId: 'com.example.restart' });
      expect(runCommandMock).toHaveBeenLastCalledWith(
        'xcrun',
        ['simctl', 'launch', 'device-1', 'com.example.restart'],
        { signal: expect.any(AbortSignal) },
      );
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('does not launch after an unrecognized terminate failure', async () => {
    const appPath = await mkdtemp(join(tmpdir(), 'jc-ios-restart-error-'));
    try {
      await writeFile(
        join(appPath, 'app.json'),
        JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.example.restart' } } }),
      );
      runCommandMock.mockRejectedValue(new Error('Simulator unavailable'));

      await expect(
        iosIdbAdapter.restartIosApp({ appPath, deviceId: 'device-1' }),
      ).rejects.toThrow('Simulator unavailable');
      expect(runCommandMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('rejects unsafe iOS app status paths and simctl values', async () => {
    await expect(
      iosIdbAdapter.getIosAppStatus({ appPath: 'relative/app', deviceId: 'device-1' }),
    ).rejects.toThrow(/absolute/);
    await expect(
      iosIdbAdapter.getIosAppStatus({ appPath: '/trusted/app', deviceId: '-all' }),
    ).rejects.toThrow(/cannot start with '-'/);
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('maps iOS simctl devices and ignores non-iOS runtimes', () => {
    const devices = parseSimctlDevices(
      JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
            { name: 'iPhone 16', udid: 'ios-booted', state: 'Booted' },
            { name: 'iPhone SE', udid: 'ios-shutdown', state: 'Shutdown' },
            { name: 'iPad Unknown', udid: 'ios-unknown', state: 'Creating' },
          ],
          'com.apple.CoreSimulator.SimRuntime.tvOS-18-2': [
            { name: 'Apple TV', udid: 'tvos', state: 'Booted' },
          ],
        },
      }),
    );

    expect(devices).toEqual([
      {
        id: 'ios-booted',
        name: 'iPhone 16',
        platform: 'ios',
        state: 'booted',
        osVersion: 'iOS 18.2',
      },
      {
        id: 'ios-shutdown',
        name: 'iPhone SE',
        platform: 'ios',
        state: 'shutdown',
        osVersion: 'iOS 18.2',
      },
      {
        id: 'ios-unknown',
        name: 'iPad Unknown',
        platform: 'ios',
        state: 'unknown',
        osVersion: 'iOS 18.2',
      },
    ]);
  });

  it('parses available iOS runtimes newest first', () => {
    expect(
      parseSimctlRuntimes(`{
        "runtimes": [{
          "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-18-5",
          "name": "iOS 18.5",
          "version": "18.5",
          "platform": "iOS",
          "isAvailable": true
        }, {
          "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-18-10",
          "name": "iOS 18.10",
          "version": "18.10",
          "platform": "iOS",
          "isAvailable": true
        }, {
          "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
          "name": "iOS 17.0",
          "version": "17.0",
          "platform": "iOS",
          "isAvailable": false
        }, {
          "identifier": "com.apple.CoreSimulator.SimRuntime.watchOS-11-0",
          "name": "watchOS 11.0",
          "platform": "watchOS",
          "isAvailable": true
        }, {
          "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-Missing-Name",
          "platform": "iOS",
          "isAvailable": true
        }]
      }`),
    ).toEqual([
      {
        id: 'com.apple.CoreSimulator.SimRuntime.iOS-18-10',
        name: 'iOS 18.10',
        version: '18.10',
        platform: 'iOS',
        available: true,
      },
      {
        id: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5',
        name: 'iOS 18.5',
        version: '18.5',
        platform: 'iOS',
        available: true,
      },
      {
        id: 'com.apple.CoreSimulator.SimRuntime.iOS-17-0',
        name: 'iOS 17.0',
        version: '17.0',
        platform: 'iOS',
        available: false,
      },
    ]);
  });

  it('rejects invalid simctl runtimes JSON', () => {
    expect(() => parseSimctlRuntimes('{')).toThrow(
      /Invalid simctl runtimes JSON/,
    );
  });

  it('rejects invalid simctl runtimes root shape', () => {
    expect(() => parseSimctlRuntimes('{"devices": {}}')).toThrow(
      /expected root runtimes array/,
    );
  });

  it('parses iPhone simulator device types', () => {
    expect(
      parseSimctlDeviceTypes(`{
        "devicetypes": [{
          "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
          "name": "iPhone 16 Pro",
          "productFamily": "iPhone",
          "screen": { "width": 1179, "height": 2556 }
        }, {
          "identifier": "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4",
          "name": "iPad Pro 13-inch (M4)",
          "productFamily": "iPad"
        }, {
          "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-Missing-Name",
          "productFamily": "iPhone"
        }]
      }`),
    ).toEqual([
      {
        id: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro',
        name: 'iPhone 16 Pro',
        productFamily: 'iPhone',
        screen: { width: 1179, height: 2556 },
      },
    ]);
  });

  it('rejects invalid simctl device types JSON', () => {
    expect(() => parseSimctlDeviceTypes('{')).toThrow(
      /Invalid simctl device types JSON/,
    );
  });

  it('rejects invalid simctl device types root shape', () => {
    expect(() => parseSimctlDeviceTypes('{"runtimes": []}')).toThrow(
      /expected root devicetypes array/,
    );
  });

  it('reports iOS simctl tool status', async () => {
    runCommandMock.mockResolvedValue({ stdout: '/usr/bin/xcrun\n', stderr: '' });

    await expect(iosIdbAdapter.getIosToolStatus()).resolves.toEqual({
      xcrunPath: '/usr/bin/xcrun',
      missingTools: [],
    });
    expect(runCommandMock).toHaveBeenCalledWith('which', ['xcrun']);
  });

  it('reports missing xcrun in iOS tool status', async () => {
    commandExistsMock.mockResolvedValue(false);

    await expect(iosIdbAdapter.getIosToolStatus()).resolves.toEqual({
      xcrunPath: null,
      missingTools: ['xcrun'],
    });
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('lists iOS runtimes through simctl', async () => {
    runCommandMock.mockResolvedValue({
      stdout: JSON.stringify({
        runtimes: [
          {
            identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2',
            name: 'iOS 18.2',
            version: '18.2',
            platform: 'iOS',
            isAvailable: true,
          },
        ],
      }),
      stderr: '',
    });

    await expect(iosIdbAdapter.listIosRuntimes()).resolves.toEqual([
      {
        id: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2',
        name: 'iOS 18.2',
        version: '18.2',
        platform: 'iOS',
        available: true,
      },
    ]);
    expect(runCommandMock).toHaveBeenCalledWith('xcrun', [
      'simctl',
      'list',
      'runtimes',
      '--json',
    ]);
  });

  it('lists iOS device types through simctl', async () => {
    runCommandMock.mockResolvedValue({
      stdout: JSON.stringify({
        devicetypes: [
          {
            identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
            name: 'iPhone 16',
            productFamily: 'iPhone',
          },
        ],
      }),
      stderr: '',
    });

    await expect(iosIdbAdapter.listIosDeviceTypes()).resolves.toEqual([
      {
        id: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
        name: 'iPhone 16',
        productFamily: 'iPhone',
        screen: null,
      },
    ]);
    expect(runCommandMock).toHaveBeenCalledWith('xcrun', [
      'simctl',
      'list',
      'devicetypes',
      '--json',
    ]);
  });

  it('creates an iOS simulator through simctl and returns the UDID', async () => {
    runCommandMock.mockResolvedValue({
      stdout: '  12345678-1234-1234-1234-123456789abc\n',
      stderr: '',
    });

    await expect(
      iosIdbAdapter.createIosDevice({
        name: 'Jean-Claude iPhone',
        deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
        runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2',
      }),
    ).resolves.toBe('12345678-1234-1234-1234-123456789abc');

    expect(runCommandMock).toHaveBeenCalledWith('xcrun', [
      'simctl',
      'create',
      'Jean-Claude iPhone',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
      'com.apple.CoreSimulator.SimRuntime.iOS-18-2',
    ]);
  });

  it('rejects empty iOS simulator creation output', async () => {
    runCommandMock.mockResolvedValue({ stdout: '  \n', stderr: '' });

    await expect(
      iosIdbAdapter.createIosDevice({
        name: 'Jean-Claude iPhone',
        deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
        runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2',
      }),
    ).rejects.toThrow(/did not return a device id/);

    expect(runCommandMock).toHaveBeenCalledWith('xcrun', [
      'simctl',
      'create',
      'Jean-Claude iPhone',
      'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
      'com.apple.CoreSimulator.SimRuntime.iOS-18-2',
    ]);
  });

  it('deletes, erases, and renames iOS simulators through simctl', async () => {
    runCommandMock.mockResolvedValue({ stdout: '', stderr: '' });

    await iosIdbAdapter.deleteIosDevice('device-1');
    await iosIdbAdapter.eraseIosDevice('device-1');
    await iosIdbAdapter.renameIosDevice({
      deviceId: 'device-1',
      name: 'Jean-Claude iPhone Renamed',
    });

    expect(runCommandMock).toHaveBeenCalledWith('xcrun', [
      'simctl',
      'delete',
      'device-1',
    ]);
    expect(runCommandMock).toHaveBeenCalledWith('xcrun', [
      'simctl',
      'erase',
      'device-1',
    ]);
    expect(runCommandMock).toHaveBeenCalledWith('xcrun', [
      'simctl',
      'rename',
      'device-1',
      'Jean-Claude iPhone Renamed',
    ]);
  });

  it('rejects unsafe simctl values', async () => {
    await expect(
      iosIdbAdapter.deleteIosDevice('-delete-all'),
    ).rejects.toThrow(/cannot start with '-'/);
    await expect(
      iosIdbAdapter.createIosDevice({
        name: '',
        deviceTypeId: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
        runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2',
      }),
    ).rejects.toThrow(/is required/);
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('rejects simctl magic selectors for targeted iOS simulator actions', async () => {
    for (const selector of ['all', 'unavailable', 'booted', 'BOOTED']) {
      await expect(iosIdbAdapter.deleteIosDevice(selector)).rejects.toThrow(
        /cannot be a simctl selector/,
      );
      await expect(iosIdbAdapter.eraseIosDevice(selector)).rejects.toThrow(
        /cannot be a simctl selector/,
      );
      await expect(
        iosIdbAdapter.renameIosDevice({
          deviceId: selector,
          name: 'Jean-Claude iPhone Renamed',
        }),
      ).rejects.toThrow(/cannot be a simctl selector/);
    }

    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('emits complete MJPEG frames across chunk boundaries and noise', () => {
    const frames: Buffer[] = [];
    const parse = createMjpegFrameParser((frame) => frames.push(frame));
    const frameA = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
    const frameB = Buffer.from([0xff, 0xd8, 0x03, 0xff, 0xd9]);

    parse(Buffer.from([0x00, 0x11, 0xff]));
    parse(Buffer.from([0xd8, 0x01]));
    parse(Buffer.from([0x02, 0xff, 0xd9, 0x44, 0x55, 0xff, 0xd8]));
    parse(Buffer.from([0x03]));

    expect(frames).toEqual([frameA]);

    parse(Buffer.from([0xff, 0xd9]));

    expect(frames).toEqual([frameA, frameB]);
  });

  it('drops and resyncs oversized incomplete MJPEG frames', () => {
    const frames: Buffer[] = [];
    const parse = createMjpegFrameParser((frame) => frames.push(frame), {
      maxPendingBytes: 8,
    });
    const resyncedFrame = Buffer.from([0xff, 0xd8, 0x03, 0xff, 0xd9]);

    parse(
      Buffer.from([
        0xff, 0xd8, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0xff, 0xd8, 0x03,
        0xff, 0xd9,
      ]),
    );

    expect(frames).toEqual([resyncedFrame]);
  });

  it('exports a non-zero default MJPEG pending cap', () => {
    expect(MAX_MJPEG_PENDING_BYTES).toBeGreaterThan(0);
  });

  it('builds tap args', () => {
    expect(
      buildIdbInputArgs('device-1', { type: 'tap', x: 12, y: 34 }),
    ).toEqual(['ui', 'tap', '12', '34', '--udid', 'device-1']);
  });

  it('builds supported input args and rejects iOS back', () => {
    expect(
      buildIdbInputArgs('device-1', {
        type: 'swipe',
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        durationMs: 250,
      }),
    ).toEqual([
      'ui',
      'swipe',
      '1',
      '2',
      '3',
      '4',
      '--duration',
      '0.25',
      '--udid',
      'device-1',
    ]);
    expect(
      buildIdbInputArgs('device-1', {
        type: 'longPress',
        x: 12,
        y: 34,
        durationMs: 650,
      }),
    ).toEqual([
      'ui',
      'swipe',
      '12',
      '34',
      '12',
      '34',
      '--duration',
      '0.65',
      '--udid',
      'device-1',
    ]);
    expect(() =>
      buildIdbInputArgs('device-1', { type: 'text', text: 'hi' }),
    ).toThrow(/Simulator paste/);
    expect(buildIdbInputArgs('device-1', { type: 'key', key: 'home' })).toEqual(
      ['ui', 'button', 'HOME', '--udid', 'device-1'],
    );
    expect(
      buildIdbInputArgs('device-1', { type: 'key', key: 'enter' }),
    ).toEqual(['ui', 'key', '36', '--udid', 'device-1']);
    expect(() =>
      buildIdbInputArgs('device-1', { type: 'key', key: 'backspace' }),
    ).toThrow(/HID key events/);
    expect(() =>
      buildIdbInputArgs('device-1', { type: 'showKeyboard' }),
    ).toThrow(/Simulator keyboard shortcuts/);
    expect(() =>
      buildIdbInputArgs('device-1', { type: 'key', key: 'back' }),
    ).toThrow(/does not support back/i);
  });

  it('shows iOS software keyboard through Simulator shortcut', async () => {
    runCommandMock.mockResolvedValue({ stdout: '', stderr: '' });

    await iosIdbAdapter.sendInput('device-1', { type: 'showKeyboard' });

    expect(commandExistsMock).not.toHaveBeenCalledWith('idb');
    expect(runCommandMock).toHaveBeenCalledWith(
      'osascript',
      ['-e', expect.stringContaining('keystroke "k" using command down')],
      { signal: expect.any(AbortSignal), timeoutMs: 3000 },
    );
    expect(runCommandMock).not.toHaveBeenCalledWith('idb', expect.any(Array));
  });

  it('sends iOS text through Simulator paste to avoid keyboard layout remapping', async () => {
    runCommandMock.mockResolvedValue({ stdout: '', stderr: '' });

    await iosIdbAdapter.sendInput('device-1', { type: 'text', text: 'a' });

    expect(commandExistsMock).not.toHaveBeenCalledWith('idb');
    expect(runCommandMock).toHaveBeenCalledWith(
      'osascript',
      ['-e', expect.stringContaining('keystroke "v" using command down'), 'a'],
      { signal: expect.any(AbortSignal), timeoutMs: 3000 },
    );
    expect(runCommandMock).not.toHaveBeenCalledWith('idb', expect.any(Array));
  });

  it('serializes iOS text input to preserve character order and clipboard state', async () => {
    let finishFirstPaste: (() => void) | undefined;
    runCommandMock.mockImplementation(
      (_command, args) =>
        new Promise((resolve) => {
          if (args.at(-1) === 'a') {
            finishFirstPaste = () => resolve({ stdout: '', stderr: '' });
            return;
          }
          resolve({ stdout: '', stderr: '' });
        }),
    );

    const first = iosIdbAdapter.sendInput('device-1', { type: 'text', text: 'a' });
    const second = iosIdbAdapter.sendInput('device-1', { type: 'text', text: 'b' });
    await vi.waitFor(() => expect(finishFirstPaste).toBeTypeOf('function'));

    expect(runCommandMock).toHaveBeenCalledTimes(1);
    finishFirstPaste?.();
    await Promise.all([first, second]);
    expect(runCommandMock.mock.calls.map(([, args]) => args.at(-1))).toEqual([
      'a',
      'b',
    ]);
  });

  it('cancels queued keyboard input and drains active input during disposal', async () => {
    let releaseFirst: (() => void) | undefined;
    runCommandMock.mockImplementation(
      (_command, args) =>
        new Promise((resolve) => {
          if (args.at(-1) === 'a') {
            releaseFirst = () => resolve({ stdout: '', stderr: '' });
            return;
          }
          resolve({ stdout: '', stderr: '' });
        }),
    );

    const first = iosIdbAdapter.sendInput('device-1', { type: 'text', text: 'a' });
    const second = iosIdbAdapter.sendInput('device-1', { type: 'text', text: 'b' });
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
    let disposed = false;
    const dispose = iosIdbAdapter.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    releaseFirst?.();
    await Promise.all([first, second, dispose]);

    expect(runCommandMock).toHaveBeenCalledTimes(1);
  });

  it('registers accepted iOS keyboard input before same-tick disposal', async () => {
    const input = iosIdbAdapter
      .sendInput('device-race', { type: 'showKeyboard' })
      .catch((error: unknown) => error);

    await iosIdbAdapter.dispose();

    await expect(input).resolves.toMatchObject({ name: 'AbortError' });
    expect(commandExistsMock).not.toHaveBeenCalled();
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('rejects iOS input immediately after disposal without launching work', async () => {
    await iosIdbAdapter.dispose();
    commandExistsMock.mockClear();
    runCommandMock.mockClear();

    await expect(
      iosIdbAdapter.sendInput('device-disposed', { type: 'tap', x: 1, y: 2 }),
    ).rejects.toThrow('iOS preview is shutting down');
    expect(commandExistsMock).not.toHaveBeenCalled();
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('reports iOS cleanup stop failures after attempting every helper stop', async () => {
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    const helpers = ['device-cleanup-a', 'device-cleanup-b'].map((deviceId, index) => {
      const stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        kill: vi.fn(),
        pid: 700 + index,
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        stdout,
      });
      child.stdin.write = vi.fn(
        (_chunk, callback?: (error?: Error | null) => void) => {
          callback?.();
          return true;
        },
      ) as never;
      const stop =
        index === 0
          ? vi.fn().mockRejectedValue(new Error('first helper stop failed'))
          : vi.fn().mockResolvedValue(undefined);
      return { child, deviceId, stdout, stop };
    });
    spawnManagedMock
      .mockReturnValueOnce({ child: helpers[0].child as never, stop: helpers[0].stop })
      .mockReturnValueOnce({ child: helpers[1].child as never, stop: helpers[1].stop });

    const inputs = helpers.map((helper) =>
      iosIdbAdapter.sendInput(helper.deviceId, { type: 'key', key: 'backspace' }),
    );
    await vi.waitFor(() => expect(spawnManagedMock).toHaveBeenCalledTimes(1));
    helpers[0].stdout.write('READY\n');
    await vi.waitFor(() => expect(spawnManagedMock).toHaveBeenCalledTimes(2));
    helpers[1].stdout.write('READY\n');
    await Promise.all(inputs);

    await expect(iosIdbAdapter.dispose()).rejects.toThrow('first helper stop failed');
    expect(helpers[0].stop).toHaveBeenCalled();
    expect(helpers[1].stop).toHaveBeenCalled();
  });

  it('ignores empty iOS text input without requiring idb', async () => {
    await iosIdbAdapter.sendInput('device-1', { type: 'text', text: '' });

    expect(commandExistsMock).not.toHaveBeenCalledWith('idb');
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('sends iOS backspace through HID helper', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      pid: 123,
      stderr,
      stdin,
      stdout,
    });
    const stop = vi.fn(async () => {
      child.emit('close', 0, null);
    });
    const writes: string[] = [];
    stdin.write = vi.fn((chunk, callback?: (error?: Error | null) => void) => {
      writes.push(String(chunk));
      callback?.();
      return true;
    }) as never;
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    spawnManagedMock.mockReturnValue({
      child: child as never,
      stop,
    });
    runCommandMock.mockResolvedValue({ stdout: '', stderr: '' });

    const result = iosIdbAdapter.sendInput('device-1', {
      type: 'key',
      key: 'backspace',
    });
    stdout.write('READY\n');
    await result;

    expect(runCommandMock).not.toHaveBeenCalledWith('idb', expect.any(Array));
    expect(spawnManagedMock).toHaveBeenCalledWith('python3', [
      expect.stringContaining('mobile-preview-ios-hid-helper.py'),
      'device-1',
    ]);
    expect(writes.join('')).toBe(
      '{"type":"keyDown","keycode":42}\n{"type":"keyUp","keycode":42}\n',
    );
  });

  it('retries HID helper startup after readiness failure', async () => {
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    const helpers = Array.from({ length: 2 }, (_, index) => {
      const stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        kill: vi.fn(),
        pid: 123 + index,
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        stdout,
      });
      child.stdin.write = vi.fn(
        (_chunk, callback?: (error?: Error | null) => void) => {
          callback?.();
          return true;
        },
      ) as never;
      return {
        child,
        stop: vi.fn().mockResolvedValue(undefined),
        stdout,
      };
    });
    spawnManagedMock
      .mockReturnValueOnce({ child: helpers[0].child as never, stop: helpers[0].stop })
      .mockReturnValueOnce({ child: helpers[1].child as never, stop: helpers[1].stop });

    const first = iosIdbAdapter.sendInput('device-hid-retry', {
      type: 'key',
      key: 'backspace',
    });
    await vi.waitFor(() => expect(spawnManagedMock).toHaveBeenCalledTimes(1));
    helpers[0].child.emit('error', new Error('startup failed'));
    await expect(first).rejects.toThrow('startup failed');
    expect(helpers[0].stop).toHaveBeenCalledTimes(1);

    const second = iosIdbAdapter.sendInput('device-hid-retry', {
      type: 'key',
      key: 'backspace',
    });
    await vi.waitFor(() => expect(spawnManagedMock).toHaveBeenCalledTimes(2));
    helpers[1].stdout.write('READY\n');
    await expect(second).resolves.toBeUndefined();
  });

  it('lists devices without requiring idb', async () => {
    commandExistsMock.mockImplementation(
      async (command) => command === 'xcrun',
    );
    runCommandMock.mockResolvedValue({
      stdout: JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
            { name: 'iPhone 16', udid: 'ios-1', state: 'Booted' },
          ],
        },
      }),
      stderr: '',
    });

    await expect(iosIdbAdapter.listDevices()).resolves.toEqual([
      {
        id: 'ios-1',
        name: 'iPhone 16',
        platform: 'ios',
        state: 'booted',
        osVersion: 'iOS 18.2',
      },
    ]);
    expect(commandExistsMock).toHaveBeenCalledWith('xcrun');
    expect(commandExistsMock).not.toHaveBeenCalledWith('idb');
  });

  it('throws actionable missing xcrun error when listing devices', async () => {
    commandExistsMock.mockImplementation(async () => false);

    await expect(iosIdbAdapter.listDevices()).rejects.toThrow(
      /Missing required iOS preview tool: xcrun.*xcode-select --install/i,
    );
  });

  it('throws actionable missing idb error when sending input', async () => {
    commandExistsMock.mockImplementation(async (command) => command !== 'idb');

    await expect(
      iosIdbAdapter.sendInput('device-1', { type: 'tap', x: 12, y: 34 }),
    ).rejects.toThrow(
      /Missing required iOS preview tool: idb.*brew tap facebook\/fb.*fb-idb/i,
    );
    expect(runCommandMock).not.toHaveBeenCalledWith('idb', expect.any(Array));
  });

  it('lists devices from simctl JSON', async () => {
    runCommandMock.mockResolvedValue({
      stdout: JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
            { name: 'iPhone 16', udid: 'ios-1', state: 'Booted' },
          ],
        },
      }),
      stderr: '',
    });

    await expect(iosIdbAdapter.listDevices()).resolves.toEqual([
      {
        id: 'ios-1',
        name: 'iPhone 16',
        platform: 'ios',
        state: 'booted',
        osVersion: 'iOS 18.2',
      },
    ]);
    expect(runCommandMock).toHaveBeenCalledWith('xcrun', [
      'simctl',
      'list',
      'devices',
      '--json',
    ]);
  });

  it('sets iOS color scheme through simctl ui', async () => {
    await iosIdbAdapter.setColorScheme('device-1', 'dark');

    expect(runCommandMock).toHaveBeenCalledWith('xcrun', [
      'simctl',
      'ui',
      'device-1',
      'appearance',
      'dark',
    ]);
  });

  it('bounds iOS deeplink native command', async () => {
    runCommandMock.mockResolvedValue({ stdout: '', stderr: '' });

    await iosIdbAdapter.openDeeplink(
      'device-1',
      'exp://127.0.0.1:19001',
    );

    expect(runCommandMock).toHaveBeenCalledWith(
      'xcrun',
      ['simctl', 'openurl', 'device-1', 'exp://127.0.0.1:19001'],
      {
        signal: expect.any(AbortSignal),
        timeoutMs: MOBILE_PREVIEW_DEEPLINK_OPEN_TIMEOUT_MS,
      },
    );
  });

  it('aborts iOS native deeplink process from external launch cancellation', async () => {
    let nativeSignal: AbortSignal | undefined;
    let notifyNativeStarted!: () => void;
    const nativeStarted = new Promise<void>((resolve) => {
      notifyNativeStarted = resolve;
    });
    runCommandMock.mockImplementation(
      async (_command, _args, options) =>
        new Promise((_resolve, reject) => {
          nativeSignal = options?.signal;
          notifyNativeStarted();
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          );
        }),
    );
    const controller = new AbortController();

    const opening = iosIdbAdapter.openDeeplink(
      'device-1',
      'exp://127.0.0.1:19001',
      controller.signal,
    );
    const outcome = opening.catch((error: unknown) => error);
    await nativeStarted;
    controller.abort(new DOMException('cancelled', 'AbortError'));

    await expect(outcome).resolves.toMatchObject({ name: 'AbortError' });
    expect(nativeSignal?.aborted).toBe(true);
  });

  it('times out hung xcrun lookup and allows a later open', async () => {
    let lookupCount = 0;
    commandExistsMock.mockImplementation(async (_command, options) => {
      lookupCount += 1;
      if (lookupCount === 1) {
        return new Promise((_resolve, reject) => {
          const fallback = setTimeout(
            () => reject(new Error('xcrun lookup remained unbounded')),
            100,
          );
          options?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(fallback);
              reject(options.signal?.reason);
            },
            { once: true },
          );
        });
      }
      return true;
    });
    runCommandMock.mockResolvedValue({ stdout: '', stderr: '' });

    await expect(
      iosIdbAdapter.openDeeplink(
        'device-1',
        'exp://127.0.0.1:19001/first',
      ),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    await expect(
      iosIdbAdapter.openDeeplink(
        'device-1',
        'exp://127.0.0.1:19001/second',
      ),
    ).resolves.toBeUndefined();

    expect(commandExistsMock).toHaveBeenNthCalledWith(1, 'xcrun', {
      signal: expect.any(AbortSignal),
    });
    expect(lookupCount).toBe(2);
  });

  it('leaves iOS simulator rotation to renderer preview transform', async () => {
    await iosIdbAdapter.rotate('device-1', 'left');

    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('throws contextual error for invalid simctl JSON root', () => {
    expect(() => parseSimctlDevices(JSON.stringify({ devices: [] }))).toThrow(
      /Invalid simctl devices JSON: expected root devices object/,
    );
  });

  it('scales tap coordinates from preview pixels to iOS points', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'idb' && args[0] === 'describe') {
        return {
          stdout: JSON.stringify({
            screen_dimensions: {
              width: 1206,
              height: 2622,
              density: 3,
              width_points: 402,
              height_points: 874,
            },
          }),
          stderr: '',
        };
      }

      return { stdout: '', stderr: '' };
    });

    await iosIdbAdapter.sendInput('device-1', { type: 'tap', x: 12, y: 34 });

    expect(runCommandMock).toHaveBeenCalledWith('idb', [
      'ui',
      'tap',
      '4',
      '11',
      '--udid',
      'device-1',
    ], { signal: expect.any(AbortSignal) });
  });

  it('scales swipe coordinates from preview pixels to iOS points', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'idb' && args[0] === 'describe') {
        return {
          stdout: JSON.stringify({
            screen_dimensions: {
              width: 1206,
              height: 2622,
              density: 3,
              width_points: 402,
              height_points: 874,
            },
          }),
          stderr: '',
        };
      }

      return { stdout: '', stderr: '' };
    });

    await iosIdbAdapter.sendInput('device-2', {
      type: 'swipe',
      x1: 600,
      y1: 900,
      x2: 900,
      y2: 1200,
      durationMs: 250,
    });

    expect(runCommandMock).toHaveBeenCalledWith('idb', [
      'ui',
      'swipe',
      '200',
      '300',
      '300',
      '400',
      '--duration',
      '0.25',
      '--udid',
      'device-2',
    ], { signal: expect.any(AbortSignal) });
  });

  it('scales HID touch lifecycle coordinates from pixels to points', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'idb' && args[0] === 'describe') {
        return {
          stdout: JSON.stringify({
            screen_dimensions: {
              width: 1206,
              height: 2622,
              density: 3,
              width_points: 402,
              height_points: 874,
            },
          }),
          stderr: '',
        };
      }

      return { stdout: '', stderr: '' };
    });
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    const { writes } = mockReadyHidHelper();

    await iosIdbAdapter.sendInput('device-hid-scale', {
      type: 'touchDown',
      x: 600,
      y: 900,
    });

    expect(writes).toEqual([
      `${JSON.stringify({ type: 'touchDown', x: 200, y: 300 })}\n`,
    ]);
  });

  it('serializes cold-start HID touch lifecycle events', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'idb' && args[0] === 'describe') {
        return {
          stdout: JSON.stringify({
            screen_dimensions: {
              width: 400,
              height: 800,
              width_points: 400,
              height_points: 800,
            },
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    const { writes } = mockReadyHidHelper();

    await Promise.all([
      iosIdbAdapter.sendInput('device-touch-order', {
        type: 'touchDown',
        x: 10,
        y: 20,
      }),
      iosIdbAdapter.sendInput('device-touch-order', {
        type: 'touchMove',
        x: 20,
        y: 30,
      }),
      iosIdbAdapter.sendInput('device-touch-order', {
        type: 'touchUp',
        x: 30,
        y: 40,
      }),
    ]);

    expect(spawnManagedMock).toHaveBeenCalledTimes(1);
    expect(writes.map((write) => JSON.parse(write.trim()).type)).toEqual([
      'touchDown',
      'touchMove',
      'touchUp',
    ]);
  });

  it('cancels queued iOS touch work and drains active work during disposal', async () => {
    let releaseDescribe: (() => void) | undefined;
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'idb' && args[0] === 'describe') {
        await new Promise<void>((resolve) => {
          releaseDescribe = resolve;
        });
        return {
          stdout: JSON.stringify({
            screen_dimensions: {
              width: 400,
              height: 800,
              width_points: 400,
              height_points: 800,
            },
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );

    const first = iosIdbAdapter.sendInput('device-touch-dispose', {
      type: 'touchDown',
      x: 1,
      y: 2,
    });
    const second = iosIdbAdapter.sendInput('device-touch-dispose', {
      type: 'touchMove',
      x: 3,
      y: 4,
    });
    await vi.waitFor(() => expect(releaseDescribe).toBeTypeOf('function'));
    let disposed = false;
    const dispose = iosIdbAdapter.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    releaseDescribe?.();
    await Promise.all([first, second, dispose]);

    expect(runCommandMock.mock.calls).toEqual([
      ['idb', ['describe', '--udid', 'device-touch-dispose', '--json']],
    ]);
    expect(spawnManagedMock).not.toHaveBeenCalled();
  });

  it('sends compensating iOS touch up for an established down during disposal', async () => {
    mockSimctlCommands('Booted');
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    const { writes } = mockReadyHidHelper();
    const stream = await iosIdbAdapter.startStream({
      taskId: 'task-touch-dispose',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'idb' && args[0] === 'describe') {
        return {
          stdout: JSON.stringify({
            screen_dimensions: {
              width: 400,
              height: 800,
              width_points: 400,
              height_points: 800,
            },
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    await iosIdbAdapter.sendInput(
      'device-1',
      { type: 'touchDown', x: 10, y: 20 },
      stream.session.id,
    );

    await iosIdbAdapter.dispose();

    expect(writes.map((write) => JSON.parse(write.trim()))).toEqual([
      { type: 'touchDown', x: 10, y: 20 },
      { type: 'touchUp', x: 10, y: 20 },
    ]);
  });

  it('orders disposal touch up after an in-flight iOS down write', async () => {
    mockSimctlCommands('Booted');
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    const { stdin, writes } = mockReadyHidHelper();
    const stream = await iosIdbAdapter.startStream({
      taskId: 'task-touch-write-race',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'idb' && args[0] === 'describe') {
        return {
          stdout: JSON.stringify({
            screen_dimensions: {
              width: 400,
              height: 800,
              width_points: 400,
              height_points: 800,
            },
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    let releaseDownWrite: (() => void) | undefined;
    stdin.write = vi.fn((chunk, callback?: (error?: Error | null) => void) => {
      writes.push(String(chunk));
      if (String(chunk).includes('touchDown')) {
        releaseDownWrite = () => callback?.();
      } else {
        callback?.();
      }
      return true;
    }) as never;
    const down = iosIdbAdapter.sendInput(
      'device-1',
      { type: 'touchDown', x: 10, y: 20 },
      stream.session.id,
    );
    await vi.waitFor(() => expect(releaseDownWrite).toBeTypeOf('function'));

    let disposed = false;
    const dispose = iosIdbAdapter.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(writes.map((write) => JSON.parse(write.trim()).type)).toEqual([
      'touchDown',
    ]);

    releaseDownWrite?.();
    await Promise.all([down, dispose]);
    expect(writes.map((write) => JSON.parse(write.trim()).type)).toEqual([
      'touchDown',
      'touchUp',
    ]);
    expect(getIosActiveTouchSessionForTests('device-1')).toBeNull();
  });

  it.each([
    { name: 'tap', event: { type: 'tap' as const, x: 10, y: 20 } },
    {
      name: 'swipe',
      event: {
        type: 'swipe' as const,
        x1: 10,
        y1: 20,
        x2: 30,
        y2: 40,
        durationMs: 100,
      },
    },
  ])('does not launch stale iOS $name input after async coordinate setup', async ({ event }) => {
    mockSimctlCommands('Booted');
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    mockReadyHidHelper();
    const first = await iosIdbAdapter.startStream({
      taskId: 'task-ios-stale-a',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    const second = await iosIdbAdapter.startStream({
      taskId: 'task-ios-stale-b',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    let releaseDescribe: (() => void) | undefined;
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'idb' && args[0] === 'describe') {
        await new Promise<void>((resolve) => {
          releaseDescribe = resolve;
        });
        return {
          stdout: JSON.stringify({
            screen_dimensions: {
              width: 400,
              height: 800,
              width_points: 400,
              height_points: 800,
            },
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    const stale = iosIdbAdapter.sendInput('device-1', event, first.session.id);
    await vi.waitFor(() => expect(releaseDescribe).toBeTypeOf('function'));
    const stopFirst = first.stop();
    releaseDescribe?.();
    await Promise.all([stopFirst, stale]);

    expect(
      runCommandMock.mock.calls.some(
        ([command, args]) => command === 'idb' && args[0] === 'ui',
      ),
    ).toBe(false);
    await iosIdbAdapter.sendInput('device-1', event, second.session.id);
    expect(runCommandMock).toHaveBeenCalledWith(
      'idb',
      expect.arrayContaining(['ui', event.type]),
      { signal: expect.any(AbortSignal) },
    );
    await second.stop();
  });

  it('aborts only the stopped session in-flight iOS tap', async () => {
    mockSimctlCommands('Booted');
    const first = await iosIdbAdapter.startStream({
      taskId: 'task-input-a',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    const second = await iosIdbAdapter.startStream({
      taskId: 'task-input-b',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    let firstSignal: AbortSignal | undefined;
    let secondSignal: AbortSignal | undefined;
    let rejectFirstClose: (() => void) | undefined;
    runCommandMock.mockImplementation((_command, args, options) => {
      if (args[0] === 'describe') {
        return Promise.resolve({
          stdout: JSON.stringify({
            screen_dimensions: {
              width: 400,
              height: 800,
              width_points: 400,
              height_points: 800,
            },
          }),
          stderr: '',
        });
      }
      if (args.includes('tap')) {
        firstSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          rejectFirstClose = () => reject(new Error('tap aborted after close'));
        });
      }
      if (args.includes('swipe')) secondSignal = options?.signal;
      return Promise.resolve({ stdout: '', stderr: '' });
    });
    const firstInput = iosIdbAdapter
      .sendInput(
        'device-1',
        { type: 'tap', x: 1, y: 2 },
        first.session.id,
      )
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(firstSignal).toBeDefined());
    await iosIdbAdapter.sendInput(
      'device-1',
      { type: 'swipe', x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 100 },
      second.session.id,
    );

    let stopped = false;
    const stopFirst = first.stop().then(() => {
      stopped = true;
    });
    await vi.waitFor(() => expect(firstSignal?.aborted).toBe(true));
    expect(secondSignal?.aborted).toBe(false);
    expect(stopped).toBe(false);
    rejectFirstClose?.();
    await Promise.all([firstInput, stopFirst]);
    await second.stop();
  });

  it('aborts and awaits an in-flight iOS swipe during disposal', async () => {
    let swipeSignal: AbortSignal | undefined;
    let rejectSwipeClose: (() => void) | undefined;
    runCommandMock.mockImplementation((_command, args, options) => {
      if (args[0] === 'describe') {
        return Promise.resolve({
          stdout: JSON.stringify({
            screen_dimensions: {
              width: 400,
              height: 800,
              width_points: 400,
              height_points: 800,
            },
          }),
          stderr: '',
        });
      }
      swipeSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        rejectSwipeClose = () => reject(new Error('swipe aborted after close'));
      });
    });
    const input = iosIdbAdapter
      .sendInput('device-swipe', {
        type: 'swipe',
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        durationMs: 100,
      })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(swipeSignal).toBeDefined());

    let disposed = false;
    const dispose = iosIdbAdapter.dispose().then(() => {
      disposed = true;
    });
    await vi.waitFor(() => expect(swipeSignal?.aborted).toBe(true));
    expect(disposed).toBe(false);
    rejectSwipeClose?.();
    await Promise.all([input, dispose]);
  });

  it('revalidates iOS backspace before HID write for shared-device sessions', async () => {
    mockSimctlCommands('Booted');
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    const { writes } = mockReadyHidHelper();
    const first = await iosIdbAdapter.startStream({
      taskId: 'task-ios-key-a',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    const second = await iosIdbAdapter.startStream({
      taskId: 'task-ios-key-b',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    let releaseIdbCheck: (() => void) | undefined;
    commandExistsMock.mockImplementation(async (command) => {
      if (command === 'idb') {
        await new Promise<void>((resolve) => {
          releaseIdbCheck = resolve;
        });
      }
      return true;
    });
    const stale = iosIdbAdapter.sendInput(
      'device-1',
      { type: 'key', key: 'backspace' },
      first.session.id,
    );
    await vi.waitFor(() => expect(releaseIdbCheck).toBeTypeOf('function'));
    const stopFirst = first.stop();
    releaseIdbCheck?.();
    await Promise.all([stopFirst, stale]);
    expect(writes).toEqual([]);

    commandExistsMock.mockResolvedValue(true);
    await iosIdbAdapter.sendInput(
      'device-1',
      { type: 'key', key: 'backspace' },
      second.session.id,
    );
    expect(writes.join('')).toContain('"type":"keyDown"');
    await second.stop();
  });

  it('sends a compensating iOS touch up before another shared-device gesture', async () => {
    mockSimctlCommands('Booted');
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    const { writes } = mockReadyHidHelper();
    const first = await iosIdbAdapter.startStream({
      taskId: 'task-ios-touch-a',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    const second = await iosIdbAdapter.startStream({
      taskId: 'task-ios-touch-b',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'idb' && args[0] === 'describe') {
        return {
          stdout: JSON.stringify({
            screen_dimensions: {
              width: 400,
              height: 800,
              width_points: 400,
              height_points: 800,
            },
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    await iosIdbAdapter.sendInput(
      'device-1',
      { type: 'touchDown', x: 10, y: 20 },
      first.session.id,
    );
    await first.stop();
    await iosIdbAdapter.sendInput(
      'device-1',
      { type: 'touchDown', x: 30, y: 40 },
      second.session.id,
    );
    await iosIdbAdapter.sendInput(
      'device-1',
      { type: 'touchUp', x: 50, y: 60 },
      second.session.id,
    );

    expect(writes.map((write) => JSON.parse(write.trim()))).toEqual([
      { type: 'touchDown', x: 10, y: 20 },
      { type: 'touchUp', x: 10, y: 20 },
      { type: 'touchDown', x: 30, y: 40 },
      { type: 'touchUp', x: 50, y: 60 },
    ]);
    await second.stop();
  });

  it('does not write stale queued iOS touch after shared-session cancellation', async () => {
    mockSimctlCommands('Booted');
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    const { writes } = mockReadyHidHelper();
    const first = await iosIdbAdapter.startStream({
      taskId: 'task-ios-stale-touch-a',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    const second = await iosIdbAdapter.startStream({
      taskId: 'task-ios-stale-touch-b',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    let releaseDescribe: (() => void) | undefined;
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'idb' && args[0] === 'describe') {
        await new Promise<void>((resolve) => {
          releaseDescribe = resolve;
        });
        return {
          stdout: JSON.stringify({
            screen_dimensions: {
              width: 400,
              height: 800,
              width_points: 400,
              height_points: 800,
            },
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    const stale = iosIdbAdapter.sendInput(
      'device-1',
      { type: 'touchDown', x: 10, y: 20 },
      first.session.id,
    );
    await vi.waitFor(() => expect(releaseDescribe).toBeTypeOf('function'));
    const stopFirst = first.stop();
    releaseDescribe?.();
    await Promise.all([stale, stopFirst]);
    expect(writes).toEqual([]);

    await iosIdbAdapter.sendInput(
      'device-1',
      { type: 'touchDown', x: 30, y: 40 },
      second.session.id,
    );
    await iosIdbAdapter.sendInput(
      'device-1',
      { type: 'touchUp', x: 50, y: 60 },
      second.session.id,
    );
    expect(writes.map((write) => JSON.parse(write.trim()).type)).toEqual([
      'touchDown',
      'touchUp',
    ]);
    await second.stop();
  });

  it('clears fallback-only iOS gesture ownership on session cancellation', async () => {
    mockSimctlCommands('Booted');
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    const { stdin } = mockReadyHidHelper();
    stdin.write = vi.fn((_chunk, callback?: (error?: Error | null) => void) => {
      callback?.(new Error('HID unavailable'));
      return true;
    }) as never;
    const first = await iosIdbAdapter.startStream({
      taskId: 'task-ios-fallback-owner-a',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    const second = await iosIdbAdapter.startStream({
      taskId: 'task-ios-fallback-owner-b',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'idb' && args[0] === 'describe') {
        return {
          stdout: JSON.stringify({
            screen_dimensions: {
              width: 400,
              height: 800,
              width_points: 400,
              height_points: 800,
            },
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    await iosIdbAdapter.sendInput(
      'device-1',
      { type: 'touchDown', x: 10, y: 20 },
      first.session.id,
    );
    expect(getIosFallbackTouchSessionForTests('device-1')).toBe(first.session.id);

    await first.stop();

    expect(getIosFallbackTouchSessionForTests('device-1')).toBeNull();
    await second.stop();
  });

  it('retains iOS HID ownership when compensating UP fails so takeover retries it', async () => {
    mockSimctlCommands('Booted');
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    const { stdin, writes } = mockReadyHidHelper();
    let failNextUp = true;
    stdin.write = vi.fn((chunk, callback?: (error?: Error | null) => void) => {
      const event = JSON.parse(String(chunk).trim()) as { type: string };
      writes.push(String(chunk));
      if (event.type === 'touchUp' && failNextUp) {
        failNextUp = false;
        callback?.(new Error('UP failed'));
      } else {
        callback?.();
      }
      return true;
    }) as never;
    const first = await iosIdbAdapter.startStream({
      taskId: 'task-ios-up-retry-a',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    const second = await iosIdbAdapter.startStream({
      taskId: 'task-ios-up-retry-b',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'idb' && args[0] === 'describe') {
        return {
          stdout: JSON.stringify({
            screen_dimensions: {
              width: 400,
              height: 800,
              width_points: 400,
              height_points: 800,
            },
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    await iosIdbAdapter.sendInput(
      'device-1',
      { type: 'touchDown', x: 10, y: 20 },
      first.session.id,
    );
    await first.stop();
    await iosIdbAdapter.sendInput(
      'device-1',
      { type: 'touchDown', x: 30, y: 40 },
      second.session.id,
    );

    expect(writes.map((write) => JSON.parse(write.trim()).type)).toEqual([
      'touchDown',
      'touchUp',
      'touchUp',
      'touchDown',
    ]);
    await second.stop();
  });

  it('blocks iOS takeover DOWN until old-owner compensation succeeds', async () => {
    mockSimctlCommands('Booted');
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    const { stdin, writes } = mockReadyHidHelper();
    let failNextUp = true;
    stdin.write = vi.fn((chunk, callback?: (error?: Error | null) => void) => {
      const event = JSON.parse(String(chunk).trim()) as { type: string };
      writes.push(String(chunk));
      if (event.type === 'touchUp' && failNextUp) {
        failNextUp = false;
        callback?.(new Error('UP failed'));
      } else {
        callback?.();
      }
      return true;
    }) as never;
    const first = await iosIdbAdapter.startStream({
      taskId: 'task-ios-takeover-fail-a',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    const second = await iosIdbAdapter.startStream({
      taskId: 'task-ios-takeover-fail-b',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'idb' && args[0] === 'describe') {
        return {
          stdout: JSON.stringify({
            screen_dimensions: {
              width: 400,
              height: 800,
              width_points: 400,
              height_points: 800,
            },
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    await iosIdbAdapter.sendInput(
      'device-1',
      { type: 'touchDown', x: 10, y: 20 },
      first.session.id,
    );
    await iosIdbAdapter.sendInput(
      'device-1',
      { type: 'touchDown', x: 30, y: 40 },
      second.session.id,
    );
    expect(writes.map((write) => JSON.parse(write.trim()).type)).toEqual([
      'touchDown',
      'touchUp',
    ]);

    await iosIdbAdapter.sendInput(
      'device-1',
      { type: 'touchDown', x: 30, y: 40 },
      second.session.id,
    );
    expect(writes.map((write) => JSON.parse(write.trim()).type)).toEqual([
      'touchDown',
      'touchUp',
      'touchUp',
      'touchDown',
    ]);
    await Promise.all([first.stop(), second.stop()]);
  });

  it('drops non-owner iOS MOVE and UP without releasing current owner', async () => {
    mockSimctlCommands('Booted');
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    const { writes } = mockReadyHidHelper();
    const first = await iosIdbAdapter.startStream({
      taskId: 'task-ios-owner-a',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    const second = await iosIdbAdapter.startStream({
      taskId: 'task-ios-owner-b',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'idb' && args[0] === 'describe') {
        return {
          stdout: JSON.stringify({
            screen_dimensions: {
              width: 400,
              height: 800,
              width_points: 400,
              height_points: 800,
            },
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });
    await iosIdbAdapter.sendInput(
      'device-1',
      { type: 'touchDown', x: 10, y: 20 },
      first.session.id,
    );
    await iosIdbAdapter.sendInput(
      'device-1',
      { type: 'touchMove', x: 30, y: 40 },
      second.session.id,
    );
    await iosIdbAdapter.sendInput(
      'device-1',
      { type: 'touchUp', x: 50, y: 60 },
      second.session.id,
    );
    expect(writes.map((write) => JSON.parse(write.trim()).type)).toEqual([
      'touchDown',
    ]);

    await iosIdbAdapter.sendInput(
      'device-1',
      { type: 'touchUp', x: 70, y: 80 },
      first.session.id,
    );
    expect(writes.map((write) => JSON.parse(write.trim()).type)).toEqual([
      'touchDown',
      'touchUp',
    ]);
    await Promise.all([first.stop(), second.stop()]);
  });

  it('validates device IDs and finite input values', () => {
    expect(() => buildIdbInputArgs('', { type: 'tap', x: 12, y: 34 })).toThrow(
      /deviceId is required/,
    );
    expect(() =>
      buildIdbInputArgs('device-1', { type: 'tap', x: Number.NaN, y: 34 }),
    ).toThrow(/finite number/);
  });

  it('rejects invalid IPC input event payloads', () => {
    expect(() => buildIdbInputArgs('device-1', { type: 'drag' })).toThrow(
      /Unsupported iOS input event type: drag/,
    );
    expect(() =>
      buildIdbInputArgs('device-1', { type: 'text', text: 123 }),
    ).toThrow(/expected text string/);
    expect(() =>
      buildIdbInputArgs('device-1', { type: 'key', key: 'escape' }),
    ).toThrow(/Unsupported iOS key input: escape/);
  });

  it('boots shutdown devices and starts simctl screenshot stream', async () => {
    mockSimctlCommands('Shutdown');
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    mockReadyHidHelper();

    const onFrame = vi.fn();
    const onSession = vi.fn();
    const result = await iosIdbAdapter.startStream({
      taskId: 'task-1',
      deviceId: 'device-1',
      onFrame,
      onSession,
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      'xcrun',
      ['simctl', 'boot', 'device-1'],
      { signal: expect.any(AbortSignal) },
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      'xcrun',
      ['simctl', 'bootstatus', 'device-1', '-b'],
      { signal: expect.any(AbortSignal) },
    );
    expect(runCommandMock).not.toHaveBeenCalledWith('idb', ['list-targets'], {
      timeoutMs: 5_000,
    });
    expect(minimizeMobilePreviewWindowsMock).toHaveBeenCalledWith({
      processNames: ['Simulator'],
      windowNameIncludes: ['iPhone 16'],
    });
    expect(
      spawnManagedMock.mock.calls.some(([command]) =>
        command.includes('mobile-preview-ios-framebuffer'),
      ),
    ).toBe(false);
    expect(result.session).toMatchObject({
      taskId: 'task-1',
      deviceId: 'device-1',
      platform: 'ios',
      status: 'streaming',
      width: 2,
      height: 2,
      frameFormat: 'mjpeg',
      streamStrategy: 'simctl-screenshot',
      inputStatus: 'starting',
      error: null,
    });

    await vi.waitFor(() => expect(onFrame).toHaveBeenCalled());
    expect(onSession).toHaveBeenCalledWith({ inputStatus: 'ready' });

    await result.stop();
  });

  it('marks iOS input as errored when HID helper prewarm fails', async () => {
    mockSimctlCommands('Booted');
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      pid: 123,
      stderr,
      stdin: new PassThrough(),
      stdout,
    });
    spawnManagedMock.mockReturnValue({
      child: child as never,
      stop: vi.fn().mockResolvedValue(undefined),
    });

    const onSession = vi.fn();
    const result = await iosIdbAdapter.startStream({
      taskId: 'task-1',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession,
    });
    child.emit('close', 1, null);

    await vi.waitFor(() => {
      expect(onSession).toHaveBeenCalledWith({ inputStatus: 'error' });
    });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'idb' && args[0] === 'describe') {
        return {
          stdout: JSON.stringify({
            screen_dimensions: {
              width: 1206,
              height: 2622,
              density: 3,
              width_points: 402,
              height_points: 874,
            },
          }),
          stderr: '',
        };
      }

      if (command === 'idb' && args[0] === 'ui') {
        return { stdout: '', stderr: '' };
      }

      return { stdout: '', stderr: '' };
    });

    await iosIdbAdapter.sendInput('device-1', { type: 'tap', x: 12, y: 34 });

    expect(runCommandMock).toHaveBeenCalledWith('idb', [
      'ui',
      'tap',
      '4',
      '11',
      '--udid',
      'device-1',
    ], { signal: expect.any(AbortSignal) });

    await result.stop();
  });

  it('uses simctl screenshot dimensions for screenshot stream', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (
        command === 'xcrun' &&
        args[0] === 'simctl' &&
        args[1] === 'io' &&
        args[3] === 'screenshot'
      ) {
        const screenshotPath = args.at(-1)!;
        await mkdir(dirname(screenshotPath), { recursive: true });
        await writeFile(screenshotPath, pngWithSize(2, 2));
        return { stdout: '', stderr: '' };
      }

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
    });

    const onFrame = vi.fn();
    const result = await iosIdbAdapter.startStream({
      taskId: 'task-1',
      deviceId: 'device-1',
      onFrame,
      onSession: vi.fn(),
    });

    expect(result.session).toMatchObject({
      width: 2,
      height: 2,
      frameFormat: 'mjpeg',
      streamStrategy: 'simctl-screenshot',
    });
    await vi.waitFor(() => expect(onFrame).toHaveBeenCalled());
    expect(spawnManagedMock).not.toHaveBeenCalled();

    await result.stop();
  });

  it('does not emit an in-flight screenshot after stop', async () => {
    let screenshotCallCount = 0;
    let resolveInFlightCapture: (() => void) | undefined;
    runCommandMock.mockImplementation(async (command, args) => {
      if (
        command === 'xcrun' &&
        args[0] === 'simctl' &&
        args[1] === 'io' &&
        args[3] === 'screenshot'
      ) {
        screenshotCallCount += 1;
        if (screenshotCallCount === 2) {
          await new Promise<void>((resolve) => {
            resolveInFlightCapture = resolve;
          });
        }
        const screenshotPath = args.at(-1)!;
        await mkdir(dirname(screenshotPath), { recursive: true });
        await writeFile(screenshotPath, pngWithSize(2, 2));
        return { stdout: '', stderr: '' };
      }
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
    });
    const onFrame = vi.fn();
    const stream = await iosIdbAdapter.startStream({
      taskId: 'task-1',
      deviceId: 'device-1',
      onFrame,
      onSession: vi.fn(),
    });
    await vi.waitFor(() => expect(screenshotCallCount).toBe(2));

    const stopPromise = stream.stop();
    resolveInFlightCapture?.();
    await stopPromise;

    expect(onFrame).not.toHaveBeenCalled();
  });

  it('bounds every simctl screenshot capture command', async () => {
    mockSimctlCommands('Booted');
    const stream = await iosIdbAdapter.startStream({
      taskId: 'task-timeout',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    await vi.waitFor(() =>
      expect(runCommandMock).toHaveBeenCalledWith(
        'xcrun',
        expect.arrayContaining(['simctl', 'io', 'device-1', 'screenshot']),
        { timeoutMs: 5000 },
      ),
    );
    await stream.stop();
  });

  it('stops direct screenshot polling during adapter disposal', async () => {
    vi.useFakeTimers();
    mockSimctlCommands('Booted');
    const onFrame = vi.fn();
    await iosIdbAdapter.startStream({
      taskId: 'task-1',
      deviceId: 'device-1',
      onFrame,
      onSession: vi.fn(),
    });
    await vi.runOnlyPendingTimersAsync();

    await iosIdbAdapter.dispose();
    const frameCountAfterDispose = onFrame.mock.calls.length;
    await vi.advanceTimersByTimeAsync(SCREENSHOT_POLL_INTERVAL_MS * 2);

    expect(onFrame).toHaveBeenCalledTimes(frameCountAfterDispose);
  });

  it('uses CoreSimulator framebuffer helper by default when available', async () => {
    delete process.env.JC_MOBILE_PREVIEW_IOS_CORE_SIMULATOR;
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      process.cwd(),
      'electron/native/mobile-preview-ios-framebuffer.m',
    );
    const jpegFrame = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      pid: 123,
      stderr,
      stdout,
    });
    const stop = vi.fn(async () => {
      child.emit('close', 0, null);
    });

    mockFramebufferWithReadyHid({
      child: child as never,
      stop,
    });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'which') {
        return { stdout: `/usr/bin/${args[0]}`, stderr: '' };
      }
      if (command === 'idb') {
        throw new Error('idb unavailable');
      }
      if (command === 'xcrun' && args[0] === 'clang') {
        return { stdout: '', stderr: '' };
      }
      if (command === 'xcode-select') {
        return {
          stdout: '/Applications/Xcode-beta.app/Contents/Developer\n',
          stderr: '',
        };
      }
      if (
        command === 'xcrun' &&
        args[0] === 'simctl' &&
        args[1] === 'io' &&
        args[3] === 'screenshot'
      ) {
        const screenshotPath = args.at(-1)!;
        await mkdir(dirname(screenshotPath), { recursive: true });
        await writeFile(screenshotPath, pngWithSize(1206, 2622));
        return { stdout: '', stderr: '' };
      }

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
    });

    const onFrame = vi.fn();
    const result = await iosIdbAdapter.startStream({
      taskId: 'task-1',
      deviceId: 'device-1',
      onFrame,
      onSession: vi.fn(),
    });

    expect(result.session).toMatchObject({
      width: null,
      height: null,
      frameFormat: 'mjpeg',
      streamStrategy: 'coresimulator-framebuffer',
    });
    expect(runCommandMock).toHaveBeenCalledWith(
      'xcrun',
      expect.arrayContaining(['clang']),
      {
        signal: expect.any(AbortSignal),
        timeoutMs: 20_000,
      },
    );
    expect(spawnManagedMock).toHaveBeenCalledWith(
      expect.stringContaining('mobile-preview-ios-framebuffer'),
      [
        'device-1',
        '30',
        '0.9',
        '/Applications/Xcode-beta.app/Contents/Developer',
      ],
      { signal: expect.any(AbortSignal) },
    );

    stdout.write(jpegFrame);
    expect(onFrame).toHaveBeenCalledWith(jpegFrame);
    expect(child.kill).not.toHaveBeenCalledWith('SIGUSR2');

    await result.stop();
    await result.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGUSR1');
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it('drains bounded stderr from a pooled CoreSimulator framebuffer helper', async () => {
    delete process.env.JC_MOBILE_PREVIEW_IOS_CORE_SIMULATOR;
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      process.cwd(),
      'electron/native/mobile-preview-ios-framebuffer.m',
    );
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      pid: 123,
      stderr,
      stdout: new PassThrough(),
    });
    mockFramebufferWithReadyHid({
      child: child as never,
      stop: vi.fn().mockResolvedValue(undefined),
    });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'xcrun' && args[0] === 'clang') return { stdout: '', stderr: '' };
      if (command === 'xcode-select') {
        return { stdout: '/Applications/Xcode.app/Contents/Developer\n', stderr: '' };
      }
      if (command === 'xcrun' && args[0] === 'simctl' && args[1] === 'io') {
        const screenshotPath = args.at(-1)!;
        await mkdir(dirname(screenshotPath), { recursive: true });
        await writeFile(screenshotPath, pngWithSize(2, 2));
        return { stdout: '', stderr: '' };
      }
      return {
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
              { name: 'iPhone 16', udid: 'device-stderr', state: 'Booted' },
            ],
          },
        }),
        stderr: '',
      };
    });
    const onSession = vi.fn();
    const stream = await iosIdbAdapter.startStream({
      taskId: 'task-stderr',
      deviceId: 'device-stderr',
      onFrame: vi.fn(),
      onSession,
    });

    expect(stderr.listenerCount('data')).toBeGreaterThan(0);
    stderr.write(`discarded-prefix-${'x'.repeat(10_000)}-bounded-tail`);
    child.emit('close', 1, null);
    await vi.waitFor(() =>
      expect(onSession).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('bounded-tail') }),
      ),
    );
    const fallbackError = onSession.mock.calls.find(
      ([patch]) => typeof patch.error === 'string' && patch.error.includes('bounded-tail'),
    )?.[0].error;
    expect(fallbackError).not.toContain('discarded-prefix');
    await stream.stop();
  });

  it('awaits last-consumer native framebuffer stop after switching fallback', async () => {
    delete process.env.JC_MOBILE_PREVIEW_IOS_CORE_SIMULATOR;
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      process.cwd(),
      'electron/native/mobile-preview-ios-framebuffer.m',
    );
    let releaseNativeStop: (() => void) | undefined;
    const nativeStop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseNativeStop = resolve;
        }),
    );
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      pid: 123,
      stderr: new PassThrough(),
      stdout: new PassThrough(),
    });
    mockFramebufferWithReadyHid({ child: child as never, stop: nativeStop });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'xcrun' && args[0] === 'clang') return { stdout: '', stderr: '' };
      if (command === 'xcode-select') {
        return { stdout: '/Applications/Xcode.app/Contents/Developer\n', stderr: '' };
      }
      if (command === 'xcrun' && args[0] === 'simctl' && args[1] === 'io') {
        const screenshotPath = args.at(-1)!;
        await mkdir(dirname(screenshotPath), { recursive: true });
        await writeFile(screenshotPath, pngWithSize(2, 2));
        return { stdout: '', stderr: '' };
      }
      return {
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
              { name: 'iPhone 16', udid: 'device-fallback-stop', state: 'Booted' },
            ],
          },
        }),
        stderr: '',
      };
    });
    const stream = await iosIdbAdapter.startStream({
      taskId: 'task-fallback-stop',
      deviceId: 'device-fallback-stop',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    child.emit('error', new Error('native failed'));
    await vi.waitFor(() => expect(nativeStop).toHaveBeenCalledTimes(1));

    let stopped = false;
    const stop = stream.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseNativeStop?.();
    await stop;
    expect(stopped).toBe(true);
  });

  it('aborts and awaits one pending CoreSimulator build shared by concurrent starts', async () => {
    delete process.env.JC_MOBILE_PREVIEW_IOS_CORE_SIMULATOR;
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      process.cwd(),
      'electron/native/mobile-preview-ios-framebuffer.m',
    );
    process.env.DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';
    let compileStarted = false;
    let compileAborted = false;
    let rejectCompilerClose: (() => void) | undefined;
    runCommandMock.mockImplementation(async (command, args, options) => {
      if (command === 'xcrun' && args[0] === 'clang') {
        compileStarted = true;
        await new Promise<void>((_resolve, reject) => {
          rejectCompilerClose = () => {
            const error = new Error('Command aborted: xcrun clang');
            error.name = 'AbortError';
            reject(error);
          };
          options?.signal?.addEventListener(
            'abort',
            () => {
              compileAborted = true;
            },
            { once: true },
          );
        });
        return { stdout: '', stderr: '' };
      }
      return {
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
              { name: 'iPhone 16', udid: 'device-pending-build', state: 'Booted' },
            ],
          },
        }),
        stderr: '',
      };
    });
    const starts = ['a', 'b'].map((suffix) =>
      iosIdbAdapter
        .startStream({
          taskId: `task-pending-build-${suffix}`,
          deviceId: 'device-pending-build',
          onFrame: vi.fn(),
          onSession: vi.fn(),
        })
        .then(
          () => null,
          (error: unknown) => error,
        ),
    );
    await vi.waitFor(() => expect(compileStarted).toBe(true));

    const dispose = iosIdbAdapter.dispose();
    await vi.waitFor(() => expect(compileAborted).toBe(true));
    let disposed = false;
    void dispose.then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    rejectCompilerClose?.();
    await dispose;
    await expect(Promise.all(starts)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining('shutting down') }),
      expect.objectContaining({ message: expect.stringContaining('shutting down') }),
    ]);

    expect(disposed).toBe(true);
    expect(
      runCommandMock.mock.calls.filter(
        ([command, args]) => command === 'xcrun' && args[0] === 'clang',
      ),
    ).toHaveLength(1);
    expect(spawnManagedMock).not.toHaveBeenCalled();
  });

  it('does not start pending screenshot fallback during disposal', async () => {
    delete process.env.JC_MOBILE_PREVIEW_IOS_CORE_SIMULATOR;
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      process.cwd(),
      'electron/native/mobile-preview-ios-framebuffer.m',
    );
    let resolveScreenshot: (() => void) | undefined;
    let screenshotStarted = false;
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      pid: 123,
      stderr: new PassThrough(),
      stdout: new PassThrough(),
    });
    spawnManagedMock.mockReturnValue({
      child: child as never,
      stop: vi.fn().mockResolvedValue(undefined),
    });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'xcrun' && args[0] === 'clang') {
        return { stdout: '', stderr: '' };
      }
      if (command === 'xcode-select') {
        return {
          stdout: '/Applications/Xcode.app/Contents/Developer\n',
          stderr: '',
        };
      }
      if (
        command === 'xcrun' &&
        args[0] === 'simctl' &&
        args[1] === 'io' &&
        args[3] === 'screenshot'
      ) {
        screenshotStarted = true;
        await new Promise<void>((resolve) => {
          resolveScreenshot = resolve;
        });
        const screenshotPath = args.at(-1)!;
        await mkdir(dirname(screenshotPath), { recursive: true });
        await writeFile(screenshotPath, pngWithSize(1206, 2622));
        return { stdout: '', stderr: '' };
      }
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
    });
    const onSession = vi.fn();
    await iosIdbAdapter.startStream({
      taskId: 'task-1',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession,
    });

    child.emit('error', new Error('framebuffer failed'));
    await vi.waitFor(() => expect(screenshotStarted).toBe(true));
    const disposePromise = iosIdbAdapter.dispose();
    resolveScreenshot?.();
    await disposePromise;

    expect(onSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ streamStrategy: 'simctl-screenshot' }),
    );
  });

  it('keeps CoreSimulator framebuffer stream when CoreSimulatorService throttles', async () => {
    vi.useFakeTimers();
    delete process.env.JC_MOBILE_PREVIEW_IOS_CORE_SIMULATOR;
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      process.cwd(),
      'electron/native/mobile-preview-ios-framebuffer.m',
    );
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      pid: 123,
      stderr,
      stdout,
    });
    const stop = vi.fn(async () => {
      child.emit('close', 0, null);
    });

    spawnManagedMock.mockReturnValue({
      child: child as never,
      stop,
    });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'which') {
        return { stdout: `/usr/bin/${args[0]}`, stderr: '' };
      }
      if (command === 'idb') {
        throw new Error('idb unavailable');
      }
      if (command === 'xcrun' && args[0] === 'clang') {
        return { stdout: '', stderr: '' };
      }
      if (command === 'xcode-select') {
        return {
          stdout: '/Applications/Xcode.app/Contents/Developer\n',
          stderr: '',
        };
      }
      if (
        command === 'xcrun' &&
        args[0] === 'simctl' &&
        args[1] === 'io' &&
        args[3] === 'screenshot'
      ) {
        const screenshotPath = args.at(-1)!;
        await mkdir(dirname(screenshotPath), { recursive: true });
        await writeFile(screenshotPath, pngWithSize(1206, 2622));
        return { stdout: '', stderr: '' };
      }

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
    });

    const onSession = vi.fn();
    const result = await iosIdbAdapter.startStream({
      taskId: 'task-1',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession,
    });

    stderr.write(
      'Throttling connection to com.apple.CoreSimulator.CoreSimulatorService. Retrying in 9.9s.',
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(onSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ streamStrategy: 'simctl-screenshot' }),
    );
    expect(stop).not.toHaveBeenCalled();

    await result.stop();
  });

  it('reuses a warm CoreSimulator framebuffer helper after stopping a session', async () => {
    delete process.env.JC_MOBILE_PREVIEW_IOS_CORE_SIMULATOR;
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      process.cwd(),
      'electron/native/mobile-preview-ios-framebuffer.m',
    );
    const firstFrame = Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]);
    const secondFrame = Buffer.from([0xff, 0xd8, 0x02, 0xff, 0xd9]);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      pid: 123,
      stderr,
      stdout,
    });
    const stop = vi.fn(async () => {
      child.emit('close', 0, null);
    });

    mockFramebufferWithReadyHid({
      child: child as never,
      stop,
    });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'xcrun' && args[0] === 'clang') {
        return { stdout: '', stderr: '' };
      }
      if (command === 'xcode-select') {
        return {
          stdout: '/Applications/Xcode.app/Contents/Developer\n',
          stderr: '',
        };
      }

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
    });

    const firstOnFrame = vi.fn();
    const first = await iosIdbAdapter.startStream({
      taskId: 'task-1',
      deviceId: 'device-1',
      onFrame: firstOnFrame,
      onSession: vi.fn(),
    });
    stdout.write(firstFrame);
    expect(firstOnFrame).toHaveBeenCalledWith(firstFrame);

    await first.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGUSR1');

    const secondOnFrame = vi.fn();
    const second = await iosIdbAdapter.startStream({
      taskId: 'task-1',
      deviceId: 'device-1',
      onFrame: secondOnFrame,
      onSession: vi.fn(),
    });
    stdout.write(secondFrame);

    expect(
      spawnManagedMock.mock.calls.filter(([command]) =>
        command.includes('mobile-preview-ios-framebuffer'),
      ),
    ).toHaveLength(1);
    expect(
      runCommandMock.mock.calls.filter(
        ([command, args]) => command === 'xcrun' && args[0] === 'clang',
      ),
    ).toHaveLength(1);
    expect(child.kill).toHaveBeenCalledWith('SIGUSR2');
    expect(secondOnFrame).toHaveBeenCalledWith(secondFrame);
    expect(stop).not.toHaveBeenCalled();
    await second.stop();
  });

  it('fans out one CoreSimulator framebuffer helper to concurrent tasks', async () => {
    delete process.env.JC_MOBILE_PREVIEW_IOS_CORE_SIMULATOR;
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      process.cwd(),
      'electron/native/mobile-preview-ios-framebuffer.m',
    );
    const frame = Buffer.from([0xff, 0xd8, 0x03, 0xff, 0xd9]);
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      pid: 123,
      stderr: new PassThrough(),
      stdout,
    });
    const stop = vi.fn(async () => {
      child.emit('close', 0, null);
    });
    mockFramebufferWithReadyHid({ child: child as never, stop });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'xcrun' && args[0] === 'clang') {
        return { stdout: '', stderr: '' };
      }
      if (command === 'xcode-select') {
        return {
          stdout: '/Applications/Xcode.app/Contents/Developer\n',
          stderr: '',
        };
      }
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
    });

    const firstOnFrame = vi.fn(() => {
      throw new Error('consumer failed');
    });
    const secondOnFrame = vi.fn();
    const [first, second] = await Promise.all([
      iosIdbAdapter.startStream({
        taskId: 'task-1',
        deviceId: 'device-1',
        onFrame: firstOnFrame,
        onSession: vi.fn(),
      }),
      iosIdbAdapter.startStream({
        taskId: 'task-2',
        deviceId: 'device-1',
        onFrame: secondOnFrame,
        onSession: vi.fn(),
      }),
    ]);
    expect(() => stdout.write(frame)).not.toThrow();

    expect(firstOnFrame).toHaveBeenCalledWith(frame);
    expect(secondOnFrame).toHaveBeenCalledWith(frame);
    expect(
      spawnManagedMock.mock.calls.filter(([command]) =>
        command.includes('mobile-preview-ios-framebuffer'),
      ),
    ).toHaveLength(1);

    await first.stop();
    expect(child.kill).not.toHaveBeenCalledWith('SIGUSR1');
    stdout.write(frame);
    expect(secondOnFrame).toHaveBeenCalledTimes(2);
    await second.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGUSR1');
  });

  it('force-stops a warm CoreSimulator helper during disposal', async () => {
    delete process.env.JC_MOBILE_PREVIEW_IOS_CORE_SIMULATOR;
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      process.cwd(),
      'electron/native/mobile-preview-ios-framebuffer.m',
    );
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      pid: 123,
      stderr: new PassThrough(),
      stdout: new PassThrough(),
    });
    const stop = vi.fn().mockResolvedValue(undefined);
    spawnManagedMock.mockReturnValue({ child: child as never, stop });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'xcrun' && args[0] === 'clang') {
        return { stdout: '', stderr: '' };
      }
      if (command === 'xcode-select') {
        return {
          stdout: '/Applications/Xcode.app/Contents/Developer\n',
          stderr: '',
        };
      }
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
    });

    const stream = await iosIdbAdapter.startStream({
      taskId: 'task-1',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    await stream.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGUSR1');
    expect(stop).not.toHaveBeenCalled();

    await iosIdbAdapter.dispose();

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('stops active CoreSimulator consumers before helper disposal', async () => {
    delete process.env.JC_MOBILE_PREVIEW_IOS_CORE_SIMULATOR;
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      process.cwd(),
      'electron/native/mobile-preview-ios-framebuffer.m',
    );
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      pid: 123,
      stderr: new PassThrough(),
      stdout: new PassThrough(),
    });
    const stop = vi.fn(async () => {
      child.emit('close', 0, null);
    });
    spawnManagedMock.mockReturnValue({ child: child as never, stop });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'xcrun' && args[0] === 'clang') {
        return { stdout: '', stderr: '' };
      }
      if (command === 'xcode-select') {
        return {
          stdout: '/Applications/Xcode.app/Contents/Developer\n',
          stderr: '',
        };
      }
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
    });
    const onSession = vi.fn();
    await iosIdbAdapter.startStream({
      taskId: 'task-1',
      deviceId: 'device-1',
      onFrame: vi.fn(),
      onSession,
    });

    await iosIdbAdapter.dispose();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(onSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ streamStrategy: 'simctl-screenshot' }),
    );
  });

  it('keeps CoreSimulator framebuffer stream when throttling logs after first frame', async () => {
    delete process.env.JC_MOBILE_PREVIEW_IOS_CORE_SIMULATOR;
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      process.cwd(),
      'electron/native/mobile-preview-ios-framebuffer.m',
    );
    const jpegFrame = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      pid: 123,
      stderr,
      stdout,
    });
    const stop = vi.fn(async () => {
      child.emit('close', 0, null);
    });

    mockFramebufferWithReadyHid({
      child: child as never,
      stop,
    });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'which') {
        return { stdout: `/usr/bin/${args[0]}`, stderr: '' };
      }
      if (command === 'idb') {
        throw new Error('idb unavailable');
      }
      if (command === 'xcrun' && args[0] === 'clang') {
        return { stdout: '', stderr: '' };
      }
      if (command === 'xcode-select') {
        return {
          stdout: '/Applications/Xcode.app/Contents/Developer\n',
          stderr: '',
        };
      }
      if (
        command === 'xcrun' &&
        args[0] === 'simctl' &&
        args[1] === 'io' &&
        args[3] === 'screenshot'
      ) {
        const screenshotPath = args.at(-1)!;
        await mkdir(dirname(screenshotPath), { recursive: true });
        await writeFile(screenshotPath, pngWithSize(1206, 2622));
        return { stdout: '', stderr: '' };
      }

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
    });

    const onFrame = vi.fn();
    const onSession = vi.fn();
    const result = await iosIdbAdapter.startStream({
      taskId: 'task-1',
      deviceId: 'device-1',
      onFrame,
      onSession,
    });

    stdout.write(jpegFrame);
    stderr.write(
      'Throttling connection to com.apple.CoreSimulator.CoreSimulatorService. Retrying in 9.9s.',
    );

    expect(onFrame).toHaveBeenCalledWith(jpegFrame);
    expect(onSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ streamStrategy: 'simctl-screenshot' }),
    );

    await result.stop();
  });

  it('rejects unknown simulator state instead of starting stream', async () => {
    runCommandMock.mockResolvedValue({
      stdout: JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
            { name: 'iPhone 16', udid: 'device-1', state: 'Booting' },
          ],
        },
      }),
      stderr: '',
    });

    await expect(
      iosIdbAdapter.startStream({
        taskId: 'task-1',
        deviceId: 'device-1',
        onFrame: vi.fn(),
        onSession: vi.fn(),
      }),
    ).rejects.toThrow(/not ready to stream.*Only booted or shutdown/s);
    expect(spawnManagedMock).not.toHaveBeenCalled();
  });

  it('continues screenshot polling after the first frame', async () => {
    vi.useFakeTimers();
    mockSimctlCommands('Booted');
    const onFrame = vi.fn();

    await iosIdbAdapter.startStream({
      taskId: 'task-1',
      deviceId: 'device-1',
      onFrame,
      onSession: vi.fn(),
    });
    await vi.runOnlyPendingTimersAsync();

    const frameCountAfterFirstTick = onFrame.mock.calls.length;
    expect(frameCountAfterFirstTick).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(SCREENSHOT_POLL_INTERVAL_MS);
    expect(onFrame.mock.calls.length).toBeGreaterThan(frameCountAfterFirstTick);
  });
});
