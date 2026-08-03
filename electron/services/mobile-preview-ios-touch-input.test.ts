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
  mockReadyHidHelper,
  mockSimctlCommands,
  runCommandMock,
  spawnManagedMock,
} from './mobile-preview-ios-test-helpers';
import {
  getIosActiveTouchSessionForTests,
} from './mobile-preview-ios-hid-input';
import { join } from 'node:path';

describe('mobile preview iOS touch input', () => {
  installIosPreviewTestHooks();

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
});
