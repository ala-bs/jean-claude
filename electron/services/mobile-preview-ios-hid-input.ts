import type {
  MobilePreviewInputEvent,
  MobilePreviewSession,
} from '../../shared/mobile-simulator-types';

import type { RawStreamSize } from './mobile-preview-ios-shared-state';

import {
  activeHidHelpersByDeviceId,
  activeIosNonTouchInputs,
  activeIosSessionIds,
  activeIosTouchesByDeviceId,
  appendBoundedText,
  debug,
  elapsedMs,
  fallbackTouchesByDeviceId,
  getIosInputGeneration,
  getIosKeyboardInputQueue,
  hidHelperReferenceCountsByDeviceId,
  inputScreenDimensionsByDeviceId,
  iosInputErrorByDeviceId,
  iosTouchInputQueues,
  isIosPreviewDisposed,
  pendingHidHelpersByDeviceId,
  setIosKeyboardInputQueue,
} from './mobile-preview-ios-shared-state';
import {
  getHostIosHidKeymap,
  type IosHidKeymap,
  type IosHidKeyStroke,
} from './mobile-preview-ios-keyboard-layout';
import { runCommand, spawnManaged } from './mobile-preview-process';
import { access } from 'node:fs/promises';
import { assertDeviceId } from './mobile-preview-ios-simctl';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';

const IOS_HID_HELPER_SOURCE = 'mobile-preview-ios-hid-helper.py';
const IOS_HID_HELPER_READY_TIMEOUT_MS = 2_000;
const SHOW_IOS_KEYBOARD_TIMEOUT_MS = 3_000;
const PASTE_IOS_TEXT_TIMEOUT_MS = 3_000;
export const IOS_HID_BACKSPACE_KEYCODE = 42;
export const IOS_HID_SHIFT_KEYCODE = 225;

// USB HID usage codes for keys reachable from a US keyboard layout.
const IOS_HID_UNSHIFTED_KEYCODES: Record<string, number> = {
  ...Object.fromEntries(
    Array.from({ length: 26 }, (_, index) => [
      String.fromCharCode(97 + index),
      4 + index,
    ]),
  ),
  '1': 30,
  '2': 31,
  '3': 32,
  '4': 33,
  '5': 34,
  '6': 35,
  '7': 36,
  '8': 37,
  '9': 38,
  '0': 39,
  ' ': 44,
  '\n': 40,
  '\r': 40,
  '\t': 43,
  '-': 45,
  '=': 46,
  '[': 47,
  ']': 48,
  '\\': 49,
  ';': 51,
  "'": 52,
  '`': 53,
  ',': 54,
  '.': 55,
  '/': 56,
};

const IOS_HID_SHIFTED_KEYCODES: Record<string, number> = {
  ...Object.fromEntries(
    Array.from({ length: 26 }, (_, index) => [
      String.fromCharCode(65 + index),
      4 + index,
    ]),
  ),
  '!': 30,
  '@': 31,
  '#': 32,
  $: 33,
  '%': 34,
  '^': 35,
  '&': 36,
  '*': 37,
  '(': 38,
  ')': 39,
  _: 45,
  '+': 46,
  '{': 47,
  '}': 48,
  '|': 49,
  ':': 51,
  '"': 52,
  '~': 53,
  '<': 54,
  '>': 55,
  '?': 56,
};

// The simulator interprets HID usage codes with the *host* keyboard layout
// (Simulator mirrors the Mac's current input source). Sending US-position codes
// while the Mac is on AZERTY types the wrong characters, so we need a per-layout
// char -> physical-key table. Characters missing here fall back to paste.
const FRENCH_LETTER_KEYCODES: Record<string, number> = {
  a: 20,
  z: 26,
  e: 8,
  r: 21,
  t: 23,
  y: 28,
  u: 24,
  i: 12,
  o: 18,
  p: 19,
  q: 4,
  s: 22,
  d: 7,
  f: 9,
  g: 10,
  h: 11,
  j: 13,
  k: 14,
  l: 15,
  m: 51,
  w: 29,
  x: 27,
  c: 6,
  v: 25,
  b: 5,
  n: 17,
};

const IOS_HID_FRENCH_UNSHIFTED_KEYCODES: Record<string, number> = {
  ...FRENCH_LETTER_KEYCODES,
  ' ': 44,
  '\n': 40,
  '\r': 40,
  '\t': 43,
  ',': 16,
  ';': 54,
  ':': 55,
  '!': 56,
  ')': 45,
  '-': 46,
  '^': 47,
  $: 48,
  ù: 52,
  '@': 53,
};

