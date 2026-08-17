import { access, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import { debug } from './mobile-preview-ios-shared-state';
import { join } from 'node:path';
import { runCommand } from './mobile-preview-process';
import { tmpdir } from 'node:os';

const KEYBOARD_LAYOUT_HELPER_SOURCE = 'mobile-preview-mac-keyboard-layout.m';
const KEYBOARD_LAYOUT_HELPER_BINARY = 'jean-claude-mac-keyboard-layout';
const KEYBOARD_LAYOUT_COMPILE_TIMEOUT_MS = 20_000;
const KEYBOARD_LAYOUT_RUN_TIMEOUT_MS = 5_000;
// The user can switch input source (⌃Space) at any time.
const KEYBOARD_LAYOUT_TTL_MS = 5_000;
// Upper bound on serving a keymap we can no longer refresh.
const KEYBOARD_LAYOUT_STALE_MS = 60_000;
const KEYBOARD_LAYOUT_BUILD_RETRY_MS = 60_000;
// 26 letters + 10 digits, before the synthetic whitespace entries.
const MINIMUM_KEYMAP_SIZE = 36;

/**
 * macOS virtual keycode -> USB HID usage id. This mapping is *physical* (which
 * key on the board), so it is layout independent — the layout only decides
 * which character each physical key produces, which the native helper reports.
 */
const VIRTUAL_KEYCODE_TO_HID_USAGE: Record<number, number> = {
  0: 4, // a
  1: 22, // s
  2: 7, // d
  3: 9, // f
  4: 11, // h
  5: 10, // g
  6: 29, // z
  7: 27, // x
  8: 6, // c
  9: 25, // v
  10: 100, // ISO key next to left shift
  11: 5, // b
  12: 20, // q
  13: 26, // w
  14: 8, // e
  15: 21, // r
  16: 28, // y
  17: 23, // t
  18: 30, // 1
  19: 31, // 2
  20: 32, // 3
  21: 33, // 4
  22: 35, // 6
  23: 34, // 5
  24: 46, // =
  25: 38, // 9
  26: 36, // 7
  27: 45, // -
  28: 37, // 8
  29: 39, // 0
  30: 48, // ]
  31: 18, // o
  32: 24, // u
  33: 47, // [
  34: 12, // i
  35: 19, // p
  36: 40, // return
  37: 15, // l
  38: 13, // j
  39: 52, // '
  40: 14, // k
  41: 51, // ;
  42: 49, // backslash
  43: 54, // ,
  44: 56, // /
  45: 17, // n
  46: 16, // m
  47: 55, // .
  48: 43, // tab
  49: 44, // space
  50: 53, // `
  51: 42, // delete
  53: 41, // escape
};

export type IosHidKeyStroke = { keycode: number; shift: boolean };
export type IosHidKeymap = ReadonlyMap<string, IosHidKeyStroke>;

type KeyboardLayoutDump = {
  inputSourceId?: unknown;
  keys?: Record<string, unknown>;
};

export function buildKeymapFromLayoutDump(dump: unknown): IosHidKeymap {
  const keys = (dump as KeyboardLayoutDump | null)?.keys;
  const keymap = new Map<string, IosHidKeyStroke>();

  for (const [char, value] of Object.entries(
    keys && typeof keys === 'object' ? keys : {},
  )) {
    if (char.length !== 1 || !Array.isArray(value)) continue;
    const [virtualKey, shift] = value;
    if (typeof virtualKey !== 'number' || typeof shift !== 'number') continue;
    const keycode = VIRTUAL_KEYCODE_TO_HID_USAGE[virtualKey];
    if (keycode === undefined) continue;
    keymap.set(char, { keycode, shift: shift === 1 });
  }

  // Whitespace is not reported by the helper (control characters are skipped).
  keymap.set(' ', { keycode: 44, shift: false });
  keymap.set('\n', { keycode: 40, shift: false });
  keymap.set('\r', { keycode: 40, shift: false });
  keymap.set('\t', { keycode: 43, shift: false });
  return keymap;
}

function getKeyboardLayoutHelperSourceCandidates(): string[] {
  const candidates = [
    process.env.JC_MOBILE_PREVIEW_KEYBOARD_LAYOUT_HELPER_SOURCE,
    join(process.cwd(), 'electron', 'native', KEYBOARD_LAYOUT_HELPER_SOURCE),
    join(__dirname, '..', 'native', KEYBOARD_LAYOUT_HELPER_SOURCE),
  ].filter((candidate): candidate is string => Boolean(candidate));

  if (process.resourcesPath) {
    candidates.push(
      join(process.resourcesPath, 'native', KEYBOARD_LAYOUT_HELPER_SOURCE),
    );
  }

  candidates.push(
    join(
      __dirname,
      '..',
      '..',
      'electron',
      'native',
      KEYBOARD_LAYOUT_HELPER_SOURCE,
    ),
    join(
      __dirname,
      '..',
      '..',
      '..',
      'electron',
      'native',
      KEYBOARD_LAYOUT_HELPER_SOURCE,
    ),
  );

  return candidates;
}

async function findKeyboardLayoutHelperSource(): Promise<string> {
  for (const candidate of getKeyboardLayoutHelperSourceCandidates()) {
    try {
      await access(candidate, fsConstants.R_OK);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }
  throw new Error('macOS keyboard layout helper source not found.');
}

let helperBinaryPromise: Promise<string> | null = null;
let helperBuildFailedAt: number | null = null;

async function buildKeyboardLayoutHelper(): Promise<string> {
  const sourcePath = await findKeyboardLayoutHelperSource();
  const source = await readFile(sourcePath);
  // Hash the source into the name so a shipped update never reuses a stale
  // binary, and so concurrent app instances agree on the same artifact.
  const sourceHash = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const outputDir = join(tmpdir(), 'jean-claude-mobile-preview');
  const outputPath = join(
    outputDir,
    `${KEYBOARD_LAYOUT_HELPER_BINARY}-${sourceHash}`,
  );
  // Owner-only: tmpdir() can fall back to a world-writable /tmp, where another
  // local user could otherwise plant a binary at a predictable path.
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  try {
    await access(outputPath, fsConstants.X_OK);
    return outputPath;
  } catch {
    // Not compiled yet.
  }

  // Compile to a per-process path and rename into place: clang writing directly
  // to outputPath would let another instance exec a truncated binary.
  const stagingPath = `${outputPath}.${process.pid}.tmp`;
  await runCommand(
    'xcrun',
    [
      'clang',
      '-fobjc-arc',
      '-framework',
      'Foundation',
      '-framework',
      'Carbon',
      sourcePath,
      '-o',
      stagingPath,
    ],
    { timeoutMs: KEYBOARD_LAYOUT_COMPILE_TIMEOUT_MS },
  );
  try {
    await rename(stagingPath, outputPath);
  } catch {
    await rm(stagingPath, { force: true });
    throw new Error('Failed to install macOS keyboard layout helper binary.');
  }
  debug('macOS keyboard layout helper compiled output=%s', outputPath);
  return outputPath;
}

function getKeyboardLayoutHelper(): Promise<string> {
  if (
    helperBuildFailedAt !== null &&
    Date.now() - helperBuildFailedAt < KEYBOARD_LAYOUT_BUILD_RETRY_MS
  ) {
    // Never re-run a 20s compile on every keystroke on machines without Xcode.
    throw new Error('macOS keyboard layout helper build recently failed.');
  }
  helperBinaryPromise ??= buildKeyboardLayoutHelper().catch((error) => {
    helperBinaryPromise = null;
    helperBuildFailedAt = Date.now();
    throw error;
  });
  return helperBinaryPromise;
}

let cachedKeymap: { keymap: IosHidKeymap; readAt: number } | null = null;

export function resetIosHidKeymapCacheForTests(): void {
  cachedKeymap = null;
  helperBinaryPromise = null;
  helperBuildFailedAt = null;
}

/**
 * Current host keyboard layout as a char -> HID keystroke map. Returns null when
 * the layout cannot be read (non-macOS, missing Xcode, ...) so callers can fall
 * back to the static tables.
 */
export async function getHostIosHidKeymap(): Promise<IosHidKeymap | null> {
  if (process.platform !== 'darwin') return null;
  if (cachedKeymap && Date.now() - cachedKeymap.readAt < KEYBOARD_LAYOUT_TTL_MS) {
    return cachedKeymap.keymap;
  }

  try {
    const binaryPath = await getKeyboardLayoutHelper();
    const { stdout } = await runCommand(binaryPath, [], {
      timeoutMs: KEYBOARD_LAYOUT_RUN_TIMEOUT_MS,
    });
    const dump: unknown = JSON.parse(stdout);
    const keymap = buildKeymapFromLayoutDump(dump);
    // A usable layout has the whole alphabet; anything less means a bad dump.
    if (keymap.size < MINIMUM_KEYMAP_SIZE) {
      throw new Error(`keyboard layout dump had only ${keymap.size} keys.`);
    }
    cachedKeymap = { keymap, readAt: Date.now() };
    return keymap;
  } catch (error) {
    debug(
      'macOS keyboard layout read failed, falling back to static tables: %s',
      error instanceof Error ? error.message : String(error),
    );
    // Keep the last good map rather than degrading mid-session, but do not
    // serve a layout we have been unable to confirm for a long time.
    if (
      cachedKeymap &&
      Date.now() - cachedKeymap.readAt < KEYBOARD_LAYOUT_STALE_MS
    ) {
      return cachedKeymap.keymap;
    }
    cachedKeymap = null;
    return null;
  }
}
