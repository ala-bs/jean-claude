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
  commandExistsMock,
  installIosPreviewTestHooks,
  iosIdbAdapter,
  mockReadyHidHelper,
  pngWithSize,
  runCommandMock,
  spawnManagedMock,
} from './mobile-preview-ios-test-helpers';
import { describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  getPendingIosBootWaiterCountForTests,
} from './mobile-preview-ios-simctl';
import {
  MOBILE_PREVIEW_DEEPLINK_OPEN_TIMEOUT_MS,
} from './mobile-preview-process';
import { tmpdir } from 'node:os';

describe('mobile preview iOS idb adapter', () => {
  installIosPreviewTestHooks();

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
});
