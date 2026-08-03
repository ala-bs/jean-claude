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
      throw new Error('iOS text input is handled through Simulator paste.');
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

export async function sendIosHidKeyPress(
  deviceId: string,
  keycode: number,
  isCurrent: () => boolean,
): Promise<void> {
  const helper = await getIosHidHelper(deviceId);
  if (!isCurrent()) return;
  const events = [
    { type: 'keyDown', keycode },
    { type: 'keyUp', keycode },
  ];
  await new Promise<void>((resolve, reject) => {
    helper.stream.child.stdin.write(
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

export function prewarmIosHidInput(params: {
  deviceId: string;
  onSession: (patch: Partial<MobilePreviewSession>) => void;
}): void {
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
