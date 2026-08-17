import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  buildNativeLogCommand,
  createMobilePreviewNativeLogService,
} from './mobile-preview-native-log-service';

describe('mobile preview native log service', () => {
  it('builds iOS log command', () => {
    expect(buildNativeLogCommand('ios', 'device-1')).toEqual({
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

  it('builds Android log command', () => {
    expect(buildNativeLogCommand('android', 'device-1')).toEqual({
      command: 'adb',
      args: ['-s', 'device-1', 'logcat', '-v', 'time'],
    });
  });

  it('starts logs and emits output', async () => {
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
    const stop = vi.fn(async () => {
      child.kill('SIGTERM');
    });
    const service = createMobilePreviewNativeLogService({
      spawnProcess: (command, args) => {
        expect(command).toBe('adb');
        expect(args).toEqual(['-s', 'device-1', 'logcat', '-v', 'time']);
        return { child, stop };
      },
    });
    const sessions: string[] = [];
    const logs: string[] = [];
    service.onSession((event) => sessions.push(event.session.status));
    service.onLog((event) => logs.push(`${event.stream}:${event.text}`));

    const session = service.start({
      platform: 'android',
      deviceId: 'device-1',
    });
    child.stdout.write('app log\n');
    child.stderr.write('log warn\n');

    expect(session.status).toBe('running');
    expect(sessions).toEqual(['running']);
    expect(logs).toEqual([
      'system:Started logs: adb -s device-1 logcat -v time\n',
      'stdout:app log\n',
      'stderr:log warn\n',
    ]);

    await service.stop(session.id);
    expect(stop).toHaveBeenCalled();
    expect(sessions.at(-1)).toBe('stopped');
  });
});