const IOS_HID_FRENCH_SHIFTED_KEYCODES: Record<string, number> = {
  ...Object.fromEntries(
    Object.entries(FRENCH_LETTER_KEYCODES).map(([char, keycode]) => [
      char.toUpperCase(),
      keycode,
    ]),
  ),
  '1': 30,
  '2': 31,
  '3': 32,
  '4': 33,
  '5': 34,
  '6': 35,
  '7': 36,
  '8': 37,
  '9': 38,
  '0': 39,
  '.': 54,
  '/': 55,
  '?': 16,
  _: 46,
  '*': 48,
  '%': 52,
  '#': 53,
};

export type IosHidLayout = 'us' | 'french';

// AZERTY input sources. Deliberately an exact-match list: "CanadianFrench" and
// "SwissFrench" are QWERTY/QWERTZ and must keep the US table.
const AZERTY_INPUT_SOURCE_IDS = new Set([
  'com.apple.keylayout.French',
  'com.apple.keylayout.French-numerical',
  'com.apple.keylayout.French-PC',
  'com.apple.keylayout.Belgian',
]);

const HOST_KEYBOARD_LAYOUT_TTL_MS = 5_000;
const HOST_KEYBOARD_LAYOUT_TIMEOUT_MS = 1_000;

let cachedIosHidLayout: { layout: IosHidLayout; readAt: number } | null = null;

export function resetIosHidLayoutCacheForTests(): void {
  cachedIosHidLayout = null;
}

export function resolveIosHidLayoutFromInputSourceId(
  inputSourceId: string | undefined,
): IosHidLayout {
  if (!inputSourceId) return 'us';
  return AZERTY_INPUT_SOURCE_IDS.has(inputSourceId.trim()) ? 'french' : 'us';
}

function getIosHidLayoutOverride(): IosHidLayout | null {
  const override = process.env.JC_MOBILE_PREVIEW_IOS_KEYBOARD_LAYOUT;
  if (override === undefined) return null;
  if (override === 'us' || override === 'french') return override;
  debug('iOS HID ignoring unknown keyboard layout override=%s', override);
  return null;
}

/** Last known layout, without blocking. Used only as a mapping fallback. */
function getCachedIosHidLayout(): IosHidLayout {
  return getIosHidLayoutOverride() ?? cachedIosHidLayout?.layout ?? 'us';
}

/**
 * Reads the Mac's current input source. The user can switch layouts mid-session
 * (⌃Space), so the value is only cached for a few seconds.
 */
export async function getHostKeyboardLayout(): Promise<IosHidLayout> {
  const override = getIosHidLayoutOverride();
  if (override) return override;
  if (
    cachedIosHidLayout &&
    Date.now() - cachedIosHidLayout.readAt < HOST_KEYBOARD_LAYOUT_TTL_MS
  ) {
    return cachedIosHidLayout.layout;
  }
  if (process.platform !== 'darwin') return 'us';

  let layout = cachedIosHidLayout?.layout ?? 'us';
  try {
    const { stdout } = await runCommand(
      'defaults',
      [
        'read',
        `${process.env.HOME ?? ''}/Library/Preferences/com.apple.HIToolbox.plist`,
        'AppleCurrentKeyboardLayoutInputSourceID',
      ],
      { timeoutMs: HOST_KEYBOARD_LAYOUT_TIMEOUT_MS },
    );
    layout = resolveIosHidLayoutFromInputSourceId(stdout.trim());
    cachedIosHidLayout = { layout, readAt: Date.now() };
  } catch (error) {
    // Keep the previous value; a transient failure must not latch to US.
    debug(
      'iOS HID host keyboard layout read failed, using %s: %s',
      layout,
      error instanceof Error ? error.message : String(error),
    );
  }
  return layout;
}

const iosHidShiftUsedDeviceIds = new Set<string>();

export type IosTextChunk =
  | { kind: 'hid'; strokes: IosHidKeyStroke[] }
  | { kind: 'paste'; text: string };

/**
 * Either a live map read from the host keyboard layout (preferred, covers every
 * layout) or a static per-layout table used when the native helper is
 * unavailable.
 */
export type IosHidLayoutSource = IosHidLayout | IosHidKeymap;

/**
 * Resolves how characters map to physical keys for the *current* host layout.
 * Prefers the native UCKeyTranslate dump; falls back to the static US/AZERTY
 * tables when it cannot be built (missing Xcode, non-macOS, ...).
 */
export async function resolveIosHidLayoutSource(): Promise<IosHidLayoutSource> {
  // The env override is an escape hatch: it must win over the native helper.
  const override = getIosHidLayoutOverride();
  if (override) return override;
  return (await getHostIosHidKeymap()) ?? (await getHostKeyboardLayout());
}

