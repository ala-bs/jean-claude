import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  buildNativeLogCommand,
  createMobilePreviewNativeLogService,
} from './mobile-preview-native-log-service';

/**
 * Booted emulators are listed by AVD name on the device rail, so the incoming
 * deviceId is not an adb serial. Mirrors resolveAndroidAdbSerial's mapping.
 */
function createResolveAndroidAdb() {
  return vi.fn(async (deviceId: string) => ({
    command: '/sdk/platform-tools/adb',
    serial: deviceId === 'Pixel_7_API_34' ? 'emulator-5554' : deviceId,
  }));
}

function createAssertSimulatorOnlyIos(physicalDeviceIds: string[] = []) {
  return vi.fn(async ({ deviceId }: { deviceId: string }) => {
    if (physicalDeviceIds.includes(deviceId)) {
      throw new Error('Native logs is not supported on physical iOS devices.');
    }
  });
}

function createChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    child.emit('close', 0);
    return true;
  });
  return child;
}

describe('mobile preview native log service', () => {
  it('builds iOS log command for a simulator', async () => {
    await expect(
      buildNativeLogCommand({
        platform: 'ios',
        deviceId: 'device-1',
        resolveAndroidAdb: createResolveAndroidAdb(),
        assertSimulatorOnlyIos: createAssertSimulatorOnlyIos(),
      }),
    ).resolves.toEqual({
      command: 'xcrun',
      args: [
        'simctl',
        'spawn',
        'device-1',
        'log',
        'stream',
        '--style',
        'compact',
        '--level',
        'debug',
      ],
    });
  });

  it('rejects physical iOS devices instead of feeding simctl a CoreDevice id', async () => {
    const assertSimulatorOnlyIos = createAssertSimulatorOnlyIos([
      'D0C5D914-0000-0000-0000-000000000000',
    ]);

    await expect(
      buildNativeLogCommand({
        platform: 'ios',
        deviceId: 'D0C5D914-0000-0000-0000-000000000000',
        resolveAndroidAdb: createResolveAndroidAdb(),
        assertSimulatorOnlyIos,
      }),
    ).rejects.toThrow('not supported on physical iOS devices');
    expect(assertSimulatorOnlyIos).toHaveBeenCalledWith({
      deviceId: 'D0C5D914-0000-0000-0000-000000000000',
      capability: 'Native logs',
    });
  });

  it('builds Android log command with the adb serial for a physical device', async () => {
    await expect(
      buildNativeLogCommand({
        platform: 'android',
        deviceId: 'device-1',
        resolveAndroidAdb: createResolveAndroidAdb(),
        assertSimulatorOnlyIos: createAssertSimulatorOnlyIos(),
      }),
    ).resolves.toEqual({
      command: '/sdk/platform-tools/adb',
      args: ['-s', 'device-1', 'logcat', '-v', 'time'],
    });
  });

  it('resolves the adb serial for a booted emulator listed by AVD name', async () => {
    await expect(
      buildNativeLogCommand({
        platform: 'android',
        deviceId: 'Pixel_7_API_34',
        resolveAndroidAdb: createResolveAndroidAdb(),
        assertSimulatorOnlyIos: createAssertSimulatorOnlyIos(),
      }),
    ).resolves.toEqual({
      command: '/sdk/platform-tools/adb',
      args: ['-s', 'emulator-5554', 'logcat', '-v', 'time'],
    });
  });

  it('starts emulator logs against the resolved serial, not the AVD name', async () => {
    const child = createChild();
    const spawnProcess = vi.fn(() => ({ child, stop: vi.fn(async () => {}) }));
    const service = createMobilePreviewNativeLogService({
      spawnProcess,
      resolveAndroidAdb: createResolveAndroidAdb(),
      assertSimulatorOnlyIos: createAssertSimulatorOnlyIos(),
    });

    const session = await service.start({
      platform: 'android',
      deviceId: 'Pixel_7_API_34',
    });

    expect(session.status).toBe('running');
    expect(session.command).toBe(
      '/sdk/platform-tools/adb -s emulator-5554 logcat -v time',
    );
    expect(spawnProcess).toHaveBeenCalledWith(
      '/sdk/platform-tools/adb',
      ['-s', 'emulator-5554', 'logcat', '-v', 'time'],
      expect.objectContaining({ env: expect.any(Object) }),
    );
  });

  it('throws for physical iOS devices without spawning anything', async () => {
    const spawnProcess = vi.fn();
    const service = createMobilePreviewNativeLogService({
      spawnProcess,
      resolveAndroidAdb: createResolveAndroidAdb(),
      assertSimulatorOnlyIos: createAssertSimulatorOnlyIos(['iphone-1']),
    });

    await expect(
      service.start({ platform: 'ios', deviceId: 'iphone-1' }),
    ).rejects.toThrow('not supported on physical iOS devices');
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('starts logs and emits output', async () => {
    const child = createChild();
    const stop = vi.fn(async () => {
      child.kill('SIGTERM');
    });
    const service = createMobilePreviewNativeLogService({
      spawnProcess: (command, args) => {
        expect(command).toBe('/sdk/platform-tools/adb');
        expect(args).toEqual(['-s', 'device-1', 'logcat', '-v', 'time']);
        return { child, stop };
      },
      resolveAndroidAdb: createResolveAndroidAdb(),
      assertSimulatorOnlyIos: createAssertSimulatorOnlyIos(),
    });
    const sessions: string[] = [];
    const logs: string[] = [];
    service.onSession((event) => sessions.push(event.session.status));
    service.onLog((event) => logs.push(`${event.stream}:${event.text}`));

    const session = await service.start({
      platform: 'android',
      deviceId: 'device-1',
    });
    child.stdout.write('app log\n');
    child.stderr.write('log warn\n');

    expect(session.status).toBe('running');
    expect(sessions).toEqual(['running']);
    expect(logs).toEqual([
      'system:Started logs: /sdk/platform-tools/adb -s device-1 logcat -v time\n',
      'stdout:app log\n',
      'stderr:log warn\n',
    ]);

    await service.stop(session.id);
    expect(stop).toHaveBeenCalled();
    expect(sessions.at(-1)).toBe('stopped');
  });
});
