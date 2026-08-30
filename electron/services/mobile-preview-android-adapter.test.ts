import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./mobile-preview-process', () => ({
  MOBILE_PREVIEW_DEEPLINK_OPEN_TIMEOUT_MS: 25,
  commandExists: vi.fn(),
  runBinaryCommand: vi.fn(),
  runCommand: vi.fn(),
  spawnManaged: vi.fn(),
}));
vi.mock('./mobile-preview-window-utils', () => ({
  ANDROID_EMULATOR_PROCESS_NAMES: ['Android Emulator'],
  minimizeMobilePreviewWindows: vi.fn(),
}));
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

import { spawn } from 'node:child_process';

import {
  androidAdapter,
  buildAdbInputArgs,
  buildAdbScreenrecordArgs,
  createAndroidMobilePreviewAdapter,
  ensureAndroidMetroReverse,
  parseAdbReverseList,
  mergeAndroidAvdConfig,
  parseAndroidDeviceProfiles,
  parseAndroidSystemImages,
  parseAvdList,
  parseAndroidWmSize,
  parseAdbDevices,
} from './mobile-preview-android-adapter';
import {
  MOBILE_PREVIEW_DEEPLINK_OPEN_TIMEOUT_MS,
  commandExists,
  runBinaryCommand,
  runCommand,
  spawnManaged,
} from './mobile-preview-process';
import { minimizeMobilePreviewWindows } from './mobile-preview-window-utils';

const commandExistsMock = vi.mocked(commandExists);
const runBinaryCommandMock = vi.mocked(runBinaryCommand);
const runCommandMock = vi.mocked(runCommand);
const spawnManagedMock = vi.mocked(spawnManaged);
const spawnMock = vi.mocked(spawn);
const minimizeMobilePreviewWindowsMock = vi.mocked(minimizeMobilePreviewWindows);