export function mapCharToIosHidKeyStroke(
  char: string,
  source: IosHidLayoutSource = getCachedIosHidLayout(),
): IosHidKeyStroke | null {
  if (typeof source !== 'string') return source.get(char) ?? null;
  const layout = source;
  const unshiftedMap =
    layout === 'french'
      ? IOS_HID_FRENCH_UNSHIFTED_KEYCODES
      : IOS_HID_UNSHIFTED_KEYCODES;
  const shiftedMap =
    layout === 'french'
      ? IOS_HID_FRENCH_SHIFTED_KEYCODES
      : IOS_HID_SHIFTED_KEYCODES;
  const unshifted = unshiftedMap[char];
  if (unshifted !== undefined) return { keycode: unshifted, shift: false };
  const shifted = shiftedMap[char];
  if (shifted !== undefined) return { keycode: shifted, shift: true };
  return null;
}

/**
 * Splits text into runs typed through the HID stream and runs that have no key
 * on the host layout (emoji, dead-key accents, ...) and must go through
 * Simulator paste. Chunking keeps focus-stealing paste limited to those chars.
 */
export function splitTextForIosInput(
  text: string,
  source: IosHidLayoutSource = getCachedIosHidLayout(),
): IosTextChunk[] {
  const chunks: IosTextChunk[] = [];
  for (const char of text) {
    const stroke = mapCharToIosHidKeyStroke(char, source);
    const last = chunks.at(-1);
    if (stroke) {
      if (last?.kind === 'hid') last.strokes.push(stroke);
      else chunks.push({ kind: 'hid', strokes: [stroke] });
      continue;
    }
    if (last?.kind === 'paste') last.text += char;
    else chunks.push({ kind: 'paste', text: char });
  }
  return chunks;
}

type IdbDescribeResponse = {
  screen_dimensions?: {
    width?: unknown;
    height?: unknown;
    density?: unknown;
    width_points?: unknown;
    height_points?: unknown;
  };
};

const SHOW_IOS_KEYBOARD_SCRIPT = `
tell application "Simulator" to activate
tell application "System Events"
  keystroke "k" using command down
end tell
`.trim();
const PASTE_IOS_TEXT_SCRIPT = `
on run argv
  set pasteText to item 1 of argv
  set previousClipboard to missing value
  try
    set previousClipboard to the clipboard
  end try
  set the clipboard to pasteText
  tell application "Simulator" to activate
  tell application "System Events"
    keystroke "v" using command down
  end tell
  delay 0.05
  if previousClipboard is not missing value then
    set the clipboard to previousClipboard
  end if
end run
`.trim();


export function runIosNonTouchInput(
  sessionId: string | undefined,
  operation: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const active = {
    sessionId,
    controller,
    promise: Promise.resolve(),
  };
  active.promise = Promise.resolve()
    .then(() => {
      controller.signal.throwIfAborted();
      return operation(controller.signal);
    })
    .finally(() => activeIosNonTouchInputs.delete(active));
  activeIosNonTouchInputs.add(active);
  return active.promise;
}

export async function cancelIosNonTouchInputs(sessionId?: string): Promise<void> {
  const inputs = Array.from(activeIosNonTouchInputs).filter(
    (input) => sessionId === undefined || input.sessionId === sessionId,
  );
  inputs.forEach(({ controller }) => controller.abort());
  await Promise.allSettled(inputs.map(({ promise }) => promise));
}

export function getIosFallbackTouchSessionForTests(
  deviceId: string,
): string | null {
  return fallbackTouchesByDeviceId.get(deviceId)?.sessionId ?? null;
}

export function getIosActiveTouchSessionForTests(
  deviceId: string,
): string | null {
  return activeIosTouchesByDeviceId.get(deviceId)?.sessionId ?? null;
}

