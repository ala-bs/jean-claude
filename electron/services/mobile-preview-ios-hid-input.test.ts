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
vi.mock('./mobile-preview-ios-keyboard-layout', () => ({
  getHostIosHidKeymap: vi.fn().mockResolvedValue(null),
  resetIosHidKeymapCacheForTests: vi.fn(),
}));

import {
  commandExistsMock,
  installIosPreviewTestHooks,
  iosIdbAdapter,
  mockReadyHidHelper,
  runCommandMock,
  spawnManagedMock,
} from './mobile-preview-ios-test-helpers';
import { describe, expect, it, vi } from 'vitest';
import {
  buildIdbInputArgs,
  getHostKeyboardLayout,
  mapCharToIosHidKeyStroke,
  resetIosHidLayoutCacheForTests,
  resolveIosHidLayoutFromInputSourceId,
  resolveIosHidLayoutSource,
  splitTextForIosInput,
} from './mobile-preview-ios-hid-input';
import {
  getHostIosHidKeymap,
  resetIosHidKeymapCacheForTests,
} from './mobile-preview-ios-keyboard-layout';
import { beforeEach } from 'vitest';

const getHostIosHidKeymapMock = vi.mocked(getHostIosHidKeymap);
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

describe('mobile preview iOS HID input', () => {
  installIosPreviewTestHooks();

  beforeEach(() => {
    vi.stubEnv('JC_MOBILE_PREVIEW_IOS_KEYBOARD_LAYOUT', 'us');
    resetIosHidLayoutCacheForTests();
    resetIosHidKeymapCacheForTests();
  });

  it('prefers a live host keymap over the static tables', async () => {
    vi.stubEnv('JC_MOBILE_PREVIEW_IOS_KEYBOARD_LAYOUT', '');
    const keymap = new Map([['a', { keycode: 20, shift: false }]]);
    getHostIosHidKeymapMock.mockResolvedValue(keymap);
    expect(await resolveIosHidLayoutSource()).toBe(keymap);

    // Chars absent from the live keymap still go through Simulator paste.
    expect(splitTextForIosInput('a€', keymap)).toEqual([
      { kind: 'hid', strokes: [{ keycode: 20, shift: false }] },
      { kind: 'paste', text: '€' },
    ]);

    // Static tables are the fallback when the helper is unavailable.
    getHostIosHidKeymapMock.mockResolvedValue(null);
    expect(await resolveIosHidLayoutSource()).toBe('us');
  });

  it('lets the env override win over the live keymap', async () => {
    getHostIosHidKeymapMock.mockResolvedValue(
      new Map([['a', { keycode: 20, shift: false }]]),
    );
    vi.stubEnv('JC_MOBILE_PREVIEW_IOS_KEYBOARD_LAYOUT', 'french');
    expect(await resolveIosHidLayoutSource()).toBe('french');
  });

  it('detects AZERTY input sources only for real AZERTY layouts', () => {
    expect(
      resolveIosHidLayoutFromInputSourceId('com.apple.keylayout.French'),
    ).toBe('french');
    expect(
      resolveIosHidLayoutFromInputSourceId('com.apple.keylayout.Belgian'),
    ).toBe('french');
    // QWERTY / QWERTZ layouts that merely contain "French".
    expect(
      resolveIosHidLayoutFromInputSourceId('com.apple.keylayout.CanadianFrench'),
    ).toBe('us');
    expect(
      resolveIosHidLayoutFromInputSourceId('com.apple.keylayout.SwissFrench'),
    ).toBe('us');
    expect(resolveIosHidLayoutFromInputSourceId(undefined)).toBe('us');
  });

  it('maps chars per host keyboard layout', () => {
    expect(mapCharToIosHidKeyStroke('a', 'us')).toEqual({
      keycode: 4,
      shift: false,
    });
    // On AZERTY hosts 'a' lives on the US 'q' key (usage 20).
    expect(mapCharToIosHidKeyStroke('a', 'french')).toEqual({
      keycode: 20,
      shift: false,
    });
    expect(mapCharToIosHidKeyStroke('1', 'french')).toEqual({
      keycode: 30,
      shift: true,
    });
    expect(mapCharToIosHidKeyStroke('-', 'french')).toEqual({
      keycode: 46,
      shift: false,
    });
  });

  it('splits unmapped AZERTY chars into paste chunks', () => {
    expect(splitTextForIosInput('az{b', 'french')).toEqual([
      {
        kind: 'hid',
        strokes: [
          { keycode: 20, shift: false },
          { keycode: 26, shift: false },
        ],
      },
      { kind: 'paste', text: '{' },
      { kind: 'hid', strokes: [{ keycode: 5, shift: false }] },
    ]);
  });

  it('reads and caches the host keyboard layout, ignoring bad overrides', async () => {
    vi.stubEnv('JC_MOBILE_PREVIEW_IOS_KEYBOARD_LAYOUT', 'fr');
    runCommandMock.mockResolvedValue({
      stdout: 'com.apple.keylayout.French\n',
      stderr: '',
    });

    expect(await getHostKeyboardLayout()).toBe('french');
    expect(await getHostKeyboardLayout()).toBe('french');
    expect(
      runCommandMock.mock.calls.filter(([command]) => command === 'defaults'),
    ).toHaveLength(1);

    // A failed read keeps the last known layout instead of latching to US.
    resetIosHidLayoutCacheForTests();
    runCommandMock.mockRejectedValue(new Error('boom'));
    expect(await getHostKeyboardLayout()).toBe('us');
  });

  it('builds tap args', () => {
    expect(
      buildIdbInputArgs('device-1', { type: 'tap', x: 12, y: 34 }),
    ).toEqual(['ui', 'tap', '12', '34', '--udid', 'device-1']);
  });

  it('builds supported input args and rejects iOS back', () => {
    expect(
      buildIdbInputArgs('device-1', {
        type: 'swipe',
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        durationMs: 250,
      }),
    ).toEqual([
      'ui',
      'swipe',
      '1',
      '2',
      '3',
      '4',
      '--duration',
      '0.25',
      '--udid',
      'device-1',
    ]);
    expect(
      buildIdbInputArgs('device-1', {
        type: 'longPress',
        x: 12,
        y: 34,
        durationMs: 650,
      }),
    ).toEqual([
      'ui',
      'swipe',
      '12',
      '34',
      '12',
      '34',
      '--duration',
      '0.65',
      '--udid',
      'device-1',
    ]);
    expect(() =>
      buildIdbInputArgs('device-1', { type: 'text', text: 'hi' }),
    ).toThrow(/HID keystrokes/);
    expect(buildIdbInputArgs('device-1', { type: 'key', key: 'home' })).toEqual(
      ['ui', 'button', 'HOME', '--udid', 'device-1'],
    );
    expect(
      buildIdbInputArgs('device-1', { type: 'key', key: 'enter' }),
    ).toEqual(['ui', 'key', '36', '--udid', 'device-1']);
    expect(() =>
      buildIdbInputArgs('device-1', { type: 'key', key: 'backspace' }),
    ).toThrow(/HID key events/);
    expect(() =>
      buildIdbInputArgs('device-1', { type: 'showKeyboard' }),
    ).toThrow(/Simulator keyboard shortcuts/);
    expect(() =>
      buildIdbInputArgs('device-1', { type: 'key', key: 'back' }),
    ).toThrow(/does not support back/i);
  });

  it('shows iOS software keyboard through Simulator shortcut', async () => {
    runCommandMock.mockResolvedValue({ stdout: '', stderr: '' });

    await iosIdbAdapter.sendInput('device-1', { type: 'showKeyboard' });

    expect(commandExistsMock).not.toHaveBeenCalledWith('idb');
    expect(runCommandMock).toHaveBeenCalledWith(
      'osascript',
      ['-e', expect.stringContaining('keystroke "k" using command down')],
      { signal: expect.any(AbortSignal), timeoutMs: 3000 },
    );
    expect(runCommandMock).not.toHaveBeenCalledWith('idb', expect.any(Array));
  });

  it('sends iOS text through HID keystrokes without activating Simulator', async () => {
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    const { writes } = mockReadyHidHelper();
    runCommandMock.mockResolvedValue({ stdout: '', stderr: '' });

    await iosIdbAdapter.sendInput('device-1', { type: 'text', text: 'aB' });

    expect(runCommandMock).not.toHaveBeenCalledWith(
      'osascript',
      expect.any(Array),
      expect.anything(),
    );
    expect(writes.join('')).toBe(
      [
        '{"type":"keyDown","keycode":4}',
        '{"type":"keyUp","keycode":4}',
        '{"type":"keyDown","keycode":225}',
        '{"type":"keyDown","keycode":5}',
        '{"type":"keyUp","keycode":5}',
        '{"type":"keyUp","keycode":225}',
      ].join('\n') + '\n',
    );
  });

  it('preserves order across concurrent HID text input', async () => {
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    const { writes } = mockReadyHidHelper();
    runCommandMock.mockResolvedValue({ stdout: '', stderr: '' });

    await Promise.all([
      iosIdbAdapter.sendInput('device-1', { type: 'text', text: 'a' }),
      iosIdbAdapter.sendInput('device-1', { type: 'text', text: 'b' }),
    ]);

    expect(
      writes
        .join('')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).keycode),
    ).toEqual([4, 4, 5, 5]);
  });

  it('pastes only the unmappable run of mixed text', async () => {
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    const { writes } = mockReadyHidHelper();
    runCommandMock.mockResolvedValue({ stdout: '', stderr: '' });

    await iosIdbAdapter.sendInput('device-1', { type: 'text', text: 'aéb' });

    expect(runCommandMock).toHaveBeenCalledWith(
      'osascript',
      ['-e', expect.any(String), 'é'],
      expect.anything(),
    );
    expect(
      writes
        .join('')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).keycode),
    ).toEqual([4, 4, 5, 5]);
  });

  it('types newline and tab through HID instead of pasting', async () => {
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    const { writes } = mockReadyHidHelper();
    runCommandMock.mockResolvedValue({ stdout: '', stderr: '' });

    await iosIdbAdapter.sendInput('device-1', { type: 'text', text: '\n\t' });

    expect(runCommandMock).not.toHaveBeenCalledWith(
      'osascript',
      expect.any(Array),
      expect.anything(),
    );
    expect(
      writes
        .join('')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).keycode),
    ).toEqual([40, 40, 43, 43]);
  });

  it('releases a latched shift modifier when the HID helper is torn down', async () => {
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    const { writes } = mockReadyHidHelper();
    runCommandMock.mockResolvedValue({ stdout: '', stderr: '' });

    await iosIdbAdapter.sendInput('device-1', { type: 'text', text: 'A' });
    await iosIdbAdapter.dispose();

    expect(writes.join('').trim().split('\n').at(-1)).toBe(
      '{"type":"keyUp","keycode":225}',
    );
  });

  it('pastes text when the idb CLI is unavailable', async () => {
    commandExistsMock.mockResolvedValue(false);
    runCommandMock.mockResolvedValue({ stdout: '', stderr: '' });

    await iosIdbAdapter.sendInput('device-1', { type: 'text', text: 'a' });

    expect(runCommandMock).toHaveBeenCalledWith(
      'osascript',
      ['-e', expect.stringContaining('keystroke "v" using command down'), 'a'],
      { signal: expect.any(AbortSignal), timeoutMs: 3000 },
    );
  });

  it('falls back to Simulator paste for text without a US keycode', async () => {
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    mockReadyHidHelper();
    runCommandMock.mockResolvedValue({ stdout: '', stderr: '' });

    await iosIdbAdapter.sendInput('device-1', { type: 'text', text: 'é' });

    expect(runCommandMock).toHaveBeenCalledWith(
      'osascript',
      ['-e', expect.stringContaining('keystroke "v" using command down'), 'é'],
      { signal: expect.any(AbortSignal), timeoutMs: 3000 },
    );
  });

  it('serializes iOS text input to preserve character order and clipboard state', async () => {
    let finishFirstPaste: (() => void) | undefined;
    runCommandMock.mockImplementation(
      (_command, args) =>
        new Promise((resolve) => {
          if (args.at(-1) === 'é') {
            finishFirstPaste = () => resolve({ stdout: '', stderr: '' });
            return;
          }
          resolve({ stdout: '', stderr: '' });
        }),
    );

    const first = iosIdbAdapter.sendInput('device-1', { type: 'text', text: 'é' });
    const second = iosIdbAdapter.sendInput('device-1', { type: 'text', text: 'ü' });
    await vi.waitFor(() => expect(finishFirstPaste).toBeTypeOf('function'));

    expect(runCommandMock).toHaveBeenCalledTimes(1);
    finishFirstPaste?.();
    await Promise.all([first, second]);
    expect(runCommandMock.mock.calls.map(([, args]) => args.at(-1))).toEqual([
      'é',
      'ü',
    ]);
  });

  it('cancels queued keyboard input and drains active input during disposal', async () => {
    let releaseFirst: (() => void) | undefined;
    runCommandMock.mockImplementation(
      (_command, args) =>
        new Promise((resolve) => {
          if (args.at(-1) === 'é') {
            releaseFirst = () => resolve({ stdout: '', stderr: '' });
            return;
          }
          resolve({ stdout: '', stderr: '' });
        }),
    );

    const first = iosIdbAdapter.sendInput('device-1', { type: 'text', text: 'é' });
    const second = iosIdbAdapter.sendInput('device-1', { type: 'text', text: 'ü' });
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
    let disposed = false;
    const dispose = iosIdbAdapter.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    releaseFirst?.();
    await Promise.all([first, second, dispose]);

    expect(runCommandMock).toHaveBeenCalledTimes(1);
  });

  it('registers accepted iOS keyboard input before same-tick disposal', async () => {
    const input = iosIdbAdapter
      .sendInput('device-race', { type: 'showKeyboard' })
      .catch((error: unknown) => error);

    await iosIdbAdapter.dispose();

    await expect(input).resolves.toMatchObject({ name: 'AbortError' });
    expect(commandExistsMock).not.toHaveBeenCalled();
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('rejects iOS input immediately after disposal without launching work', async () => {
    await iosIdbAdapter.dispose();
    commandExistsMock.mockClear();
    runCommandMock.mockClear();

    await expect(
      iosIdbAdapter.sendInput('device-disposed', { type: 'tap', x: 1, y: 2 }),
    ).rejects.toThrow('iOS preview is shutting down');
    expect(commandExistsMock).not.toHaveBeenCalled();
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('reports iOS cleanup stop failures after attempting every helper stop', async () => {
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    const helpers = ['device-cleanup-a', 'device-cleanup-b'].map((deviceId, index) => {
      const stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        kill: vi.fn(),
        pid: 700 + index,
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        stdout,
      });
      child.stdin.write = vi.fn(
        (_chunk, callback?: (error?: Error | null) => void) => {
          callback?.();
          return true;
        },
      ) as never;
      const stop =
        index === 0
          ? vi.fn().mockRejectedValue(new Error('first helper stop failed'))
          : vi.fn().mockResolvedValue(undefined);
      return { child, deviceId, stdout, stop };
    });
    spawnManagedMock
      .mockReturnValueOnce({ child: helpers[0].child as never, stop: helpers[0].stop })
      .mockReturnValueOnce({ child: helpers[1].child as never, stop: helpers[1].stop });

    const inputs = helpers.map((helper) =>
      iosIdbAdapter.sendInput(helper.deviceId, { type: 'key', key: 'backspace' }),
    );
    await vi.waitFor(() => expect(spawnManagedMock).toHaveBeenCalledTimes(1));
    helpers[0].stdout.write('READY\n');
    await vi.waitFor(() => expect(spawnManagedMock).toHaveBeenCalledTimes(2));
    helpers[1].stdout.write('READY\n');
    await Promise.all(inputs);

    await expect(iosIdbAdapter.dispose()).rejects.toThrow('first helper stop failed');
    expect(helpers[0].stop).toHaveBeenCalled();
    expect(helpers[1].stop).toHaveBeenCalled();
  });

  it('ignores empty iOS text input without requiring idb', async () => {
    await iosIdbAdapter.sendInput('device-1', { type: 'text', text: '' });

    expect(commandExistsMock).not.toHaveBeenCalledWith('idb');
    expect(runCommandMock).not.toHaveBeenCalled();
  });

  it('sends iOS backspace through HID helper', async () => {
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
    const stop = vi.fn(async () => {
      child.emit('close', 0, null);
    });
    const writes: string[] = [];
    stdin.write = vi.fn((chunk, callback?: (error?: Error | null) => void) => {
      writes.push(String(chunk));
      callback?.();
      return true;
    }) as never;
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    spawnManagedMock.mockReturnValue({
      child: child as never,
      stop,
    });
    runCommandMock.mockResolvedValue({ stdout: '', stderr: '' });

    const result = iosIdbAdapter.sendInput('device-1', {
      type: 'key',
      key: 'backspace',
    });
    stdout.write('READY\n');
    await result;

    expect(runCommandMock).not.toHaveBeenCalledWith('idb', expect.any(Array));
    expect(spawnManagedMock).toHaveBeenCalledWith('python3', [
      expect.stringContaining('mobile-preview-ios-hid-helper.py'),
      'device-1',
    ]);
    expect(writes.join('')).toBe(
      '{"type":"keyDown","keycode":42}\n{"type":"keyUp","keycode":42}\n',
    );
  });

  it('retries HID helper startup after readiness failure', async () => {
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    const helpers = Array.from({ length: 2 }, (_, index) => {
      const stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        kill: vi.fn(),
        pid: 123 + index,
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        stdout,
      });
      child.stdin.write = vi.fn(
        (_chunk, callback?: (error?: Error | null) => void) => {
          callback?.();
          return true;
        },
      ) as never;
      return {
        child,
        stop: vi.fn().mockResolvedValue(undefined),
        stdout,
      };
    });
    spawnManagedMock
      .mockReturnValueOnce({ child: helpers[0].child as never, stop: helpers[0].stop })
      .mockReturnValueOnce({ child: helpers[1].child as never, stop: helpers[1].stop });

    const first = iosIdbAdapter.sendInput('device-hid-retry', {
      type: 'key',
      key: 'backspace',
    });
    await vi.waitFor(() => expect(spawnManagedMock).toHaveBeenCalledTimes(1));
    helpers[0].child.emit('error', new Error('startup failed'));
    await expect(first).rejects.toThrow('startup failed');
    expect(helpers[0].stop).toHaveBeenCalledTimes(1);

    const second = iosIdbAdapter.sendInput('device-hid-retry', {
      type: 'key',
      key: 'backspace',
    });
    await vi.waitFor(() => expect(spawnManagedMock).toHaveBeenCalledTimes(2));
    helpers[1].stdout.write('READY\n');
    await expect(second).resolves.toBeUndefined();
  });

  it('throws actionable missing idb error when sending input', async () => {
    commandExistsMock.mockImplementation(async (command) => command !== 'idb');

    await expect(
      iosIdbAdapter.sendInput('device-1', { type: 'tap', x: 12, y: 34 }),
    ).rejects.toThrow(
      /Missing required iOS preview tool: idb.*brew tap facebook\/fb.*fb-idb/i,
    );
    expect(runCommandMock).not.toHaveBeenCalledWith('idb', expect.any(Array));
  });

  it('scales tap coordinates from preview pixels to iOS points', async () => {
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
  });

  it('scales swipe coordinates from preview pixels to iOS points', async () => {
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

      return { stdout: '', stderr: '' };
    });

    await iosIdbAdapter.sendInput('device-2', {
      type: 'swipe',
      x1: 600,
      y1: 900,
      x2: 900,
      y2: 1200,
      durationMs: 250,
    });

    expect(runCommandMock).toHaveBeenCalledWith('idb', [
      'ui',
      'swipe',
      '200',
      '300',
      '300',
      '400',
      '--duration',
      '0.25',
      '--udid',
      'device-2',
    ], { signal: expect.any(AbortSignal) });
  });

  it('scales HID touch lifecycle coordinates from pixels to points', async () => {
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

      return { stdout: '', stderr: '' };
    });
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE = join(
      __dirname,
      '../native/mobile-preview-ios-hid-helper.py',
    );
    const { writes } = mockReadyHidHelper();

    await iosIdbAdapter.sendInput('device-hid-scale', {
      type: 'touchDown',
      x: 600,
      y: 900,
    });

    expect(writes).toEqual([
      `${JSON.stringify({ type: 'touchDown', x: 200, y: 300 })}\n`,
    ]);
  });

  it('validates device IDs and finite input values', () => {
    expect(() => buildIdbInputArgs('', { type: 'tap', x: 12, y: 34 })).toThrow(
      /deviceId is required/,
    );
    expect(() =>
      buildIdbInputArgs('device-1', { type: 'tap', x: Number.NaN, y: 34 }),
    ).toThrow(/finite number/);
  });

  it('rejects invalid IPC input event payloads', () => {
    expect(() => buildIdbInputArgs('device-1', { type: 'drag' })).toThrow(
      /Unsupported iOS input event type: drag/,
    );
    expect(() =>
      buildIdbInputArgs('device-1', { type: 'text', text: 123 }),
    ).toThrow(/expected text string/);
    expect(() =>
      buildIdbInputArgs('device-1', { type: 'key', key: 'escape' }),
    ).toThrow(/Unsupported iOS key input: escape/);
  });
});
