vi.mock('./mobile-preview-process', () => ({
  runCommand: vi.fn(),
}));
vi.mock('../lib/debug', () => ({
  dbg: { mobilePreview: vi.fn() },
}));

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildKeymapFromLayoutDump,
  getHostIosHidKeymap,
  resetIosHidKeymapCacheForTests,
} from './mobile-preview-ios-keyboard-layout';
import { runCommand } from './mobile-preview-process';
import { vol } from 'memfs';

const runCommandMock = vi.mocked(runCommand);
const HELPER_SOURCE_PATH = '/native/mobile-preview-mac-keyboard-layout.m';

// macOS French: 'a' sits on virtual key 12 (US "q" position, HID usage 20).
// Virtual keys for a..z, captured from the real helper on a macOS French host.
const FRENCH_LETTER_VIRTUAL_KEYS = [
  12, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 41, 45, 31, 35, 0, 15, 1, 17, 32,
  9, 6, 7, 16, 13,
];
const FRENCH_DUMP = {
  inputSourceId: 'com.apple.keylayout.French',
  keys: {
    ...Object.fromEntries(
      FRENCH_LETTER_VIRTUAL_KEYS.flatMap((virtualKey, index) => [
        [String.fromCharCode(97 + index), [virtualKey, 0]],
        [String.fromCharCode(65 + index), [virtualKey, 1]],
      ]),
    ),
    // Digits need shift on AZERTY.
    ...Object.fromEntries(
      [18, 19, 20, 21, 23, 22, 26, 28, 25, 29].map((virtualKey, index) => [
        String(index + 1 === 10 ? 0 : index + 1),
        [virtualKey, 1],
      ]),
    ),
    '&': [18, 0],
    '@': [10, 0],
  },
};

const HELPER_BINARY_PATTERN = /jean-claude-mac-keyboard-layout-/;

function countRunCommandCalls(command: string | RegExp): number {
  return runCommandMock.mock.calls.filter(([called]) =>
    typeof command === 'string' ? called === command : command.test(called),
  ).length;
}

/** Fakes `xcrun clang` (writes the staged binary) and the helper run. */
function mockHelperToolchain(dump: unknown = FRENCH_DUMP): void {
  runCommandMock.mockImplementation((async (
    command: string,
    args: string[],
  ) => {
    if (command === 'xcrun') {
      vol.writeFileSync(args[args.indexOf('-o') + 1], 'binary', { mode: 0o755 });
      return { stdout: '', stderr: '' };
    }
    return { stdout: JSON.stringify(dump), stderr: '' };
  }) as never);
}

describe('macOS keyboard layout keymap', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    resetIosHidKeymapCacheForTests();
    vol.reset();
    vol.fromJSON({ [HELPER_SOURCE_PATH]: '// helper source' });
    vi.stubEnv(
      'JC_MOBILE_PREVIEW_KEYBOARD_LAYOUT_HELPER_SOURCE',
      HELPER_SOURCE_PATH,
    );
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  it('converts a layout dump into HID keystrokes', () => {
    const keymap = buildKeymapFromLayoutDump(FRENCH_DUMP);
    expect(keymap.get('a')).toEqual({ keycode: 20, shift: false });
    expect(keymap.get('A')).toEqual({ keycode: 20, shift: true });
    expect(keymap.get('q')).toEqual({ keycode: 4, shift: false });
    expect(keymap.get('1')).toEqual({ keycode: 30, shift: true });
    expect(keymap.get('&')).toEqual({ keycode: 30, shift: false });
    // ISO key next to left shift.
    expect(keymap.get('@')).toEqual({ keycode: 100, shift: false });
    // Whitespace is added even though the helper skips control characters.
    expect(keymap.get(' ')).toEqual({ keycode: 44, shift: false });
    expect(keymap.get('\n')).toEqual({ keycode: 40, shift: false });
  });

  it('ignores malformed entries and unknown virtual keycodes', () => {
    const keymap = buildKeymapFromLayoutDump({
      keys: { a: [12, 0], bad: [1, 0], b: 'nope', c: [999, 0] },
    });
    expect(keymap.get('a')).toEqual({ keycode: 20, shift: false });
    expect(keymap.has('bad')).toBe(false);
    expect(keymap.has('b')).toBe(false);
    expect(keymap.has('c')).toBe(false);
    expect(buildKeymapFromLayoutDump(null).size).toBe(4);
  });

  it('compiles once and caches the keymap between reads', async () => {
    mockHelperToolchain();

    expect((await getHostIosHidKeymap())?.get('a')).toEqual({
      keycode: 20,
      shift: false,
    });
    await getHostIosHidKeymap();

    expect(countRunCommandCalls('xcrun')).toBe(1);
    // Second read is served from the TTL cache: no compile, no helper run.
    expect(runCommandMock.mock.calls).toHaveLength(2);
  });

  it('compiles to a staging path and renames it into place', async () => {
    mockHelperToolchain();
    await getHostIosHidKeymap();

    const compileArgs = runCommandMock.mock.calls.find(
      ([command]) => command === 'xcrun',
    )?.[1] as string[];
    const outputPath = compileArgs[compileArgs.indexOf('-o') + 1];
    expect(outputPath.endsWith('.tmp')).toBe(true);
    // The staged binary is renamed to a source-hash-derived, stable name.
    const installedPath = runCommandMock.mock.calls.at(-1)?.[0] as string;
    expect(installedPath).toMatch(/jean-claude-mac-keyboard-layout-[0-9a-f]{16}$/);
    expect(vol.existsSync(installedPath)).toBe(true);
    expect(vol.existsSync(outputPath)).toBe(false);
  });

  it('re-reads the layout after the cache TTL expires', async () => {
    mockHelperToolchain();
    await getHostIosHidKeymap();
    vi.setSystemTime(Date.now() + 6_000);
    await getHostIosHidKeymap();

    expect(countRunCommandCalls('xcrun')).toBe(1);
    expect(countRunCommandCalls(HELPER_BINARY_PATTERN)).toBe(2);
  });

  it('serves the last good keymap when a refresh fails, then gives up', async () => {
    mockHelperToolchain();
    await getHostIosHidKeymap();

    runCommandMock.mockRejectedValue(new Error('helper crashed'));
    vi.setSystemTime(Date.now() + 6_000);
    expect((await getHostIosHidKeymap())?.get('a')).toEqual({
      keycode: 20,
      shift: false,
    });

    // Past the staleness bound the outdated layout is dropped entirely.
    vi.setSystemTime(Date.now() + 61_000);
    expect(await getHostIosHidKeymap()).toBeNull();
  });

  it('rejects a truncated layout dump', async () => {
    mockHelperToolchain({ keys: { a: [12, 0] } });
    expect(await getHostIosHidKeymap()).toBeNull();
  });

  it('returns null when the helper cannot be built or run', async () => {
    runCommandMock.mockRejectedValue(new Error('xcrun missing'));
    expect(await getHostIosHidKeymap()).toBeNull();
  });

  it('does not retry a failed build on every read', async () => {
    runCommandMock.mockRejectedValue(new Error('xcrun missing'));
    await getHostIosHidKeymap();
    await getHostIosHidKeymap();
    await getHostIosHidKeymap();
    expect(countRunCommandCalls('xcrun')).toBe(1);
  });

  it('is skipped off macOS', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });
    mockHelperToolchain();
    expect(await getHostIosHidKeymap()).toBeNull();
    expect(runCommandMock).not.toHaveBeenCalled();
  });
});