function assertFiniteNumber(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid iOS input ${name}: expected a finite number.`);
  }
}

export function assertTextInput(text: string): void {
  if (typeof text !== 'string') {
    throw new Error('Invalid iOS text input: expected text string.');
  }
}

export function assertInputEvent(
  event: unknown,
): asserts event is MobilePreviewInputEvent {
  if (!event || typeof event !== 'object' || !('type' in event)) {
    throw new Error(
      'Invalid iOS input event: expected event object with type.',
    );
  }

  const type = event.type;
  if (
    type !== 'touchDown' &&
    type !== 'touchMove' &&
    type !== 'touchUp' &&
    type !== 'tap' &&
    type !== 'longPress' &&
    type !== 'swipe' &&
    type !== 'text' &&
    type !== 'key' &&
    type !== 'showKeyboard'
  ) {
    throw new Error(`Unsupported iOS input event type: ${String(type)}.`);
  }
}

export function buildIdbInputArgs(
  deviceId: string,
  event: MobilePreviewInputEvent | unknown,
): string[] {
  assertDeviceId(deviceId);
  assertInputEvent(event);

  switch (event.type) {
    case 'touchDown':
    case 'touchMove':
    case 'touchUp':
      throw new Error(
        `iOS input event type ${event.type} requires HID stream input.`,
      );
    case 'tap':
      assertFiniteNumber('x', event.x);
      assertFiniteNumber('y', event.y);
      return [
        'ui',
        'tap',
        String(event.x),
        String(event.y),
        '--udid',
        deviceId,
      ];
    case 'longPress':
      assertFiniteNumber('x', event.x);
      assertFiniteNumber('y', event.y);
      assertFiniteNumber('durationMs', event.durationMs);
      return [
        'ui',
        'swipe',
        String(event.x),
        String(event.y),
        String(event.x),
        String(event.y),
        '--duration',
        String(event.durationMs / 1000),
        '--udid',
        deviceId,
      ];
    case 'swipe':
      assertFiniteNumber('x1', event.x1);
      assertFiniteNumber('y1', event.y1);
      assertFiniteNumber('x2', event.x2);
      assertFiniteNumber('y2', event.y2);
      assertFiniteNumber('durationMs', event.durationMs);
      return [
        'ui',
        'swipe',
        String(event.x1),
        String(event.y1),
        String(event.x2),
        String(event.y2),
        '--duration',
        String(event.durationMs / 1000),
        '--udid',
        deviceId,
      ];
    case 'text':
      assertTextInput(event.text);
      throw new Error(
        'iOS text input is handled through HID keystrokes with Simulator paste fallback.',
      );
    case 'showKeyboard':
      throw new Error(
        'iOS keyboard input is handled through Simulator keyboard shortcuts.',
      );
    case 'key':
      if (event.key === 'home') {
        return ['ui', 'button', 'HOME', '--udid', deviceId];
      }
      if (event.key === 'enter') {
        // idb forwards HID keycodes; 36 is Return on Apple keyboards.
        return ['ui', 'key', '36', '--udid', deviceId];
      }
      if (event.key === 'backspace') {
        throw new Error(
          'iOS backspace input is handled through HID key events.',
        );
      }
      if (event.key !== 'back') {
        throw new Error(`Unsupported iOS key input: ${String(event.key)}.`);
      }
      throw new Error(
        'iOS simulator input does not support back button events.',
      );
  }
}

function scaleInputCoordinate({
  value,
  pixelSize,
  pointSize,
}: {
  value: number;
  pixelSize: number | undefined;
  pointSize: number | undefined;
}): number {
  if (!pixelSize || !pointSize) return Math.round(value);
  return Math.round(value * (pointSize / pixelSize));
}

export function scaleInputEventToPoints(
  event: MobilePreviewInputEvent,
  screen: RawStreamSize,
): MobilePreviewInputEvent {
  const x = (value: number) =>
    scaleInputCoordinate({
      value,
      pixelSize: screen.width,
      pointSize: screen.widthPoints,
    });
  const y = (value: number) =>
    scaleInputCoordinate({
      value,
      pixelSize: screen.height,
      pointSize: screen.heightPoints,
    });

  switch (event.type) {
    case 'touchDown':
      return { ...event, x: x(event.x), y: y(event.y) };
    case 'touchMove':
      return { ...event, x: x(event.x), y: y(event.y) };
    case 'touchUp':
      return { ...event, x: x(event.x), y: y(event.y) };
    case 'tap':
      return { ...event, x: x(event.x), y: y(event.y) };
    case 'longPress':
      return { ...event, x: x(event.x), y: y(event.y) };
    case 'swipe':
      return {
        ...event,
        x1: x(event.x1),
        y1: y(event.y1),
        x2: x(event.x2),
        y2: y(event.y2),
      };
    case 'text':
    case 'key':
    case 'showKeyboard':
      return event;
  }
}

export function isTouchLifecycleEvent(
  event: MobilePreviewInputEvent,
): event is Extract<
  MobilePreviewInputEvent,
  { type: 'touchDown' | 'touchMove' | 'touchUp' }
> {
  return (
    event.type === 'touchDown' ||
    event.type === 'touchMove' ||
    event.type === 'touchUp'
  );
}

function getIosHidHelperSourceCandidates(): string[] {
  const candidates = [
    process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE,
    join(process.cwd(), 'electron', 'native', IOS_HID_HELPER_SOURCE),
    join(__dirname, '..', 'native', IOS_HID_HELPER_SOURCE),
  ].filter((candidate): candidate is string => Boolean(candidate));

  if (process.resourcesPath) {
    candidates.push(
      join(process.resourcesPath, 'native', IOS_HID_HELPER_SOURCE),
    );
  }

  candidates.push(
    join(__dirname, '..', '..', 'electron', 'native', IOS_HID_HELPER_SOURCE),
    join(
      __dirname,
      '..',
      '..',
      '..',
      'electron',
      'native',
      IOS_HID_HELPER_SOURCE,
    ),
  );

  return candidates;
}

async function findIosHidHelperSource(): Promise<string> {
  if (process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE) {
    return process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE;
  }

  for (const candidate of getIosHidHelperSourceCandidates()) {
    try {
      await access(candidate, fsConstants.R_OK);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  throw new Error('iOS HID helper source not found.');
}

export function createIosHidHelper(deviceId: string, scriptPath: string) {
  const startedAt = performance.now();
  debug('iOS HID helper spawning deviceId=%s', deviceId);
  const stream = spawnManaged('python3', [scriptPath, deviceId]);
  let stderr = '';
  let stdout = '';
  let closed = false;
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `iOS HID helper did not become ready within ${IOS_HID_HELPER_READY_TIMEOUT_MS / 1000}s.`,
        ),
      );
    }, IOS_HID_HELPER_READY_TIMEOUT_MS);

    stream.child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes('READY')) {
        clearTimeout(timeout);
        debug(
          'iOS HID helper ready deviceId=%s elapsedMs=%d',
          deviceId,
          elapsedMs(startedAt),
        );
        resolve();
      }
    });
    stream.child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendBoundedText(stderr, chunk);
      debug(
        'iOS HID helper stderr deviceId=%s chunk=%s',
        deviceId,
        chunk.toString().trim(),
      );
    });
    stream.child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    stream.child.once('close', (code, signal) => {
      closed = true;
      if (activeHidHelpersByDeviceId.get(deviceId)?.stream === stream) {
        activeHidHelpersByDeviceId.delete(deviceId);
      }
      clearTimeout(timeout);
      reject(
        new Error(
          `iOS HID helper exited after ${elapsedMs(startedAt)}ms (code ${code ?? 'unknown'}, signal ${signal ?? 'none'}): ${stderr.trim()}`,
        ),
      );
    });
  });

  return { stream, ready, isClosed: () => closed };
}

export async function getIosHidHelper(deviceId: string) {
  const active = activeHidHelpersByDeviceId.get(deviceId);
  if (active && !active.isClosed()) {
    await active.ready;
    return active;
  }

  const pending = pendingHidHelpersByDeviceId.get(deviceId);
  if (pending) return pending;

  const helperPromise = (async () => {
    const scriptPath = await findIosHidHelperSource();
    if (isIosPreviewDisposed()) {
      throw new Error('iOS preview input is shutting down.');
    }
    const helper = createIosHidHelper(deviceId, scriptPath);
    activeHidHelpersByDeviceId.set(deviceId, helper);
    try {
      await helper.ready;
    } catch (error) {
      if (activeHidHelpersByDeviceId.get(deviceId) === helper) {
        activeHidHelpersByDeviceId.delete(deviceId);
      }
      await helper.stream.stop();
      throw error;
    }
    iosInputErrorByDeviceId.delete(deviceId);
    return helper;
  })();
  pendingHidHelpersByDeviceId.set(deviceId, helperPromise);
  try {
    return await helperPromise;
  } finally {
    if (pendingHidHelpersByDeviceId.get(deviceId) === helperPromise) {
      pendingHidHelpersByDeviceId.delete(deviceId);
    }
  }
}

export function enqueueIosTouchInput(
  deviceId: string,
  operation: (isCurrent: () => boolean) => Promise<void>,
  sessionId?: string,
): Promise<void> {
  const generation = getIosInputGeneration();
  const isCurrent = () =>
    generation === getIosInputGeneration() &&
    (!sessionId || activeIosSessionIds.has(sessionId));
  const previous = iosTouchInputQueues.get(deviceId) ?? Promise.resolve();
  const result = previous.then(() => {
    if (!isCurrent()) {
      if (generation === getIosInputGeneration() && sessionId) {
        return compensateIosTouch(deviceId, sessionId).then(() => undefined);
      }
      return;
    }
    return operation(isCurrent);
  });
  const settled = result.catch(() => undefined);
  iosTouchInputQueues.set(deviceId, settled);
  void settled.finally(() => {
    if (iosTouchInputQueues.get(deviceId) === settled) {
      iosTouchInputQueues.delete(deviceId);
    }
  });
  return result;
}

export function retainIosHidHelper(deviceId: string): void {
  hidHelperReferenceCountsByDeviceId.set(
    deviceId,
    (hidHelperReferenceCountsByDeviceId.get(deviceId) ?? 0) + 1,
  );
}

export async function releaseIosHidHelper(deviceId: string): Promise<void> {
  const nextCount = (hidHelperReferenceCountsByDeviceId.get(deviceId) ?? 0) - 1;
  if (nextCount > 0) {
    hidHelperReferenceCountsByDeviceId.set(deviceId, nextCount);
    return;
  }

  hidHelperReferenceCountsByDeviceId.delete(deviceId);
  fallbackTouchesByDeviceId.delete(deviceId);
  inputScreenDimensionsByDeviceId.delete(deviceId);
  iosInputErrorByDeviceId.delete(deviceId);
  const helper =
    activeHidHelpersByDeviceId.get(deviceId) ??
    (await pendingHidHelpersByDeviceId.get(deviceId)?.catch(() => undefined));
  if ((hidHelperReferenceCountsByDeviceId.get(deviceId) ?? 0) > 0) return;
  if (helper && activeHidHelpersByDeviceId.get(deviceId) === helper) {
    activeHidHelpersByDeviceId.delete(deviceId);
  }
  if (!helper || helper.isClosed()) return;

  await releaseIosHidModifiers(deviceId, helper);
  await helper.stream.stop();
}

export async function sendIosHidLifecycleEvent(
  deviceId: string,
  event: Extract<
    MobilePreviewInputEvent,
    { type: 'touchDown' | 'touchMove' | 'touchUp' }
  >,
  isCurrent: () => boolean,
  beforeWrite?: () => void,
): Promise<boolean> {
  const screen = await getInputScreenDimensions(deviceId);
  if (!isCurrent()) return false;
  const scaledEvent = scaleInputEventToPoints(event, screen) as typeof event;
  if (event.type !== 'touchMove') {
    debug(
      'iOS HID touch event deviceId=%s type=%s raw=(%d,%d) scaled=(%d,%d) screen=%dx%d points=%sx%s source=%s',
      deviceId,
      event.type,
      event.x,
      event.y,
      scaledEvent.x,
      scaledEvent.y,
      screen.width,
      screen.height,
      screen.widthPoints ?? '(unknown)',
      screen.heightPoints ?? '(unknown)',
      screen.source,
    );
  }
  const helper = await getIosHidHelper(deviceId);
  if (!isCurrent()) return false;
  beforeWrite?.();
  await new Promise<void>((resolve, reject) => {
    helper.stream.child.stdin.write(
      `${JSON.stringify(scaledEvent)}\n`,
      (error) => {
        if (error) {
          debug(
            'iOS HID touch write failed deviceId=%s type=%s error=%s',
            deviceId,
            event.type,
            error.message,
          );
          reject(error);
          return;
        }
        resolve();
      },
    );
  });
  return true;
}

async function writeIosHidKeyEvents(
  deviceId: string,
  events: { type: 'keyDown' | 'keyUp'; keycode: number }[],
  isCurrent: () => boolean,
): Promise<void> {
  const helper = await getIosHidHelper(deviceId);
  if (!isCurrent() || events.length === 0) return;
  await new Promise<void>((resolve, reject) => {
    helper.stream.child.stdin.write(
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

export async function sendIosHidKeyPress(
  deviceId: string,
  keycode: number,
  isCurrent: () => boolean,
): Promise<void> {
  await writeIosHidKeyEvents(
    deviceId,
    [
      { type: 'keyDown', keycode },
      { type: 'keyUp', keycode },
    ],
    isCurrent,
  );
}

/**
 * Types text into the simulator through the idb HID stream, falling back to
 * Simulator paste only for the runs of characters that have no US-layout
 * keycode (emoji, accents, ...). Chunking keeps focus-stealing paste rare.
 */
export async function sendIosHidText(params: {
  deviceId: string;
  text: string;
  isCurrent: () => boolean;
  paste: (text: string) => Promise<void>;
}): Promise<void> {
  const { deviceId, text, isCurrent, paste } = params;
  assertTextInput(text);
  if (!text) return;

  const layoutSource = await resolveIosHidLayoutSource();
  if (!isCurrent()) return;

  for (const chunk of splitTextForIosInput(text, layoutSource)) {
    if (!isCurrent()) return;

    if (chunk.kind === 'paste') {
      await paste(chunk.text);
      continue;
    }

    const events: { type: 'keyDown' | 'keyUp'; keycode: number }[] = [];
    for (const stroke of chunk.strokes) {
      if (stroke.shift) {
        events.push({ type: 'keyDown', keycode: IOS_HID_SHIFT_KEYCODE });
      }
      events.push({ type: 'keyDown', keycode: stroke.keycode });
      events.push({ type: 'keyUp', keycode: stroke.keycode });
      if (stroke.shift) {
        events.push({ type: 'keyUp', keycode: IOS_HID_SHIFT_KEYCODE });
      }
    }
    if (chunk.strokes.some((stroke) => stroke.shift)) {
      iosHidShiftUsedDeviceIds.add(deviceId);
    }
    await writeIosHidKeyEvents(deviceId, events, isCurrent);
  }
}

/**
 * Best-effort release of the shift modifier. A SIGTERM between the keyDown and
 * keyUp lines of a batch would otherwise leave shift latched on the simulator.
 */
export async function releaseIosHidModifiers(
  deviceId: string,
  // Only use an already-running helper: teardown must never respawn one.
  helper = activeHidHelpersByDeviceId.get(deviceId),
): Promise<void> {
  if (!iosHidShiftUsedDeviceIds.delete(deviceId)) return;
  if (!helper || helper.isClosed()) return;
  try {
    await new Promise<void>((resolve, reject) => {
      helper.stream.child.stdin.write(
        `${JSON.stringify({ type: 'keyUp', keycode: IOS_HID_SHIFT_KEYCODE })}\n`,
        (error) => (error ? reject(error) : resolve()),
      );
    });
  } catch {
    // Modifier cleanup is best-effort during teardown.
  }
}

export function prewarmIosHidInput(params: {
  deviceId: string;
  onSession: (patch: Partial<MobilePreviewSession>) => void;
}): void {
  // Compile/read the host layout up front so the first keystroke is not cold.
  void resolveIosHidLayoutSource().catch(() => undefined);
  void getIosHidHelper(params.deviceId)
    .then(() => {
      params.onSession({ inputStatus: 'ready' });
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      iosInputErrorByDeviceId.set(params.deviceId, message);
      debug(
        'iOS HID helper prewarm failed; input unavailable until helper starts deviceId=%s error=%s',
        params.deviceId,
        message,
      );
      params.onSession({ inputStatus: 'error' });
    });
}

export async function sendIdbUiInputEvent(
  deviceId: string,
  event: MobilePreviewInputEvent,
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
): Promise<void> {
  const screen = await getInputScreenDimensions(deviceId, signal);
  const scaledEvent = scaleInputEventToPoints(event, screen);
  if (!isCurrent()) return;
  const args = buildIdbInputArgs(deviceId, scaledEvent);
  await (signal
    ? runCommand('idb', args, { signal })
    : runCommand('idb', args));
}

export async function compensateIosTouch(
  deviceId: string,
  sessionId?: string,
  allowDuringDisposal = false,
): Promise<boolean> {
  if (fallbackTouchesByDeviceId.get(deviceId)?.sessionId === sessionId) {
    fallbackTouchesByDeviceId.delete(deviceId);
  }
  const touch = activeIosTouchesByDeviceId.get(deviceId);
  if (!touch || touch.sessionId !== sessionId) return true;
  let released = false;
  try {
    released = await sendIosHidLifecycleEvent(
      deviceId,
      { type: 'touchUp', x: touch.x, y: touch.y },
      () => allowDuringDisposal || !isIosPreviewDisposed(),
    );
  } catch {
    // Gesture release is best-effort during session cancellation.
  }
  if (released && activeIosTouchesByDeviceId.get(deviceId) === touch) {
    activeIosTouchesByDeviceId.delete(deviceId);
  }
  return released;
}

export async function cancelIosSessionInput(sessionId: string): Promise<void> {
  const devices = new Set([
    ...activeIosTouchesByDeviceId.keys(),
    ...fallbackTouchesByDeviceId.keys(),
    ...iosTouchInputQueues.keys(),
  ]);
  await Promise.all(
    Array.from(devices, (deviceId) =>
      enqueueIosTouchInput(
        deviceId,
        async () => {
          await compensateIosTouch(deviceId, sessionId);
        },
      ),
    ),
  );
}

export function enqueueIosKeyboardInput(
  operation: (isCurrent: () => boolean) => Promise<void>,
  sessionId?: string,
): Promise<void> {
  const generation = getIosInputGeneration();
  const isCurrent = () =>
    generation === getIosInputGeneration() &&
    (!sessionId || activeIosSessionIds.has(sessionId));
  const result = getIosKeyboardInputQueue().then(() => {
    if (!isCurrent()) return;
    return operation(isCurrent);
  });
  setIosKeyboardInputQueue(result.catch(() => undefined));
  return result;
}

export function ownIosStream<T extends {
  session: MobilePreviewSession;
  stop: () => Promise<void>;
}>(stream: T): T {
  activeIosSessionIds.add(stream.session.id);
  const originalStop = stream.stop;
  let stopPromise: Promise<void> | null = null;
  return {
    ...stream,
    stop: () => {
      stopPromise ??= (async () => {
        activeIosSessionIds.delete(stream.session.id);
        await Promise.all([
          cancelIosSessionInput(stream.session.id),
          cancelIosNonTouchInputs(stream.session.id),
        ]);
        await originalStop();
      })();
      return stopPromise;
    },
  };
}

export async function showIosSoftwareKeyboard(signal?: AbortSignal): Promise<void> {
  await runCommand('osascript', ['-e', SHOW_IOS_KEYBOARD_SCRIPT], {
    signal,
    timeoutMs: SHOW_IOS_KEYBOARD_TIMEOUT_MS,
  });
}

export async function pasteIosText(text: string, signal?: AbortSignal): Promise<void> {
  assertTextInput(text);
  if (!text) return;

  await runCommand('osascript', ['-e', PASTE_IOS_TEXT_SCRIPT, text], {
    signal,
    timeoutMs: PASTE_IOS_TEXT_TIMEOUT_MS,
  });
}

export async function sendFallbackTouchLifecycleEvent(
  deviceId: string,
  event: Extract<
    MobilePreviewInputEvent,
    { type: 'touchDown' | 'touchMove' | 'touchUp' }
  >,
  sessionId?: string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!isCurrent()) return;
  if (event.type === 'touchDown') {
    fallbackTouchesByDeviceId.set(deviceId, {
      x: event.x,
      y: event.y,
      currentX: event.x,
      currentY: event.y,
      startedAt: Date.now(),
      sessionId,
    });
    return;
  }

  const touch = fallbackTouchesByDeviceId.get(deviceId);
  if (!touch || touch.sessionId !== sessionId) return;

  if (event.type === 'touchMove') {
    touch.currentX = event.x;
    touch.currentY = event.y;
    return;
  }

  fallbackTouchesByDeviceId.delete(deviceId);
  const distance = Math.hypot(event.x - touch.x, event.y - touch.y);
  if (distance < 8) {
    await sendIdbUiInputEvent(
      deviceId,
      {
        type: 'tap',
        x: event.x,
        y: event.y,
      },
      isCurrent,
    );
    return;
  }

  await sendIdbUiInputEvent(
    deviceId,
    {
      type: 'swipe',
      x1: touch.x,
      y1: touch.y,
      x2: event.x,
      y2: event.y,
      durationMs: Math.min(250, Math.max(80, Date.now() - touch.startedAt)),
    },
    isCurrent,
  );
}

export async function getIdbScreenDimensions(
  deviceId: string,
  signal?: AbortSignal,
): Promise<RawStreamSize> {
  const args = ['describe', '--udid', deviceId, '--json'];
  const { stdout } = await (signal
    ? runCommand('idb', args, { signal })
    : runCommand('idb', args));
  let parsed: IdbDescribeResponse;

  try {
    parsed = JSON.parse(stdout) as IdbDescribeResponse;
  } catch (error) {
    throw new Error(
      `Invalid idb describe JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const width = parsed.screen_dimensions?.width;
  const height = parsed.screen_dimensions?.height;
  const density = parsed.screen_dimensions?.density;
  const widthPoints = parsed.screen_dimensions?.width_points;
  const heightPoints = parsed.screen_dimensions?.height_points;

  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    width <= 0 ||
    height <= 0 ||
    !Number.isInteger(width) ||
    !Number.isInteger(height)
  ) {
    throw new Error('idb describe did not include valid screen_dimensions.');
  }

  return {
    width,
    height,
    density: typeof density === 'number' && density > 0 ? density : undefined,
    widthPoints:
      typeof widthPoints === 'number' && widthPoints > 0
        ? widthPoints
        : undefined,
    heightPoints:
      typeof heightPoints === 'number' && heightPoints > 0
        ? heightPoints
        : undefined,
    source: 'idb-describe',
  };
}

export async function getInputScreenDimensions(
  deviceId: string,
  signal?: AbortSignal,
): Promise<RawStreamSize> {
  const cached = inputScreenDimensionsByDeviceId.get(deviceId);
  if (cached) return cached;

  const screen = await getIdbScreenDimensions(deviceId, signal);
  debug(
    'iOS input screen dimensions deviceId=%s width=%d height=%d points=%sx%s density=%s source=%s',
    deviceId,
    screen.width,
    screen.height,
    screen.widthPoints ?? '(unknown)',
    screen.heightPoints ?? '(unknown)',
    screen.density ?? '(unknown)',
    screen.source,
  );
  inputScreenDimensionsByDeviceId.set(deviceId, screen);
  return screen;
}