describe('mobile preview Android adapter', () => {
  let stdout: EventEmitter;
  let stderr: EventEmitter;
  let child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };

  beforeEach(() => {
    vi.resetAllMocks();
    commandExistsMock.mockResolvedValue(true);
    runBinaryCommandMock.mockResolvedValue({
      stdout: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      stderr: '',
    });
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    child = Object.assign(new EventEmitter(), { stdout, stderr });
    spawnManagedMock.mockReturnValue({
      child: child as never,
      stop: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses adb devices output including unknown states', () => {
    const devices =
      parseAdbDevices(`* daemon not running; starting now at tcp:5037
* daemon started successfully
List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:Pixel_8_API_35 device:emu64a transport_id:1
R58M123456 offline usb:338690048X product:o1sxxx model:SM_G991U device:o1s transport_id:2
ABC987 unauthorized usb:1-1 model:Unauthorized_Device transport_id:3

`);

    expect(devices).toEqual([
      {
        id: 'emulator-5554',
        name: 'Pixel 8 API 35',
        platform: 'android',
        kind: 'simulator',
        connection: 'connected',
        state: 'booted',
      },
      {
        id: 'R58M123456',
        name: 'SM G991U',
        model: 'SM G991U',
        platform: 'android',
        kind: 'physical',
        connection: 'unavailable',
        state: 'unknown',
        unavailableReason:
          'Device is offline — reconnect the cable or re-enable USB debugging.',
      },
      {
        id: 'ABC987',
        name: 'Unauthorized Device',
        model: 'Unauthorized Device',
        platform: 'android',
        kind: 'physical',
        connection: 'unauthorized',
        state: 'unknown',
        unavailableReason: 'Accept the USB debugging prompt on the device.',
      },
    ]);
  });

  it('classifies a connected physical device from adb devices -l details', () => {
    expect(
      parseAdbDevices(
        'List of devices attached\n1A2B3C4D device usb:1-2 product:panther model:Pixel_7 device:panther transport_id:4\n',
      ),
    ).toEqual([
      {
        id: '1A2B3C4D',
        name: 'Pixel 7',
        model: 'Pixel 7',
        platform: 'android',
        kind: 'physical',
        connection: 'connected',
        state: 'booted',
      },
    ]);
  });

  it('falls back to the adb serial when a physical device reports no details', () => {
    expect(parseAdbDevices('List of devices attached\nR3CT90ZZZZ device\n')).toEqual(
      [
        {
          id: 'R3CT90ZZZZ',
          name: 'R3CT90ZZZZ',
          platform: 'android',
          kind: 'physical',
          connection: 'connected',
          state: 'booted',
        },
      ],
    );
  });

  it('separates emulators from physical devices in one adb devices -l output', () => {
    const devices = parseAdbDevices(
      `List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:Pixel_8 device:emu64a transport_id:1
1A2B3C4D device usb:1-2 model:Pixel_7 device:panther transport_id:2
`,
    );

    expect(
      devices.map((device) => ({ id: device.id, kind: device.kind })),
    ).toEqual([
      { id: 'emulator-5554', kind: 'simulator' },
      { id: '1A2B3C4D', kind: 'physical' },
    ]);
    expect(devices[0]?.model).toBeUndefined();
    expect(devices[1]?.model).toBe('Pixel 7');
  });

  it('keeps devices in transient and unrecognized adb states in the rail', () => {
    const devices = parseAdbDevices(`List of devices attached
AUTHZ001 authorizing usb:1-1 transport_id:1
CONN002 connecting usb:1-2 transport_id:2
RECOV003 recovery usb:1-3 transport_id:3
`);

    expect(
      devices.map((device) => ({
        id: device.id,
        connection: device.connection,
        state: device.state,
        unavailableReason: device.unavailableReason,
      })),
    ).toEqual([
      {
        id: 'AUTHZ001',
        connection: 'unauthorized',
        state: 'unknown',
        unavailableReason: 'Accept the USB debugging prompt on the device.',
      },
      {
        id: 'CONN002',
        connection: 'unavailable',
        state: 'unknown',
        unavailableReason:
          'Device is still connecting — reconnect the cable if this does not clear.',
      },
      {
        id: 'RECOV003',
        connection: 'unavailable',
        state: 'unknown',
        unavailableReason:
          'Device is in "recovery" state and cannot be used for preview.',
      },
    ]);
  });

  it('returns no adb devices when output has no device header', () => {
    expect(parseAdbDevices('* daemon started successfully\n')).toEqual([]);
  });

  it('lists devices through adb devices -l', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout:
            'List of devices attached\nemulator-5554 device model:Pixel_8 transport_id:1\n',
          stderr: '',
        };
      }
      if (
        command === 'adb' &&
        args.join(' ') === '-s emulator-5554 emu avd name'
      ) {
        return { stdout: 'Pixel_8\nOK\n', stderr: '' };
      }
      if (command === 'emulator' && args.join(' ') === '-list-avds') {
        return { stdout: 'Pixel_8\nPixel_9\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    await expect(androidAdapter.listDevices()).resolves.toEqual([
      {
        id: 'Pixel_8',
        connectionId: 'emulator-5554',
        name: 'Pixel 8',
        platform: 'android',
        kind: 'simulator',
        connection: 'connected',
        state: 'booted',
      },
      {
        id: 'Pixel_9',
        name: 'Pixel 9',
        platform: 'android',
        kind: 'simulator',
        state: 'shutdown',
      },
    ]);
  });

  it('keeps the adb serial in connectionId when a booted emulator is renamed to its AVD name', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout:
            'List of devices attached\nemulator-5556 device model:Pixel_7 transport_id:1\n',
          stderr: '',
        };
      }
      if (
        command === 'adb' &&
        args.join(' ') === '-s emulator-5556 emu avd name'
      ) {
        return { stdout: 'Pixel_7_API_34\nOK\n', stderr: '' };
      }
      if (command === 'emulator' && args.join(' ') === '-list-avds') {
        return { stdout: 'Pixel_7_API_34\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    const devices = await androidAdapter.listDevices();
    const booted = devices.find((device) => device.state === 'booted');
    expect(booted?.id).toBe('Pixel_7_API_34');
    expect(booted?.connectionId).toBe('emulator-5556');
  });

  it('lists physical devices alongside emulators with their adb serials', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout: `List of devices attached
emulator-5554 device model:Pixel_8 transport_id:1
1A2B3C4D device usb:1-2 model:Pixel_7 device:panther transport_id:2
R58M999 unauthorized usb:1-3 transport_id:3
`,
          stderr: '',
        };
      }
      if (
        command === 'adb' &&
        args.join(' ') === '-s emulator-5554 emu avd name'
      ) {
        return { stdout: 'Pixel_8\nOK\n', stderr: '' };
      }
      if (command === 'emulator' && args.join(' ') === '-list-avds') {
        return { stdout: 'Pixel_8\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    await expect(androidAdapter.listDevices()).resolves.toEqual([
      {
        id: 'Pixel_8',
        connectionId: 'emulator-5554',
        name: 'Pixel 8',
        platform: 'android',
        kind: 'simulator',
        connection: 'connected',
        state: 'booted',
      },
      {
        id: '1A2B3C4D',
        name: 'Pixel 7',
        model: 'Pixel 7',
        platform: 'android',
        kind: 'physical',
        connection: 'connected',
        state: 'booted',
      },
      {
        id: 'R58M999',
        name: 'R58M999',
        platform: 'android',
        kind: 'physical',
        connection: 'unauthorized',
        state: 'unknown',
        unavailableReason: 'Accept the USB debugging prompt on the device.',
      },
    ]);
  });

  it('does not guess booted AVD name when emulator console name is unavailable', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout:
            'List of devices attached\nemulator-5554 device product:sdk_gphone64_arm64 transport_id:1\n',
          stderr: '',
        };
      }
      if (
        command === 'adb' &&
        args.join(' ') === '-s emulator-5554 emu avd name'
      ) {
        throw new Error('emulator console unavailable');
      }
      if (command === 'emulator' && args.join(' ') === '-list-avds') {
        return { stdout: 'Medium_Phone_2\nPixel_9\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    await expect(androidAdapter.listDevices()).resolves.toEqual([
      {
        id: 'emulator-5554',
        name: 'sdk gphone64 arm64',
        platform: 'android',
        kind: 'simulator',
        connection: 'connected',
        state: 'booted',
      },
      {
        id: 'Medium_Phone_2',
        name: 'Medium Phone 2',
        platform: 'android',
        kind: 'simulator',
        state: 'shutdown',
      },
      {
        id: 'Pixel_9',
        name: 'Pixel 9',
        platform: 'android',
        kind: 'simulator',
        state: 'shutdown',
      },
    ]);
  });

  it('parses created Android AVDs as shutdown devices', () => {
    expect(parseAvdList('Medium_Phone\nSmall_Phone\n')).toEqual([
      {
        id: 'Medium_Phone',
        name: 'Medium Phone',
        platform: 'android',
        kind: 'simulator',
        state: 'shutdown',
      },
      {
        id: 'Small_Phone',
        name: 'Small Phone',
        platform: 'android',
        kind: 'simulator',
        state: 'shutdown',
      },
    ]);
  });

  it('cancels a pending scrcpy startup with the caller signal', async () => {
    let receivedSignal: AbortSignal | undefined;
    const startScrcpyStream = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<never>((_, reject) => {
          receivedSignal = signal;
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const adapter = createAndroidMobilePreviewAdapter({ startScrcpyStream });
    runCommandMock.mockImplementation(async (_command, args) => {
      if (args.join(' ') === 'devices -l') {
        return {
          stdout: 'List of devices attached\ndevice-1 device model:Pixel_8\n',
          stderr: '',
        };
      }
      if (args.join(' ') === '-s device-1 shell wm size') {
        return { stdout: 'Physical size: 1080x2400\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });
    const controller = new AbortController();
    const start = adapter.startStream({
      taskId: 'task-1',
      deviceId: 'device-1',
      signal: controller.signal,
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    await vi.waitFor(() => expect(receivedSignal).toBe(controller.signal));

    controller.abort(new DOMException('task completed', 'AbortError'));

    await expect(start).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('minimizes Android emulator windows after launching an AVD', async () => {
    const startScrcpyStream = vi.fn(
      async ({
        onSize,
      }: {
        onSize: (size: { width: number; height: number }) => void;
      }) => {
        onSize({ width: 1080, height: 2400 });
        return { stop: vi.fn().mockResolvedValue(undefined) };
      },
    );
    const adapter = createAndroidMobilePreviewAdapter({ startScrcpyStream });

    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return { stdout: 'List of devices attached\n', stderr: '' };
      }
      if (command === 'adb' && args.join(' ') === '-s emulator-5554 emu avd name') {
        return { stdout: 'Pixel_8\nOK\n', stderr: '' };
      }
      if (
        command === 'adb' &&
        args.join(' ') === '-s emulator-5554 shell getprop sys.boot_completed'
      ) {
        return { stdout: '1\n', stderr: '' };
      }
      if (
        command === 'adb' &&
        args.join(' ') === '-s emulator-5554 shell getprop init.svc.bootanim'
      ) {
        return { stdout: 'stopped\n', stderr: '' };
      }
      if (command === 'adb' && args.join(' ') === '-s emulator-5554 shell wm size') {
        return { stdout: 'Physical size: 1080x2400\n', stderr: '' };
      }
      if (command === 'emulator' && args.join(' ') === '-list-avds') {
        return { stdout: 'Pixel_8\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    const startPromise = adapter.startStream({
      taskId: 'task-1',
      deviceId: 'Pixel_8',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout: 'List of devices attached\nemulator-5554 device model:Pixel_8\n',
          stderr: '',
        };
      }
      if (command === 'adb' && args.join(' ') === '-s emulator-5554 emu avd name') {
        return { stdout: 'Pixel_8\nOK\n', stderr: '' };
      }
      if (
        command === 'adb' &&
        args.join(' ') === '-s emulator-5554 shell getprop sys.boot_completed'
      ) {
        return { stdout: '1\n', stderr: '' };
      }
      if (
        command === 'adb' &&
        args.join(' ') === '-s emulator-5554 shell getprop init.svc.bootanim'
      ) {
        return { stdout: 'stopped\n', stderr: '' };
      }
      if (command === 'adb' && args.join(' ') === '-s emulator-5554 shell wm size') {
        return { stdout: 'Physical size: 1080x2400\n', stderr: '' };
      }
      if (command === 'emulator' && args.join(' ') === '-list-avds') {
        return { stdout: 'Pixel_8\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    const { session } = await startPromise;

    expect(session.deviceId).toBe('Pixel_8');
    expect(spawnMock).toHaveBeenCalledWith('emulator', ['-avd', 'Pixel_8'], {
      detached: true,
      stdio: 'ignore',
    });
    expect(minimizeMobilePreviewWindowsMock).toHaveBeenCalledWith({
      processNames: ['Android Emulator'],
      windowNameIncludes: ['Pixel_8', 'Pixel 8'],
    });
    expect(minimizeMobilePreviewWindowsMock).toHaveBeenCalledWith({
      processNames: ['Android Emulator'],
      windowNameIncludes: ['Pixel_8', 'Pixel 8', 'emulator-5554'],
    });
    expect(minimizeMobilePreviewWindowsMock).toHaveBeenCalledTimes(2);
  });

  it('parses Android wm size output', () => {
    expect(parseAndroidWmSize('Physical size: 1080x2400\n')).toEqual({
      width: 1080,
      height: 2400,
    });
    expect(
      parseAndroidWmSize('Physical size: 1080x2400\nOverride size: 720x1280\n'),
    ).toEqual({ width: 720, height: 1280 });
    expect(parseAndroidWmSize('bad output')).toBeNull();
  });

  it('reports Android SDK tool status from PATH and SDK root', async () => {
    commandExistsMock.mockImplementation(async (command) => command === 'adb');

    const status = await androidAdapter.getAndroidToolStatus();

    expect(status.adbPath).toBe('adb');
    expect(status.missingTools).toContain('avdmanager');
    expect(status.missingTools).toContain('sdkmanager');
  });

  it('parses avdmanager device profiles', () => {
    expect(
      parseAndroidDeviceProfiles(`id: 30 or "pixel_8"
    Name: Pixel 8
    OEM : Google
    Screen: 1080 x 2400
    Density: 420
---------
id: 31 or "medium_phone"
    Name: Medium Phone
---------
id: 32 or "small_phone_custom"
    Name: Small Phone Custom
    Screen: 720 x 1280
---------
id: 33 or "unknown_phone"
    Name: Unknown Phone
`),
    ).toEqual([
      {
        id: 'pixel_8',
        name: 'Pixel 8',
        manufacturer: 'Google',
        screen: { width: 1080, height: 2400, densityDpi: 420 },
      },
      {
        id: 'medium_phone',
        name: 'Medium Phone',
        manufacturer: null,
        screen: { width: 1080, height: 2400, densityDpi: 420 },
      },
      {
        id: 'small_phone_custom',
        name: 'Small Phone Custom',
        manufacturer: null,
        screen: { width: 720, height: 1280, densityDpi: null },
      },
      {
        id: 'unknown_phone',
        name: 'Unknown Phone',
        manufacturer: null,
        screen: null,
      },
    ]);
  });

  it('parses installed sdkmanager system images', () => {
    expect(
      parseAndroidSystemImages(
        'system-images;android-35;google_apis;arm64-v8a | 9 | Google APIs ARM 64 v8a System Image | system-images/android-35/google_apis/arm64-v8a\n',
      ),
    ).toEqual([
      {
        id: 'system-images;android-35;google_apis;arm64-v8a',
        packagePath: 'system-images;android-35;google_apis;arm64-v8a',
        apiLevel: 35,
        tag: 'google_apis',
        abi: 'arm64-v8a',
        installed: true,
      },
    ]);
  });

  it('merges Android AVD advanced config values', () => {
    expect(
      mergeAndroidAvdConfig(
        'avd.ini.encoding=UTF-8\nhw.ramSize=1536\nhw.ramSize=2048\n',
        {
          ramMb: 4096,
          vmHeapMb: 512,
          storageMb: 8192,
          hwKeyboard: true,
        },
      ),
    ).toBe(
      'avd.ini.encoding=UTF-8\nhw.ramSize=4096\nvm.heapSize=512\ndisk.dataPartition.size=8192M\nhw.keyboard=yes\n',
    );
  });

  it('preserves Android AVD config lines when only some advanced values change', () => {
    expect(
      mergeAndroidAvdConfig('hw.keyboard=yes\nimage.sysdir.1=system-images/foo\n', {
        hwKeyboard: false,
      }),
    ).toBe('hw.keyboard=no\nimage.sysdir.1=system-images/foo\n');
  });

  it('creates Android AVD with avdmanager', async () => {
    runCommandMock.mockResolvedValue({ stdout: '', stderr: '' });

    await androidAdapter.createAndroidDevice({
      name: 'Pixel_8_API_35',
      deviceProfileId: 'pixel_8',
      systemImageId: 'system-images;android-35;google_apis;arm64-v8a',
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      'avdmanager',
      [
        'create',
        'avd',
        '--name',
        'Pixel_8_API_35',
        '--device',
        'pixel_8',
        '--package',
        'system-images;android-35;google_apis;arm64-v8a',
      ],
      { input: 'no\n' },
    );
  });

  it('allows Android AVD creation with decimal API system image ids', async () => {
    runCommandMock.mockResolvedValue({ stdout: '', stderr: '' });

    await androidAdapter.createAndroidDevice({
      name: 'Pixel_8_API_36_1',
      deviceProfileId: 'pixel_8',
      systemImageId: 'system-images;android-36.1;google_apis;arm64-v8a',
    });

    expect(runCommandMock).toHaveBeenCalledWith(
      'avdmanager',
      [
        'create',
        'avd',
        '--name',
        'Pixel_8_API_36_1',
        '--device',
        'pixel_8',
        '--package',
        'system-images;android-36.1;google_apis;arm64-v8a',
      ],
      { input: 'no\n' },
    );
  });

  it('writes Android AVD advanced config through ANDROID_AVD_HOME after create', async () => {
    const originalAndroidAvdHome = process.env.ANDROID_AVD_HOME;
    await mkdir(tmpdir(), { recursive: true });
    const avdHome = await mkdtemp(join(tmpdir(), 'jc-android-avd-'));
    const avdDir = join(avdHome, 'Pixel_8_API_35.avd');
    await mkdir(avdDir);
    await writeFile(
      join(avdDir, 'config.ini'),
      'avd.ini.encoding=UTF-8\nhw.ramSize=1536\nhw.keyboard=no\n',
    );
    process.env.ANDROID_AVD_HOME = avdHome;
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'emulator' && args.join(' ') === '-list-avds') {
        return { stdout: '', stderr: '' };
      }
      if (command === 'sdkmanager' && args.includes('--list_installed')) {
        return {
          stdout: 'platforms;android-35 | 2 | Android SDK Platform 35\n',
          stderr: '',
        };
      }
      if (command === 'avdmanager' && args.includes('create')) {
        return { stdout: '', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    try {
      await androidAdapter.createAndroidDevice({
        name: 'Pixel_8_API_35',
        deviceProfileId: 'pixel_8',
        systemImageId: 'system-images;android-35;google_apis;arm64-v8a',
        ramMb: 4096,
        vmHeapMb: 512,
        storageMb: 8192,
        hwKeyboard: true,
      });

      await expect(readFile(join(avdDir, 'config.ini'), 'utf8')).resolves.toBe(
        'avd.ini.encoding=UTF-8\nhw.ramSize=4096\nhw.keyboard=yes\nvm.heapSize=512\ndisk.dataPartition.size=8192M\n',
      );
    } finally {
      if (originalAndroidAvdHome === undefined) {
        delete process.env.ANDROID_AVD_HOME;
      } else {
        process.env.ANDROID_AVD_HOME = originalAndroidAvdHome;
      }
      await rm(avdHome, { force: true, recursive: true });
    }
  });

  it('writes Android AVD advanced config through ANDROID_USER_HOME when AVD home is unset', async () => {
    const originalAndroidAvdHome = process.env.ANDROID_AVD_HOME;
    const originalAndroidUserHome = process.env.ANDROID_USER_HOME;
    const originalAndroidSdkHome = process.env.ANDROID_SDK_HOME;
    await mkdir(tmpdir(), { recursive: true });
    const userHome = await mkdtemp(join(tmpdir(), 'jc-android-user-home-'));
    const avdDir = join(userHome, 'avd', 'Pixel_8_API_35.avd');
    await mkdir(avdDir, { recursive: true });
    await writeFile(join(avdDir, 'config.ini'), 'hw.ramSize=1536\n');
    delete process.env.ANDROID_AVD_HOME;
    delete process.env.ANDROID_SDK_HOME;
    process.env.ANDROID_USER_HOME = userHome;
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'emulator' && args.join(' ') === '-list-avds') {
        return { stdout: '', stderr: '' };
      }
      if (command === 'sdkmanager' && args.includes('--list_installed')) {
        return {
          stdout: 'platforms;android-35 | 2 | Android SDK Platform 35\n',
          stderr: '',
        };
      }
      if (command === 'avdmanager' && args.includes('create')) {
        return { stdout: '', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    try {
      await androidAdapter.createAndroidDevice({
        name: 'Pixel_8_API_35',
        deviceProfileId: 'pixel_8',
        systemImageId: 'system-images;android-35;google_apis;arm64-v8a',
        ramMb: 4096,
      });

      await expect(readFile(join(avdDir, 'config.ini'), 'utf8')).resolves.toBe(
        'hw.ramSize=4096\n',
      );
    } finally {
      if (originalAndroidAvdHome === undefined) {
        delete process.env.ANDROID_AVD_HOME;
      } else {
        process.env.ANDROID_AVD_HOME = originalAndroidAvdHome;
      }
      if (originalAndroidUserHome === undefined) {
        delete process.env.ANDROID_USER_HOME;
      } else {
        process.env.ANDROID_USER_HOME = originalAndroidUserHome;
      }
      if (originalAndroidSdkHome === undefined) {
        delete process.env.ANDROID_SDK_HOME;
      } else {
        process.env.ANDROID_SDK_HOME = originalAndroidSdkHome;
      }
      await rm(userHome, { force: true, recursive: true });
    }
  });

  it('writes Android AVD advanced config through ANDROID_SDK_HOME when AVD home is unset', async () => {
    const originalAndroidAvdHome = process.env.ANDROID_AVD_HOME;
    const originalAndroidSdkHome = process.env.ANDROID_SDK_HOME;
    await mkdir(tmpdir(), { recursive: true });
    const sdkHome = await mkdtemp(join(tmpdir(), 'jc-android-sdk-home-'));
    const avdDir = join(sdkHome, '.android', 'avd', 'Pixel_8_API_35.avd');
    await mkdir(avdDir, { recursive: true });
    await writeFile(join(avdDir, 'config.ini'), 'hw.ramSize=1536\n');
    delete process.env.ANDROID_AVD_HOME;
    process.env.ANDROID_SDK_HOME = sdkHome;
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'emulator' && args.join(' ') === '-list-avds') {
        return { stdout: '', stderr: '' };
      }
      if (command === 'sdkmanager' && args.includes('--list_installed')) {
        return {
          stdout: 'platforms;android-35 | 2 | Android SDK Platform 35\n',
          stderr: '',
        };
      }
      if (command === 'avdmanager' && args.includes('create')) {
        return { stdout: '', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    try {
      await androidAdapter.createAndroidDevice({
        name: 'Pixel_8_API_35',
        deviceProfileId: 'pixel_8',
        systemImageId: 'system-images;android-35;google_apis;arm64-v8a',
        ramMb: 4096,
      });

      await expect(readFile(join(avdDir, 'config.ini'), 'utf8')).resolves.toBe(
        'hw.ramSize=4096\n',
      );
    } finally {
      if (originalAndroidAvdHome === undefined) {
        delete process.env.ANDROID_AVD_HOME;
      } else {
        process.env.ANDROID_AVD_HOME = originalAndroidAvdHome;
      }
      if (originalAndroidSdkHome === undefined) {
        delete process.env.ANDROID_SDK_HOME;
      } else {
        process.env.ANDROID_SDK_HOME = originalAndroidSdkHome;
      }
      await rm(sdkHome, { force: true, recursive: true });
    }
  });

  it('does not overwrite existing Android AVDs', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'emulator' && args.join(' ') === '-list-avds') {
        return { stdout: 'Pixel_8_API_35\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    await expect(
      androidAdapter.createAndroidDevice({
        name: 'Pixel_8_API_35',
        deviceProfileId: 'pixel_8',
        systemImageId: 'system-images;android-35;google_apis;arm64-v8a',
      }),
    ).rejects.toThrow('Android device already exists: Pixel_8_API_35');
    expect(
      runCommandMock.mock.calls.some(([command]) => command === 'sdkmanager'),
    ).toBe(false);
  });

  it('rejects invalid Android AVD advanced settings before running commands', async () => {
    await expect(
      androidAdapter.createAndroidDevice({
        name: 'Pixel_8_API_35',
        deviceProfileId: 'pixel_8',
        systemImageId: 'system-images;android-35;google_apis;arm64-v8a',
        ramMb: 511,
      }),
    ).rejects.toThrow(/no less than 512/);
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('rejects invalid Android system image ids before installing', async () => {
    await expect(
      androidAdapter.installAndroidSystemImage({ systemImageId: '--licenses' }),
    ).rejects.toThrow('Invalid Android system image id.');
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('deletes Android AVD by name', async () => {
    runCommandMock.mockResolvedValue({ stdout: '', stderr: '' });

    await androidAdapter.deleteAndroidDevice('Pixel_8_API_35');

    expect(runCommandMock).toHaveBeenCalledWith('avdmanager', [
      'delete',
      'avd',
      '--name',
      'Pixel_8_API_35',
    ]);
  });

  it('builds screenrecord args', () => {
    expect(buildAdbScreenrecordArgs('device-1', 15)).toEqual([
      '-s',
      'device-1',
      'exec-out',
      'screenrecord',
      '--output-format=h264',
      '--bit-rate',
      '16000000',
      '--time-limit',
      '180',
      '-',
    ]);
    expect(buildAdbScreenrecordArgs('device-1', 15, 'high')).toContain(
      '16000000',
    );
    expect(buildAdbScreenrecordArgs('device-1', 15, 'very-high')).toContain(
      '24000000',
    );
  });

  it('builds tap args', () => {
    expect(
      buildAdbInputArgs('device-1', { type: 'tap', x: 12, y: 34 }),
    ).toEqual(['-s', 'device-1', 'shell', 'input', 'tap', '12', '34']);
  });

  it('builds live touch lifecycle args', () => {
    expect(
      buildAdbInputArgs('device-1', { type: 'touchDown', x: 12, y: 34 }),
    ).toEqual([
      '-s',
      'device-1',
      'shell',
      'input',
      'motionevent',
      'DOWN',
      '12',
      '34',
    ]);
    expect(
      buildAdbInputArgs('device-1', { type: 'touchMove', x: 20, y: 40 }),
    ).toEqual([
      '-s',
      'device-1',
      'shell',
      'input',
      'motionevent',
      'MOVE',
      '20',
      '40',
    ]);
    expect(
      buildAdbInputArgs('device-1', { type: 'touchUp', x: 25, y: 45 }),
    ).toEqual([
      '-s',
      'device-1',
      'shell',
      'input',
      'motionevent',
      'UP',
      '25',
      '45',
    ]);
  });

  it('builds swipe text and key args', () => {
    expect(
      buildAdbInputArgs('device-1', {
        type: 'swipe',
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        durationMs: 250,
      }),
    ).toEqual([
      '-s',
      'device-1',
      'shell',
      'input',
      'swipe',
      '1',
      '2',
      '3',
      '4',
      '250',
    ]);
    expect(
      buildAdbInputArgs('device-1', {
        type: 'longPress',
        x: 12,
        y: 34,
        durationMs: 650,
      }),
    ).toEqual([
      '-s',
      'device-1',
      'shell',
      'input',
      'swipe',
      '12',
      '34',
      '12',
      '34',
      '650',
    ]);
    expect(
      buildAdbInputArgs('device-1', { type: 'text', text: 'hello world' }),
    ).toEqual(['-s', 'device-1', 'shell', 'input', 'text', 'hello\\ world']);
    expect(buildAdbInputArgs('device-1', { type: 'key', key: 'back' })).toEqual(
      ['-s', 'device-1', 'shell', 'input', 'keyevent', 'KEYCODE_BACK'],
    );
    expect(buildAdbInputArgs('device-1', { type: 'key', key: 'home' })).toEqual(
      ['-s', 'device-1', 'shell', 'input', 'keyevent', 'KEYCODE_HOME'],
    );
    expect(
      buildAdbInputArgs('device-1', { type: 'key', key: 'enter' }),
    ).toEqual([
      '-s',
      'device-1',
      'shell',
      'input',
      'keyevent',
      'KEYCODE_ENTER',
    ]);
    expect(
      buildAdbInputArgs('device-1', { type: 'key', key: 'backspace' }),
    ).toEqual(['-s', 'device-1', 'shell', 'input', 'keyevent', 'KEYCODE_DEL']);
  });

  it('rejects control characters so a newline cannot start a second device-shell command', () => {
    // `adb shell` joins argv into one string parsed by the device shell, so an
    // unescaped newline would terminate `input text` and run what follows.
    expect(() =>
      buildAdbInputArgs('device-1', {
        type: 'text',
        text: 'hello\npm uninstall com.example.app',
      }),
    ).toThrow(/control characters/);
    expect(() =>
      buildAdbInputArgs('device-1', { type: 'text', text: 'a\tb' }),
    ).toThrow(/control characters/);
  });

  it('escapes glob characters so the device shell cannot expand them', () => {
    expect(
      buildAdbInputArgs('device-1', { type: 'text', text: '*?[]~#!' }),
    ).toEqual([
      '-s',
      'device-1',
      'shell',
      'input',
      'text',
      '\\*\\?\\[\\]\\~\\#\\!',
    ]);
  });

  it('escapes remote shell metacharacters in text input', () => {
    expect(
      buildAdbInputArgs('device-1', {
        type: 'text',
        text: 'a;b&c|d$e`f"g\'h(i)j<k>l\\m',
      }),
    ).toEqual([
      '-s',
      'device-1',
      'shell',
      'input',
      'text',
      'a\\;b\\&c\\|d\\$e\\`f\\"g\\\'h\\(i\\)j\\<k\\>l\\\\m',
    ]);
  });

  it('rejects percent text because adb treats percent-s specially', () => {
    expect(() =>
      buildAdbInputArgs('device-1', { type: 'text', text: 'hello %s world' }),
    ).toThrow(/percent characters are not supported.*%s specially/);
    expect(() =>
      buildAdbInputArgs('device-1', { type: 'text', text: '100%' }),
    ).toThrow(/percent characters are not supported.*%s specially/);
  });

  it('sends tap through adb', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return { stdout: 'List of devices attached\ndevice-1 device model:Pixel_8\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await androidAdapter.sendInput('device-1', { type: 'tap', x: 12, y: 34 });

    expect(runCommandMock).toHaveBeenCalledWith('adb', [
      '-s',
      'device-1',
      'shell',
      'input',
      'tap',
      '12',
      '34',
    ], { signal: expect.any(AbortSignal) });
  });

  it('coalesces pending Android touch moves and resolves the device once per gesture', async () => {
    const adapter = createAndroidMobilePreviewAdapter();
    let releaseDown: (() => void) | undefined;
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout: 'List of devices attached\ndevice-flood device model:Pixel_8\n',
          stderr: '',
        };
      }
      if (args.includes('DOWN')) {
        await new Promise<void>((resolve) => {
          releaseDown = resolve;
        });
      }
      return { stdout: '', stderr: '' };
    });

    const down = adapter.sendInput('device-flood', {
      type: 'touchDown',
      x: 1,
      y: 2,
    });
    await vi.waitFor(() => expect(releaseDown).toBeTypeOf('function'));
    const moves = Array.from({ length: 50 }, (_, index) =>
      adapter.sendInput('device-flood', {
        type: 'touchMove' as const,
        x: index + 10,
        y: index + 20,
      }),
    );
    const up = adapter.sendInput('device-flood', {
      type: 'touchUp',
      x: 60,
      y: 70,
    });

    releaseDown?.();
    await Promise.all([down, ...moves, up]);

    const motionCalls = runCommandMock.mock.calls
      .filter(([, args]) => args.includes('motionevent'))
      .map(([, args]) => args.slice(-3));
    expect(motionCalls).toEqual([
      ['DOWN', '1', '2'],
      ['MOVE', '59', '69'],
      ['UP', '60', '70'],
    ]);
    expect(
      runCommandMock.mock.calls.filter(([, args]) => args.join(' ') === 'devices -l'),
    ).toHaveLength(1);
  });

  it('cancels pending Android input and drains active work on disposal', async () => {
    const adapter = createAndroidMobilePreviewAdapter();
    let releaseDown: (() => void) | undefined;
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout: 'List of devices attached\ndevice-dispose device model:Pixel_8\n',
          stderr: '',
        };
      }
      if (args.includes('DOWN')) {
        await new Promise<void>((resolve) => {
          releaseDown = resolve;
        });
      }
      return { stdout: '', stderr: '' };
    });

    const down = adapter.sendInput('device-dispose', {
      type: 'touchDown',
      x: 1,
      y: 2,
    });
    await vi.waitFor(() => expect(releaseDown).toBeTypeOf('function'));
    const move = adapter.sendInput('device-dispose', {
      type: 'touchMove',
      x: 3,
      y: 4,
    });
    let disposed = false;
    const dispose = adapter.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    releaseDown?.();
    await Promise.all([down, move, dispose]);

    expect(
      runCommandMock.mock.calls.filter(([, args]) => args.includes('motionevent')),
    ).toHaveLength(1);
  });

  it('cancels only the stopped Android session on a shared device', async () => {
    const startScrcpyStream = vi.fn().mockResolvedValue({
      stop: vi.fn().mockResolvedValue(undefined),
    });
    const adapter = createAndroidMobilePreviewAdapter({ startScrcpyStream });
    let releaseDown: (() => void) | undefined;
    let blockedDown = false;
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout: 'List of devices attached\ndevice-shared device model:Pixel_8\n',
          stderr: '',
        };
      }
      if (command === 'adb' && args.join(' ') === '-s device-shared shell wm size') {
        return { stdout: 'Physical size: 1080x2400\n', stderr: '' };
      }
      if (args.includes('DOWN') && !blockedDown) {
        blockedDown = true;
        await new Promise<void>((resolve) => {
          releaseDown = resolve;
        });
      }
      return { stdout: '', stderr: '' };
    });
    const [first, second] = await Promise.all([
      adapter.startStream({
        taskId: 'task-a',
        deviceId: 'device-shared',
        onFrame: vi.fn(),
        onSession: vi.fn(),
      }),
      adapter.startStream({
        taskId: 'task-b',
        deviceId: 'device-shared',
        onFrame: vi.fn(),
        onSession: vi.fn(),
      }),
    ]);

    const down = adapter.sendInput(
      'device-shared',
      { type: 'touchDown', x: 1, y: 2 },
      first.session.id,
    );
    await vi.waitFor(() => expect(releaseDown).toBeTypeOf('function'));
    const staleMove = adapter.sendInput(
      'device-shared',
      { type: 'touchMove', x: 3, y: 4 },
      first.session.id,
    );
    const liveMove = adapter.sendInput(
      'device-shared',
      { type: 'touchDown', x: 5, y: 6 },
      second.session.id,
    );
    const stopFirst = first.stop();
    releaseDown?.();
    await Promise.all([down, staleMove, liveMove, stopFirst]);

    expect(
      runCommandMock.mock.calls
        .filter(([, args]) => args.includes('motionevent'))
        .map(([, args]) => args.slice(-3)),
    ).toEqual([
      ['DOWN', '1', '2'],
      ['UP', '1', '2'],
      ['DOWN', '5', '6'],
    ]);
    await second.stop();
    await adapter.dispose();
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
  ])('revalidates a stopped Android session before $name command launch', async ({ event }) => {
    const adapter = createAndroidMobilePreviewAdapter({
      startScrcpyStream: vi.fn().mockResolvedValue({
        stop: vi.fn().mockResolvedValue(undefined),
      }),
    });
    let blockResolution = false;
    let releaseResolution: (() => void) | undefined;
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        if (blockResolution) {
          await new Promise<void>((resolve) => {
            releaseResolution = resolve;
          });
        }
        return {
          stdout: 'List of devices attached\ndevice-revalidate device model:Pixel_8\n',
          stderr: '',
        };
      }
      if (command === 'adb' && args.join(' ') === '-s device-revalidate shell wm size') {
        return { stdout: 'Physical size: 1080x2400\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const stream = await adapter.startStream({
      taskId: 'task-revalidate',
      deviceId: 'device-revalidate',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    blockResolution = true;
    const input = adapter.sendInput('device-revalidate', event, stream.session.id);
    await vi.waitFor(() => expect(releaseResolution).toBeTypeOf('function'));

    const stop = stream.stop();
    releaseResolution?.();
    await Promise.all([stop, input]);

    expect(
      runCommandMock.mock.calls.some(([, args]) =>
        args.includes(event.type === 'tap' ? 'tap' : 'swipe'),
      ),
    ).toBe(false);
    await adapter.dispose();
  });

  it('aborts only the stopped session in-flight Android tap', async () => {
    const adapter = createAndroidMobilePreviewAdapter({
      startScrcpyStream: vi.fn().mockResolvedValue({
        stop: vi.fn().mockResolvedValue(undefined),
      }),
    });
    runCommandMock.mockImplementation(async (_command, args) => {
      if (args.join(' ') === 'devices -l') {
        return {
          stdout: 'List of devices attached\ndevice-owned device model:Pixel_8\n',
          stderr: '',
        };
      }
      return { stdout: 'Physical size: 1080x2400\n', stderr: '' };
    });
    const [first, second] = await Promise.all([
      adapter.startStream({
        taskId: 'task-owned-a',
        deviceId: 'device-owned',
        onFrame: vi.fn(),
        onSession: vi.fn(),
      }),
      adapter.startStream({
        taskId: 'task-owned-b',
        deviceId: 'device-owned',
        onFrame: vi.fn(),
        onSession: vi.fn(),
      }),
    ]);
    let firstSignal: AbortSignal | undefined;
    let secondSignal: AbortSignal | undefined;
    let rejectFirstClose: (() => void) | undefined;
    runCommandMock.mockImplementation((_command, args, options) => {
      if (args.join(' ') === 'devices -l') {
        return Promise.resolve({
          stdout: 'List of devices attached\ndevice-owned device model:Pixel_8\n',
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
    const firstInput = adapter
      .sendInput(
        'device-owned',
        { type: 'tap', x: 1, y: 2 },
        first.session.id,
      )
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(firstSignal).toBeDefined());
    await adapter.sendInput(
      'device-owned',
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
    await adapter.dispose();
  });

  it('aborts and awaits an in-flight Android swipe during disposal', async () => {
    const adapter = createAndroidMobilePreviewAdapter();
    let swipeSignal: AbortSignal | undefined;
    let rejectSwipeClose: (() => void) | undefined;
    runCommandMock.mockImplementation((_command, args, options) => {
      if (args.join(' ') === 'devices -l') {
        return Promise.resolve({
          stdout: 'List of devices attached\ndevice-swipe device model:Pixel_8\n',
          stderr: '',
        });
      }
      if (args.includes('swipe')) swipeSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        rejectSwipeClose = () => reject(new Error('swipe aborted after close'));
      });
    });
    const input = adapter
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
    const dispose = adapter.dispose().then(() => {
      disposed = true;
    });
    await vi.waitFor(() => expect(swipeSignal?.aborted).toBe(true));
    expect(disposed).toBe(false);
    rejectSwipeClose?.();
    await Promise.all([input, dispose]);
  });

  it('replaces a canceled Android touch up with one compensating up and clears gesture state', async () => {
    const adapter = createAndroidMobilePreviewAdapter({
      startScrcpyStream: vi.fn().mockResolvedValue({
        stop: vi.fn().mockResolvedValue(undefined),
      }),
    });
    let releaseMove: (() => void) | undefined;
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout: 'List of devices attached\ndevice-up device model:Pixel_8\n',
          stderr: '',
        };
      }
      if (command === 'adb' && args.join(' ') === '-s device-up shell wm size') {
        return { stdout: 'Physical size: 1080x2400\n', stderr: '' };
      }
      if (args.includes('MOVE')) {
        await new Promise<void>((resolve) => {
          releaseMove = resolve;
        });
      }
      return { stdout: '', stderr: '' };
    });
    const first = await adapter.startStream({
      taskId: 'task-up-a',
      deviceId: 'device-up',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    const second = await adapter.startStream({
      taskId: 'task-up-b',
      deviceId: 'device-up',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    await adapter.sendInput(
      'device-up',
      { type: 'touchDown', x: 1, y: 2 },
      first.session.id,
    );
    const move = adapter.sendInput(
      'device-up',
      { type: 'touchMove', x: 3, y: 4 },
      first.session.id,
    );
    await vi.waitFor(() => expect(releaseMove).toBeTypeOf('function'));
    const staleUp = adapter.sendInput(
      'device-up',
      { type: 'touchUp', x: 5, y: 6 },
      first.session.id,
    );
    const stop = first.stop();
    releaseMove?.();
    await Promise.all([move, staleUp, stop]);
    await adapter.sendInput(
      'device-up',
      { type: 'touchDown', x: 7, y: 8 },
      second.session.id,
    );
    await adapter.sendInput(
      'device-up',
      { type: 'touchUp', x: 9, y: 10 },
      second.session.id,
    );

    expect(
      runCommandMock.mock.calls
        .filter(([, args]) => args.includes('motionevent'))
        .map(([, args]) => args.slice(-3)),
    ).toEqual([
      ['DOWN', '1', '2'],
      ['MOVE', '3', '4'],
      ['UP', '3', '4'],
      ['DOWN', '7', '8'],
      ['UP', '9', '10'],
    ]);
    await second.stop();
    await adapter.dispose();
  });

  it('compensates the old Android gesture before concurrent session takeover', async () => {
    const adapter = createAndroidMobilePreviewAdapter({
      startScrcpyStream: vi.fn().mockResolvedValue({
        stop: vi.fn().mockResolvedValue(undefined),
      }),
    });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout: 'List of devices attached\ndevice-takeover device model:Pixel_8\n',
          stderr: '',
        };
      }
      if (command === 'adb' && args.join(' ') === '-s device-takeover shell wm size') {
        return { stdout: 'Physical size: 1080x2400\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const [first, second] = await Promise.all([
      adapter.startStream({
        taskId: 'task-takeover-a',
        deviceId: 'device-takeover',
        onFrame: vi.fn(),
        onSession: vi.fn(),
      }),
      adapter.startStream({
        taskId: 'task-takeover-b',
        deviceId: 'device-takeover',
        onFrame: vi.fn(),
        onSession: vi.fn(),
      }),
    ]);
    await adapter.sendInput(
      'device-takeover',
      { type: 'touchDown', x: 1, y: 2 },
      first.session.id,
    );
    await Promise.all([
      adapter.sendInput(
        'device-takeover',
        { type: 'touchDown', x: 10, y: 20 },
        second.session.id,
      ),
      adapter.sendInput(
        'device-takeover',
        { type: 'touchMove', x: 3, y: 4 },
        first.session.id,
      ),
    ]);
    await adapter.sendInput(
      'device-takeover',
      { type: 'touchUp', x: 30, y: 40 },
      second.session.id,
    );

    expect(
      runCommandMock.mock.calls
        .filter(([, args]) => args.includes('motionevent'))
        .map(([, args]) => args.slice(-3)),
    ).toEqual([
      ['DOWN', '1', '2'],
      ['UP', '1', '2'],
      ['DOWN', '10', '20'],
      ['UP', '30', '40'],
    ]);
    await Promise.all([first.stop(), second.stop()]);
    await adapter.dispose();
  });

  it('drops cached Android serial when cancellation wins before DOWN write', async () => {
    const adapter = createAndroidMobilePreviewAdapter({
      startScrcpyStream: vi.fn().mockResolvedValue({
        stop: vi.fn().mockResolvedValue(undefined),
      }),
    });
    let blockResolution = false;
    let releaseResolution: (() => void) | undefined;
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        if (blockResolution) {
          blockResolution = false;
          await new Promise<void>((resolve) => {
            releaseResolution = resolve;
          });
        }
        return {
          stdout: 'List of devices attached\ndevice-cancel-resolve device model:Pixel_8\n',
          stderr: '',
        };
      }
      if (
        command === 'adb' &&
        args.join(' ') === '-s device-cancel-resolve shell wm size'
      ) {
        return { stdout: 'Physical size: 1080x2400\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const [first, second] = await Promise.all([
      adapter.startStream({
        taskId: 'task-cancel-resolve-a',
        deviceId: 'device-cancel-resolve',
        onFrame: vi.fn(),
        onSession: vi.fn(),
      }),
      adapter.startStream({
        taskId: 'task-cancel-resolve-b',
        deviceId: 'device-cancel-resolve',
        onFrame: vi.fn(),
        onSession: vi.fn(),
      }),
    ]);
    blockResolution = true;
    const staleDown = adapter.sendInput(
      'device-cancel-resolve',
      { type: 'touchDown', x: 1, y: 2 },
      first.session.id,
    );
    await vi.waitFor(() => expect(releaseResolution).toBeTypeOf('function'));
    const stopFirst = first.stop();
    releaseResolution?.();
    await Promise.all([staleDown, stopFirst]);
    const resolutionsBeforeLiveDown = runCommandMock.mock.calls.filter(
      ([, args]) => args.join(' ') === 'devices -l',
    ).length;

    await adapter.sendInput(
      'device-cancel-resolve',
      { type: 'touchDown', x: 3, y: 4 },
      second.session.id,
    );

    expect(
      runCommandMock.mock.calls.filter(([, args]) => args.join(' ') === 'devices -l'),
    ).toHaveLength(resolutionsBeforeLiveDown + 1);
    expect(
      runCommandMock.mock.calls
        .filter(([, args]) => args.includes('motionevent'))
        .map(([, args]) => args.slice(-3)),
    ).toEqual([['DOWN', '3', '4']]);
    await second.stop();
    await adapter.dispose();
  });

  it('resolves AVD names before sending Android input', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout:
            'List of devices attached\nemulator-5554 device model:Medium_Phone\n',
          stderr: '',
        };
      }
      if (command === 'adb' && args.join(' ') === '-s emulator-5554 emu avd name') {
        return { stdout: 'Medium_Phone\nOK\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await androidAdapter.sendInput('Medium_Phone', { type: 'tap', x: 611, y: 829 });

    expect(runCommandMock).toHaveBeenCalledWith('adb', [
      '-s',
      'emulator-5554',
      'shell',
      'input',
      'tap',
      '611',
      '829',
    ], { signal: expect.any(AbortSignal) });
  });

  it('treats Android show keyboard as best-effort when cmd input_method fails', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return { stdout: 'List of devices attached\ndevice-1 device model:Pixel_8\n', stderr: '' };
      }
      if (
        command === 'adb' &&
        args.join(' ') === '-s device-1 shell cmd input_method show-soft-input'
      ) {
        throw new Error('Command failed with exit code 255');
      }
      return { stdout: '', stderr: '' };
    });

    await expect(
      androidAdapter.sendInput('device-1', { type: 'showKeyboard' }),
    ).resolves.toBeUndefined();

    expect(runCommandMock).toHaveBeenCalledWith('adb', [
      '-s',
      'device-1',
      'shell',
      'cmd',
      'input_method',
      'show-soft-input',
    ], { signal: expect.any(AbortSignal) });
    expect(runCommandMock).toHaveBeenCalledWith('adb', [
      '-s',
      'device-1',
      'shell',
      'input',
      'keyevent',
      'KEYCODE_MENU',
    ], { signal: expect.any(AbortSignal) });
  });

  it('sets Android color scheme through adb uimode', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return { stdout: 'List of devices attached\ndevice-1 device model:Pixel_8\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await androidAdapter.setColorScheme('device-1', 'dark');

    expect(runCommandMock).toHaveBeenCalledWith('adb', [
      '-s',
      'device-1',
      'shell',
      'cmd',
      'uimode',
      'night',
      'yes',
    ]);
  });

  it('bounds Android deeplink native command', async () => {
    runCommandMock.mockImplementation(async (_command, args) => {
      if (args.join(' ') === 'devices -l') {
        return {
          stdout: 'List of devices attached\nemulator-5554 device model:Pixel_8\n',
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    await androidAdapter.openDeeplink(
      'emulator-5554',
      'exp://127.0.0.1:19001',
    );

    expect(runCommandMock).toHaveBeenCalledWith(
      'adb',
      [
        '-s',
        'emulator-5554',
        'shell',
        'am',
        'start',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        'exp://127.0.0.1:19001',
      ],
      {
        signal: expect.any(AbortSignal),
        timeoutMs: MOBILE_PREVIEW_DEEPLINK_OPEN_TIMEOUT_MS,
      },
    );
  });

  it('aborts Android native deeplink process from external launch cancellation', async () => {
    let nativeSignal: AbortSignal | undefined;
    let notifyNativeStarted!: () => void;
    const nativeStarted = new Promise<void>((resolve) => {
      notifyNativeStarted = resolve;
    });
    runCommandMock.mockImplementation(async (_command, args, options) => {
      if (args.join(' ') === 'devices -l') {
        return {
          stdout: 'List of devices attached\nemulator-5554 device model:Pixel_8\n',
          stderr: '',
        };
      }
      return new Promise((_resolve, reject) => {
        nativeSignal = options?.signal;
        notifyNativeStarted();
        options?.signal?.addEventListener(
          'abort',
          () => reject(options.signal?.reason),
          { once: true },
        );
      });
    });
    const controller = new AbortController();

    const opening = androidAdapter.openDeeplink(
      'emulator-5554',
      'exp://127.0.0.1:19001',
      controller.signal,
    );
    const outcome = opening.catch((error: unknown) => error);
    await nativeStarted;
    controller.abort(new DOMException('cancelled', 'AbortError'));

    await expect(outcome).resolves.toMatchObject({ name: 'AbortError' });
    expect(nativeSignal?.aborted).toBe(true);
  });

  it('times out hung adb device resolution and allows a later open', async () => {
    let deviceLookupCount = 0;
    runCommandMock.mockImplementation(async (_command, args, options) => {
      if (args.join(' ') === 'devices -l') {
        deviceLookupCount += 1;
        if (deviceLookupCount === 1) {
          return new Promise((_resolve, reject) => {
            const fallback = setTimeout(
              () => reject(new Error('adb lookup remained unbounded')),
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
        return {
          stdout: 'List of devices attached\nemulator-5554 device model:Pixel_8\n',
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(
      androidAdapter.openDeeplink(
        'emulator-5554',
        'exp://127.0.0.1:19001/first',
      ),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    await expect(
      androidAdapter.openDeeplink(
        'emulator-5554',
        'exp://127.0.0.1:19001/second',
      ),
    ).resolves.toBeUndefined();

    expect(deviceLookupCount).toBe(2);
    expect(runCommandMock).toHaveBeenCalledWith(
      'adb',
      ['devices', '-l'],
      { signal: expect.any(AbortSignal) },
    );
  });

  it('leaves Android rotation to the renderer preview transform', async () => {
    await androidAdapter.rotate('emulator-5554', 'left');

    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('throws actionable missing adb error', async () => {
    commandExistsMock.mockResolvedValue(false);

    await expect(androidAdapter.listDevices()).rejects.toThrow(
      /Missing required Android preview tool: adb.*brew install --cask android-platform-tools/i,
    );
  });

  it('falls back to adb screenrecord when scrcpy is unavailable', async () => {
    const h264Frame = Buffer.from([0, 0, 0, 1]);
    const onFrame = vi.fn();
    const startScrcpyStream = vi.fn().mockRejectedValue(new Error('no scrcpy'));
    const adapter = createAndroidMobilePreviewAdapter({ startScrcpyStream });
    spawnManagedMock.mockImplementation(() => {
      queueMicrotask(() => stdout.emit('data', h264Frame));
      return {
        child: child as never,
        stop: vi.fn().mockResolvedValue(undefined),
      };
    });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout: 'List of devices attached\ndevice-1 device model:Pixel_8\n',
          stderr: '',
        };
      }
      if (command === 'adb' && args.join(' ') === '-s device-1 shell wm size') {
        return { stdout: 'Physical size: 1080x2400\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    const stream = await adapter.startStream({
      taskId: 'task-1',
      deviceId: 'device-1',
      fps: 30,
      onFrame,
      onSession: vi.fn(),
    });
    await stream.stop();

    expect(stream).toMatchObject({
      session: {
        taskId: 'task-1',
        platform: 'android',
        deviceId: 'device-1',
        status: 'streaming',
        width: 1080,
        height: 2400,
        frameFormat: 'h264',
        streamStrategy: 'adb-screenrecord',
        inputStatus: 'ready',
        error: 'scrcpy unavailable: no scrcpy',
      },
    });

    expect(runCommandMock).toHaveBeenCalledWith('adb', [
      '-s',
      'device-1',
      'shell',
      'wm',
      'size',
    ]);
    expect(onFrame).toHaveBeenCalledWith(h264Frame);
    expect(spawnManagedMock).toHaveBeenCalledWith(
      'adb',
      buildAdbScreenrecordArgs('device-1', 30),
    );
    expect(runBinaryCommandMock).not.toHaveBeenCalled();
  });

  it('starts scrcpy by default and forwards h264 frames', async () => {
    const h264Frame = Buffer.from([0, 0, 0, 1]);
    const onFrame = vi.fn();
    const onSession = vi.fn();
    const startScrcpyStream = vi.fn(
      async ({
        onFrame: emitFrame,
        onSize,
      }: {
        onFrame: (frame: Buffer) => void;
        onSize: (size: { width: number; height: number }) => void;
      }) => {
        onSize({ width: 488, height: 1080 });
        emitFrame(h264Frame);
        return { stop: vi.fn().mockResolvedValue(undefined) };
      },
    );
    const adapter = createAndroidMobilePreviewAdapter({ startScrcpyStream });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout:
            'List of devices attached\nemulator-5554 device model:Pixel_8\n',
          stderr: '',
        };
      }
      if (
        command === 'adb' &&
        args.join(' ') === '-s emulator-5554 shell wm size'
      ) {
        return { stdout: 'Physical size: 1080x2400\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    const { session } = await adapter.startStream({
      taskId: 'task-1',
      deviceId: 'emulator-5554',
      fps: 30,
      quality: 'high',
      onFrame,
      onSession,
    });

    expect(session.frameFormat).toBe('h264');
    expect(session.streamStrategy).toBe('scrcpy');
    expect(session.width).toBe(1080);
    expect(session.height).toBe(2400);
    expect(startScrcpyStream).toHaveBeenCalledWith(
      expect.objectContaining({
        adbSerial: 'emulator-5554',
        fps: 30,
        quality: 'high',
      }),
    );
    expect(onFrame).toHaveBeenCalledWith(h264Frame);
    expect(onSession).not.toHaveBeenCalledWith({ width: 488, height: 1080 });
  });

  it('refuses to boot an emulator for a disconnected physical serial', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return { stdout: 'List of devices attached\n', stderr: '' };
      }
      if (command === 'emulator' && args.join(' ') === '-list-avds') {
        return { stdout: 'Pixel_8\nPixel_9\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    await expect(
      androidAdapter.openDevMenu('1A2B3C4D'),
    ).rejects.toThrow('Device 1A2B3C4D is no longer connected.');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses to boot an emulator for an unplugged emulator-style serial', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return { stdout: 'List of devices attached\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    await expect(androidAdapter.openDevMenu('emulator-5556')).rejects.toThrow(
      'Device emulator-5556 is no longer connected.',
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('reports a disconnected physical serial when the emulator tool is missing', async () => {
    commandExistsMock.mockImplementation(async (command) => command === 'adb');
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return { stdout: 'List of devices attached\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    await expect(androidAdapter.openDevMenu('1A2B3C4D')).rejects.toThrow(
      'Device 1A2B3C4D is no longer connected.',
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses to install on an unauthorized device with the actionable reason', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout: 'List of devices attached\n1A2B3C4D unauthorized usb:1-2\n',
          stderr: '',
        };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    await expect(
      androidAdapter.installAndroidApk({
        deviceId: '1A2B3C4D',
        apkPath: '/tmp/app.apk',
      }),
    ).rejects.toThrow('Accept the USB debugging prompt on the device.');
  });

  it('installs an APK whose path contains the word Failure', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout: 'List of devices attached\n1A2B3C4D device\n',
          stderr: '',
        };
      }
      if (command === 'adb' && args.includes('install')) {
        return {
          stdout:
            'Performing Streamed Install: /tmp/FailureRepro/app.apk\nSuccess\n',
          stderr: '',
        };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    await expect(
      androidAdapter.installAndroidApk({
        deviceId: '1A2B3C4D',
        apkPath: '/tmp/FailureRepro/app.apk',
      }),
    ).resolves.toBeUndefined();
  });

  it('installs an APK on a physical device serial', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout:
            'List of devices attached\n1A2B3C4D device model:Pixel_7 transport_id:2\n',
          stderr: '',
        };
      }
      if (
        command === 'adb' &&
        args.join(' ') === '-s 1A2B3C4D install -r /tmp/app.apk'
      ) {
        return { stdout: 'Performing Streamed Install\nSuccess\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    await expect(
      androidAdapter.installAndroidApk({
        deviceId: '1A2B3C4D',
        apkPath: '/tmp/app.apk',
      }),
    ).resolves.toBeUndefined();
  });

  it('surfaces adb install failures as errors', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout: 'List of devices attached\n1A2B3C4D device\n',
          stderr: '',
        };
      }
      if (command === 'adb' && args.includes('install')) {
        return {
          stdout: 'Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]\n',
          stderr: '',
        };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    await expect(
      androidAdapter.installAndroidApk({
        deviceId: '1A2B3C4D',
        apkPath: '/tmp/app.apk',
      }),
    ).rejects.toThrow(
      'Failed to install /tmp/app.apk on 1A2B3C4D: INSTALL_FAILED_INSUFFICIENT_STORAGE',
    );
  });

  it('launches an Android app through monkey and through an explicit activity', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout: 'List of devices attached\n1A2B3C4D device\n',
          stderr: '',
        };
      }
      if (command === 'adb' && args.includes('monkey')) {
        return { stdout: 'Events injected: 1\n', stderr: '' };
      }
      if (command === 'adb' && args.includes('am')) {
        return { stdout: 'Starting: Intent { ... }\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    await androidAdapter.launchAndroidApp({
      deviceId: '1A2B3C4D',
      packageName: 'com.example.app',
    });
    await androidAdapter.launchAndroidApp({
      deviceId: '1A2B3C4D',
      packageName: 'com.example.app',
      activity: '.MainActivity',
    });

    const adbArgs = runCommandMock.mock.calls
      .filter(([command]) => command === 'adb')
      .map(([, args]) => args.join(' '));
    expect(adbArgs).toContain(
      '-s 1A2B3C4D shell monkey -p com.example.app -c android.intent.category.LAUNCHER 1',
    );
    expect(adbArgs).toContain(
      '-s 1A2B3C4D shell am start -n com.example.app/.MainActivity',
    );
  });

  it('surfaces Android launch errors reported on stdout', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout: 'List of devices attached\n1A2B3C4D device\n',
          stderr: '',
        };
      }
      if (command === 'adb' && args.includes('monkey')) {
        return {
          stdout:
            'No activities found to run, monkey aborted.\n',
          stderr: '',
        };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    await expect(
      androidAdapter.launchAndroidApp({
        deviceId: '1A2B3C4D',
        packageName: 'com.example.app',
      }),
    ).rejects.toThrow('Failed to launch com.example.app on 1A2B3C4D');
  });

  it('resolves a booted AVD name to its adb serial without launching another emulator', async () => {
    const h264Frame = Buffer.from([0, 0, 0, 1]);
    const startScrcpyStream = vi.fn(
      async ({
        onFrame: emitFrame,
        onSize,
      }: {
        onFrame: (frame: Buffer) => void;
        onSize: (size: { width: number; height: number }) => void;
      }) => {
        onSize({ width: 1080, height: 2400 });
        emitFrame(h264Frame);
        return { stop: vi.fn().mockResolvedValue(undefined) };
      },
    );
    const adapter = createAndroidMobilePreviewAdapter({ startScrcpyStream });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout:
            'List of devices attached\nemulator-5554 device model:Pixel_8\n',
          stderr: '',
        };
      }
      if (command === 'adb' && args.join(' ') === '-s emulator-5554 emu avd name') {
        return { stdout: 'Pixel_8\nOK\n', stderr: '' };
      }
      if (
        command === 'adb' &&
        args.join(' ') === '-s emulator-5554 shell wm size'
      ) {
        return { stdout: 'Physical size: 1080x2400\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    const { session } = await adapter.startStream({
      taskId: 'task-1',
      deviceId: 'Pixel_8',
      fps: 30,
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });

    expect(session.deviceId).toBe('Pixel_8');
    expect(startScrcpyStream).toHaveBeenCalledWith(
      expect.objectContaining({ adbSerial: 'emulator-5554' }),
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('falls back to adb screenrecord when scrcpy startup fails', async () => {
    const onFrame = vi.fn();
    const h264Frame = Buffer.from([0, 0, 0, 1]);
    const startScrcpyStream = vi.fn().mockRejectedValue(new Error('no scrcpy'));
    const adapter = createAndroidMobilePreviewAdapter({ startScrcpyStream });
    spawnManagedMock.mockImplementation(() => {
      queueMicrotask(() => stdout.emit('data', h264Frame));
      return {
        child: child as never,
        stop: vi.fn().mockResolvedValue(undefined),
      };
    });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout:
            'List of devices attached\nemulator-5554 device model:Pixel_8\n',
          stderr: '',
        };
      }
      if (
        command === 'adb' &&
        args.join(' ') === '-s emulator-5554 shell wm size'
      ) {
        return { stdout: 'Physical size: 1080x2400\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    const { session, stop } = await adapter.startStream({
      taskId: 'task-1',
      deviceId: 'emulator-5554',
      fps: 30,
      onFrame,
      onSession: vi.fn(),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await stop();

    expect(session.frameFormat).toBe('h264');
    expect(session.streamStrategy).toBe('adb-screenrecord');
    expect(session.error).toBe('scrcpy unavailable: no scrcpy');
    expect(startScrcpyStream).toHaveBeenCalledWith(
      expect.objectContaining({ adbSerial: 'emulator-5554', fps: 30 }),
    );
    expect(onFrame).toHaveBeenCalledWith(h264Frame);
  });

  it('falls back to adb screenrecord when scrcpy startup hangs', async () => {
    vi.useFakeTimers();
    const onFrame = vi.fn();
    const h264Frame = Buffer.from([0, 0, 0, 1]);
    const startScrcpyStream = vi.fn(() => new Promise<never>(() => undefined));
    const adapter = createAndroidMobilePreviewAdapter({ startScrcpyStream });
    spawnManagedMock.mockImplementation(() => {
      queueMicrotask(() => stdout.emit('data', h264Frame));
      return {
        child: child as never,
        stop: vi.fn().mockResolvedValue(undefined),
      };
    });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout:
            'List of devices attached\nemulator-5554 device model:Pixel_8\n',
          stderr: '',
        };
      }
      if (
        command === 'adb' &&
        args.join(' ') === '-s emulator-5554 shell wm size'
      ) {
        return { stdout: 'Physical size: 1080x2400\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    const startPromise = adapter.startStream({
      taskId: 'task-1',
      deviceId: 'emulator-5554',
      fps: 30,
      onFrame,
      onSession: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const { session, stop } = await startPromise;
    await vi.advanceTimersByTimeAsync(0);
    await stop();

    expect(session.frameFormat).toBe('h264');
    expect(session.streamStrategy).toBe('adb-screenrecord');
    expect(session.error).toBe(
      'scrcpy unavailable: Timed out starting Android scrcpy stream.',
    );
    expect(onFrame).toHaveBeenCalledWith(h264Frame);
  });

  it('switches to adb screenrecord when scrcpy fails after startup', async () => {
    const onFrame = vi.fn();
    const onSession = vi.fn();
    const fallbackFrame = Buffer.from([0, 0, 0, 2]);
    const h264Frame = Buffer.from([0, 0, 0, 1]);
    const scrcpyStop = vi.fn().mockResolvedValue(undefined);
    let emitError!: (error: Error) => void;
    const startScrcpyStream = vi.fn(
      async ({
        onFrame: emitFrame,
        onError,
      }: {
        onFrame: (frame: Buffer) => void;
        onError: (error: Error) => void;
      }) => {
        emitError = onError;
        emitFrame(h264Frame);
        return { stop: scrcpyStop };
      },
    );
    const adapter = createAndroidMobilePreviewAdapter({ startScrcpyStream });
    spawnManagedMock.mockImplementation(() => {
      queueMicrotask(() => stdout.emit('data', fallbackFrame));
      return {
        child: child as never,
        stop: vi.fn().mockResolvedValue(undefined),
      };
    });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout:
            'List of devices attached\nemulator-5554 device model:Pixel_8\n',
          stderr: '',
        };
      }
      if (
        command === 'adb' &&
        args.join(' ') === '-s emulator-5554 shell wm size'
      ) {
        return { stdout: 'Physical size: 1080x2400\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    const { stop } = await adapter.startStream({
      taskId: 'task-1',
      deviceId: 'emulator-5554',
      fps: 30,
      onFrame,
      onSession,
    });
    emitError(new Error('scrcpy stream died'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await stop();

    expect(scrcpyStop).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledWith(fallbackFrame);
    expect(onSession).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'scrcpy unavailable: scrcpy stream died',
        frameFormat: 'h264',
        streamStrategy: 'adb-screenrecord',
        status: 'streaming',
      }),
    );
  });

  it('falls back to adb screenshots when scrcpy and screenrecord fail', async () => {
    const onFrame = vi.fn();
    const screenshot = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const startScrcpyStream = vi.fn().mockRejectedValue(new Error('no scrcpy'));
    const adapter = createAndroidMobilePreviewAdapter({ startScrcpyStream });
    spawnManagedMock.mockImplementation(() => {
      queueMicrotask(() => child.emit('close', 1));
      return {
        child: child as never,
        stop: vi.fn().mockResolvedValue(undefined),
      };
    });
    runBinaryCommandMock.mockResolvedValue({ stdout: screenshot, stderr: '' });
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout: 'List of devices attached\ndevice-1 device model:Pixel_8\n',
          stderr: '',
        };
      }
      if (command === 'adb' && args.join(' ') === '-s device-1 shell wm size') {
        return { stdout: 'Physical size: 1080x2400\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    const stream = await adapter.startStream({
      taskId: 'task-1',
      deviceId: 'device-1',
      onFrame,
      onSession: vi.fn(),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await stream.stop();

    expect(stream.session.frameFormat).toBe('png');
    expect(stream.session.streamStrategy).toBe('adb-screenshot');
    expect(stream.session.error).toBe(
      'scrcpy unavailable: no scrcpy; adb screenrecord unavailable: Android adb screenrecord exited with code 1',
    );
    expect(onFrame).toHaveBeenCalledWith(screenshot);
  });

  it('aborts and awaits an in-flight adb screenshot during disposal', async () => {
    const startScrcpyStream = vi.fn().mockRejectedValue(new Error('no scrcpy'));
    const adapter = createAndroidMobilePreviewAdapter({ startScrcpyStream });
    const captureSignals: AbortSignal[] = [];
    const rejectCaptureCloses: Array<() => void> = [];
    spawnManagedMock.mockImplementation(() => {
      queueMicrotask(() => child.emit('close', 1));
      return {
        child: child as never,
        stop: vi.fn().mockResolvedValue(undefined),
      };
    });
    runBinaryCommandMock.mockImplementation(
      (_command, _args, options) =>
        new Promise((_resolve, reject) => {
          captureSignals.push(options!.signal!);
          rejectCaptureCloses.push(() => {
            const error = new Error('Command aborted: adb screencap');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout: 'List of devices attached\ndevice-capture device model:Pixel_8\n',
          stderr: '',
        };
      }
      if (
        command === 'adb' &&
        args.join(' ') === '-s device-capture shell wm size'
      ) {
        return { stdout: 'Physical size: 1080x2400\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });
    await adapter.startStream({
      taskId: 'task-capture',
      deviceId: 'device-capture',
      onFrame: vi.fn(),
      onSession: vi.fn(),
    });
    await vi.waitFor(() => expect(captureSignals.length).toBeGreaterThan(0));

    let disposed = false;
    const dispose = adapter.dispose().then(() => {
      disposed = true;
    });
    await vi.waitFor(() =>
      expect(captureSignals.every((signal) => signal.aborted)).toBe(true),
    );
    expect(disposed).toBe(false);

    rejectCaptureCloses.forEach((rejectCaptureClose) => rejectCaptureClose());
    await dispose;
    expect(disposed).toBe(true);
  });

  it('validates device IDs and finite input values', () => {
    expect(() => buildAdbInputArgs('', { type: 'tap', x: 12, y: 34 })).toThrow(
      /deviceId is required/,
    );
    expect(() =>
      buildAdbInputArgs('device-1', { type: 'tap', x: Number.NaN, y: 34 }),
    ).toThrow(/finite number/);
    expect(() =>
      buildAdbInputArgs('device-1', {
        type: 'swipe',
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        durationMs: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(/finite number/);
  });

  it('rejects non-integer negative and unreasonably large input values', () => {
    expect(() =>
      buildAdbInputArgs('device-1', { type: 'tap', x: 12.5, y: 34 }),
    ).toThrow(/expected an integer/);
    expect(() =>
      buildAdbInputArgs('device-1', { type: 'tap', x: -1, y: 34 }),
    ).toThrow(/non-negative integer/);
    expect(() =>
      buildAdbInputArgs('device-1', { type: 'tap', x: 100_001, y: 34 }),
    ).toThrow(/no greater than 100000/);
    expect(() =>
      buildAdbInputArgs('device-1', {
        type: 'swipe',
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        durationMs: 60_001,
      }),
    ).toThrow(/no greater than 60000/);
  });

  it('builds Android show keyboard args', () => {
    expect(buildAdbInputArgs('device-1', { type: 'showKeyboard' })).toEqual([
      '-s',
      'device-1',
      'shell',
      'cmd',
      'input_method',
      'show-soft-input',
    ]);
  });

  it('parses adb reverse --list output', () => {
    expect(
      parseAdbReverseList(
        '1A2B3C4D tcp:8081 tcp:8081\n(reverse) tcp:9090 tcp:9090\n',
      ),
    ).toEqual([
      { remote: 'tcp:8081', local: 'tcp:8081' },
      { remote: 'tcp:9090', local: 'tcp:9090' },
    ]);
    expect(parseAdbReverseList('')).toEqual([]);
    expect(parseAdbReverseList('   \n\n')).toEqual([]);
    expect(
      parseAdbReverseList('adb: error: no devices/emulators found\n'),
    ).toEqual([]);
    expect(parseAdbReverseList('tcp:8081\n')).toEqual([]);
  });

  it('skips adb reverse when the Metro mapping already exists', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout: 'List of devices attached\n1A2B3C4D device model:Pixel_7\n',
          stderr: '',
        };
      }
      if (command === 'adb' && args.join(' ') === '-s 1A2B3C4D reverse --list') {
        return { stdout: '1A2B3C4D tcp:8081 tcp:8081\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    await expect(
      ensureAndroidMetroReverse({ deviceId: '1A2B3C4D', metroPort: 8081 }),
    ).resolves.toEqual({ reversed: false, alreadyPresent: true });
  });

  it('creates the Metro reverse when it is missing', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout: 'List of devices attached\n1A2B3C4D device model:Pixel_7\n',
          stderr: '',
        };
      }
      if (command === 'adb' && args.join(' ') === '-s 1A2B3C4D reverse --list') {
        return { stdout: '1A2B3C4D tcp:9090 tcp:9090\n', stderr: '' };
      }
      if (
        command === 'adb' &&
        args.join(' ') === '-s 1A2B3C4D reverse tcp:8081 tcp:8081'
      ) {
        return { stdout: '', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    await expect(
      ensureAndroidMetroReverse({ deviceId: '1A2B3C4D', metroPort: 8081 }),
    ).resolves.toEqual({ reversed: true, alreadyPresent: false });
    expect(runCommandMock).toHaveBeenCalledWith(
      'adb',
      ['-s', '1A2B3C4D', 'reverse', 'tcp:8081', 'tcp:8081'],
    );
  });

  it('refuses the Metro reverse on an unauthorized device with the actionable reason', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout: 'List of devices attached\n1A2B3C4D unauthorized usb:1-2\n',
          stderr: '',
        };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    await expect(
      ensureAndroidMetroReverse({ deviceId: '1A2B3C4D', metroPort: 8081 }),
    ).rejects.toThrow('Accept the USB debugging prompt on the device.');
  });

  it('is a no-op for emulators', async () => {
    runCommandMock.mockImplementation(async (command, args) => {
      if (command === 'adb' && args.join(' ') === 'devices -l') {
        return {
          stdout: 'List of devices attached\nemulator-5554 device\n',
          stderr: '',
        };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    await expect(
      ensureAndroidMetroReverse({ deviceId: 'emulator-5554', metroPort: 8081 }),
    ).resolves.toEqual({ reversed: false, alreadyPresent: false });
    expect(
      runCommandMock.mock.calls.some((call) => call[1].includes('reverse')),
    ).toBe(false);
  });

  it('rejects invalid Metro ports', async () => {
    for (const metroPort of [0, 70000, Number.NaN, 1.5]) {
      await expect(
        ensureAndroidMetroReverse({ deviceId: '1A2B3C4D', metroPort }),
      ).rejects.toThrow('Metro port must be between 1 and 65535');
    }
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('rejects invalid IPC input event payloads', () => {
    expect(() => buildAdbInputArgs('device-1', { type: 'drag' })).toThrow(
      /Unsupported Android input event type: drag/,
    );
    expect(() =>
      buildAdbInputArgs('device-1', { type: 'text', text: 123 }),
    ).toThrow(/expected text string/);
    expect(() =>
      buildAdbInputArgs('device-1', { type: 'key', key: 'escape' }),
    ).toThrow(/Unsupported Android key input: escape/);
  });
});
