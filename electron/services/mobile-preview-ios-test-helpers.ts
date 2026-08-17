import type {
  MobilePreviewIosAppRestartParams,
  MobilePreviewIosAppStatusParams,
} from '../../shared/mobile-simulator-types';

import { afterEach, beforeEach, vi } from 'vitest';
import {
  commandExists,
  runCommand,
  spawnManaged,
} from './mobile-preview-process';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  iosIdbAdapter as rawIosIdbAdapter,
  resetCoreSimulatorFramebufferPoolForTests,
} from './mobile-preview-ios-idb-adapter';
import { dbg } from '../lib/debug';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { minimizeMobilePreviewWindows } from './mobile-preview-window-utils';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';

export { rawIosIdbAdapter };

export const commandExistsMock = vi.mocked(commandExists);
export const runCommandMock = vi.mocked(runCommand);
export const spawnManagedMock = vi.mocked(spawnManaged);
export const minimizeMobilePreviewWindowsMock = vi.mocked(
  minimizeMobilePreviewWindows,
);
export const mobilePreviewDebugMock = vi.mocked(dbg.mobilePreview);

export const iosIdbAdapter = {
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

export const OPENSTEP_LISTAPPS = `{
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

export function pngWithSize(width: number, height: number): Buffer {
  const png = Buffer.alloc(24);
  png.set(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

export function mockSimctlCommands(state: string) {
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

export function mockIosAppStatusCommands(listAppsStdout: string) {
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

export function mockReadyHidHelper() {
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

export function mockFramebufferWithReadyHid(
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

export function installIosPreviewTestHooks() {
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
}
