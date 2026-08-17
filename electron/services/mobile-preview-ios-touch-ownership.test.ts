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
  mockSimctlCommands,
  runCommandMock,
} from './mobile-preview-ios-test-helpers';
import { describe, expect, it, vi } from 'vitest';
import {
  getIosFallbackTouchSessionForTests,
} from './mobile-preview-ios-hid-input';
import { join } from 'node:path';

describe('mobile preview iOS touch ownership', () => {
  installIosPreviewTestHooks();

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
});
