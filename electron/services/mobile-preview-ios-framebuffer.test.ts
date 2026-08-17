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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMjpegFrameParser,
  killOrphanedCoreSimulatorHelpers,
  resetOrphanedHelperSweepForTests,
  MAX_MJPEG_PENDING_BYTES,
  SCREENSHOT_POLL_INTERVAL_MS,
} from './mobile-preview-ios-framebuffer';
import { dirname, join } from 'node:path';
import {
  installIosPreviewTestHooks,
  iosIdbAdapter,
  minimizeMobilePreviewWindowsMock,
  mockReadyHidHelper,
  mockSimctlCommands,
  pngWithSize,
  runCommandMock,
  spawnManagedMock,
} from './mobile-preview-ios-test-helpers';
import { mkdir, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runCommand } from './mobile-preview-process';
import { tmpdir } from 'node:os';

describe('mobile preview iOS framebuffer', () => {
  installIosPreviewTestHooks();

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


describe('killOrphanedCoreSimulatorHelpers', () => {
  const helperPath = join(
    tmpdir(),
    'jean-claude-mobile-preview',
    'mobile-preview-ios-framebuffer',
  );

  beforeEach(() => {
    resetOrphanedHelperSweepForTests();
    runCommandMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('kills only helpers re-parented to launchd', async () => {
    runCommandMock.mockResolvedValue({
      stdout: [
        `  111     1 ${helperPath} DEVICE-A 15 0.65`,
        `  222   4242 ${helperPath} DEVICE-B 15 0.65`,
        '  333     1 /usr/bin/some-other-process',
        'garbage line',
      ].join('\n'),
      stderr: '',
    } as Awaited<ReturnType<typeof runCommand>>);
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

    await killOrphanedCoreSimulatorHelpers();

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(111, 'SIGKILL');
    killSpy.mockRestore();
  });

  it('runs once per app run but retries after a failure', async () => {
    runCommandMock.mockRejectedValueOnce(new Error('ps exploded'));
    await killOrphanedCoreSimulatorHelpers();
    expect(runCommandMock).toHaveBeenCalledTimes(1);

    runCommandMock.mockResolvedValue({
      stdout: '',
      stderr: '',
    } as Awaited<ReturnType<typeof runCommand>>);
    await killOrphanedCoreSimulatorHelpers();
    await killOrphanedCoreSimulatorHelpers();
    expect(runCommandMock).toHaveBeenCalledTimes(2);
  });

  it('survives a process that exits between the scan and the kill', async () => {
    runCommandMock.mockResolvedValue({
      stdout: `  111     1 ${helperPath} DEVICE-A`,
      stderr: '',
    } as Awaited<ReturnType<typeof runCommand>>);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });

    await expect(killOrphanedCoreSimulatorHelpers()).resolves.toBeUndefined();
    killSpy.mockRestore();
  });
});
