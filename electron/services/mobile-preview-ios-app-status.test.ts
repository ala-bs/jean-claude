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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  OPENSTEP_LISTAPPS,
  installIosPreviewTestHooks,
  iosIdbAdapter,
  mobilePreviewDebugMock,
  mockIosAppStatusCommands,
  runCommandMock,
} from './mobile-preview-ios-test-helpers';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('mobile preview iOS app status and restart', () => {
  installIosPreviewTestHooks();

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
});
