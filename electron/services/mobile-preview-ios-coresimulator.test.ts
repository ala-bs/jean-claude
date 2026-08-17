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
import { dirname, join } from 'node:path';
import {
  installIosPreviewTestHooks,
  iosIdbAdapter,
  mockFramebufferWithReadyHid,
  pngWithSize,
  runCommandMock,
  spawnManagedMock,
} from './mobile-preview-ios-test-helpers';
import { mkdir, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

describe('mobile preview iOS CoreSimulator framebuffer', () => {
  installIosPreviewTestHooks();

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
});
