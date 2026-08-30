import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { createMobilePreviewPacketCaptureService } from './mobile-preview-packet-capture-service';

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

describe('mobile preview packet capture service', () => {
  it('starts packet capture with the chosen command', async () => {
    const child = createChild();
    const spawnProcess = vi.fn(() => ({
      child,
      stop: vi.fn(async () => {
        child.kill('SIGTERM');
      }),
    }));
    const runCommandImpl = vi.fn();
    const service = createMobilePreviewPacketCaptureService({
      spawnProcess,
      runCommandImpl,
    });
    const sessions: string[] = [];
    service.onSession((event) => sessions.push(event.session.status));

    const session = await service.start({
      platform: 'android',
      deviceId: 'device-1',
      command: 'tcpdump',
      args: ['-l', '-n', 'port', '443'],
    });

    expect(session.status).toBe('running');
    expect(session.command).toBe('tcpdump -l -n port 443');
    expect(spawnProcess).toHaveBeenCalledWith('tcpdump', [
      '-l',
      '-n',
      'port',
      '443',
    ], expect.objectContaining({ env: expect.any(Object) }));
    expect(runCommandImpl).not.toHaveBeenCalled();
    expect(sessions).toEqual(['running']);
  });

  it('starts Android capture through adb when tcpdump is available', async () => {
    const child = createChild();
    const spawnProcess = vi.fn(() => ({
      child,
      stop: vi.fn(async () => {
        child.kill('SIGTERM');
      }),
    }));
    const runCommandImpl = vi.fn(async () => ({
      stdout: '/system/bin/tcpdump\n',
      stderr: '',
    }));
    const service = createMobilePreviewPacketCaptureService({
      spawnProcess,
      runCommandImpl,
      resolveAndroidAdb: createResolveAndroidAdb(),
    });

    const session = await service.start({
      platform: 'android',
      deviceId: 'device-1',
    });

    expect(session.status).toBe('running');
    expect(session.command).toBe(
      '/sdk/platform-tools/adb -s device-1 shell tcpdump -l -n',
    );
    expect(runCommandImpl).toHaveBeenCalledWith('/sdk/platform-tools/adb', [
      '-s',
      'device-1',
      'shell',
      'which',
      'tcpdump',
    ]);
    expect(spawnProcess).toHaveBeenCalledWith('/sdk/platform-tools/adb', [
      '-s',
      'device-1',
      'shell',
      'tcpdump',
      '-l',
      '-n',
    ], expect.objectContaining({ env: expect.any(Object) }));
  });

  it('resolves the adb serial for a booted emulator listed by AVD name', async () => {
    const child = createChild();
    const spawnProcess = vi.fn(() => ({
      child,
      stop: vi.fn(async () => {
        child.kill('SIGTERM');
      }),
    }));
    const runCommandImpl = vi.fn(async () => ({
      stdout: '/system/bin/tcpdump\n',
      stderr: '',
    }));
    const resolveAndroidAdb = createResolveAndroidAdb();
    const service = createMobilePreviewPacketCaptureService({
      spawnProcess,
      runCommandImpl,
      resolveAndroidAdb,
    });

    const session = await service.start({
      platform: 'android',
      deviceId: 'Pixel_7_API_34',
    });

    expect(resolveAndroidAdb).toHaveBeenCalledWith('Pixel_7_API_34');
    expect(session.command).toBe(
      '/sdk/platform-tools/adb -s emulator-5554 shell tcpdump -l -n',
    );
    expect(runCommandImpl).toHaveBeenCalledWith('/sdk/platform-tools/adb', [
      '-s',
      'emulator-5554',
      'shell',
      'which',
      'tcpdump',
    ]);
    expect(spawnProcess).toHaveBeenCalledWith('/sdk/platform-tools/adb', [
      '-s',
      'emulator-5554',
      'shell',
      'tcpdump',
      '-l',
      '-n',
    ], expect.objectContaining({ env: expect.any(Object) }));
  });

  it('returns setup-needed and does not spawn when Android tcpdump is missing', async () => {
    const spawnProcess = vi.fn();
    const runCommandImpl = vi.fn(async () => {
      throw new Error('missing');
    });
    const service = createMobilePreviewPacketCaptureService({
      spawnProcess,
      runCommandImpl,
      resolveAndroidAdb: createResolveAndroidAdb(),
    });
    const sessions: string[] = [];
    service.onSession((event) => {
      sessions.push(`${event.session.status}:${event.session.error}`);
    });

    const session = await service.start({
      platform: 'android',
      deviceId: 'device-1',
    });

    expect(session.status).toBe('setup-needed');
    expect(session.command).toBe(
      '/sdk/platform-tools/adb -s device-1 shell tcpdump -l -n',
    );
    expect(session.error).toContain('requires tcpdump');
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(sessions).toEqual([
      expect.stringContaining('setup-needed:Android packet capture requires tcpdump'),
    ]);
  });

  it('returns setup-needed for iOS instead of starting sudo tcpdump', async () => {
    const spawnProcess = vi.fn();
    const runCommandImpl = vi.fn();
    const service = createMobilePreviewPacketCaptureService({
      spawnProcess,
      runCommandImpl,
    });

    const session = await service.start({
      platform: 'ios',
      deviceId: 'sim-1',
    });

    expect(session.status).toBe('setup-needed');
    expect(session.command).toBe('sudo tcpdump -l -n -i any');
    expect(session.error).toContain('sudo tcpdump -l -n -i any');
    expect(runCommandImpl).not.toHaveBeenCalled();
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('emits packet-only request metadata from tcpdump-like stdout', async () => {
    const child = createChild();
    const service = createMobilePreviewPacketCaptureService({
      spawnProcess: () => ({
        child,
        stop: vi.fn(async () => {
          child.kill('SIGTERM');
        }),
      }),
    });
    const requests: string[] = [];
    service.onRequest((event) => {
      requests.push(
        [
          event.request.captureSource,
          event.request.method,
          event.request.url,
          event.request.status,
          event.request.decrypted,
        ].join(':'),
      );
    });

    const session = await service.start({
      platform: 'android',
      deviceId: 'device-1',
      command: 'tcpdump',
      args: ['-l', '-n'],
    });
    child.stdout.write(
      '12:34:56.789 IP 10.0.2.15.49321 > 93.184.216.34',
    );
    child.stdout.write(
      '.443: Flags [S], length 0\nignored line without endpoint\n',
    );

    expect(requests).toEqual([
      'packet-only:TCP:tcp://93.184.216.34:443::false',
    ]);
    expect(session.status).toBe('running');
  });

  it('stops capture and marks the session stopped', async () => {
    const child = createChild();
    const stop = vi.fn(async () => {
      child.kill('SIGTERM');
    });
    const service = createMobilePreviewPacketCaptureService({
      spawnProcess: () => ({ child, stop }),
    });
    const sessions: string[] = [];
    service.onSession((event) => sessions.push(event.session.status));
    const session = await service.start({
      platform: 'ios',
      deviceId: 'sim-1',
      command: 'tcpdump',
      args: ['-l', '-n'],
    });

    await service.stop(session.id);

    expect(stop).toHaveBeenCalled();
    expect(child.killed).toBe(true);
    expect(sessions).toEqual(['running', 'stopped']);
  });
});
