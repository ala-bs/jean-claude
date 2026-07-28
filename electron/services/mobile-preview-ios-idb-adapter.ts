import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

import type {
  MobileColorScheme,
  MobilePreviewDevice,
  MobilePreviewInputEvent,
  MobilePreviewIosAppRestartParams,
  MobilePreviewIosAppRestartResult,
  MobilePreviewIosAppStatus,
  MobilePreviewIosAppStatusParams,
  MobilePreviewIosCreateDeviceParams,
  MobilePreviewIosDeviceType,
  MobilePreviewIosRenameDeviceParams,
  MobilePreviewIosRuntime,
  MobilePreviewIosToolStatus,
  MobilePreviewQuality,
  MobilePreviewSession,
  MobilePreviewTextSize,
  MobileRotationDirection,
} from '../../shared/mobile-simulator-types';

import {
  commandExists,
  MOBILE_PREVIEW_DEEPLINK_OPEN_TIMEOUT_MS,
  runCommand,
  spawnManaged,
} from './mobile-preview-process';
import {
  IOS_SIMULATOR_PROCESS_NAMES,
  minimizeMobilePreviewWindows,
} from './mobile-preview-window-utils';
import { dbg } from '../lib/debug';

type SimctlDevice = {
  name?: unknown;
  udid?: unknown;
  state?: unknown;
};

type SimctlDevicesResponse = {
  devices?: Record<string, SimctlDevice[]>;
};

type IdbDescribeResponse = {
  screen_dimensions?: {
    width?: unknown;
    height?: unknown;
    density?: unknown;
    width_points?: unknown;
    height_points?: unknown;
  };
};

const IOS_CONTENT_SIZE: Record<MobilePreviewTextSize, string> = {
  small: 'small',
  normal: 'large',
  large: 'extra-large',
  'x-large': 'accessibility-large',
};

function assertDeeplinkUrl(url: string): void {
  if (!url.trim()) {
    throw new Error('Deeplink URL is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Deeplink URL must include a valid scheme');
  }

  if (!parsed.protocol || parsed.protocol === 'file:') {
    throw new Error('Unsupported deeplink URL scheme');
  }
}

type RawStreamSize = {
  width: number;
  height: number;
  density?: number;
  widthPoints?: number;
  heightPoints?: number;
  source: 'idb-describe' | 'simctl-screenshot';
};

export const MAX_MJPEG_PENDING_BYTES = 5 * 1024 * 1024;
export const MAX_STREAM_STDERR_BYTES = 8 * 1024;
export const FIRST_FRAME_TIMEOUT_MS = 7_000;
export const SCREENSHOT_POLL_INTERVAL_MS = 250;
export const CORE_SIMULATOR_FIRST_FRAME_TIMEOUT_MS = 15_000;
const CORE_SIMULATOR_POOL_TTL_MS = 5 * 60_000;

const IOS_RUNTIME_PREFIX = 'com.apple.CoreSimulator.SimRuntime.iOS-';
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
const CORE_SIMULATOR_HELPER_SOURCE = 'mobile-preview-ios-framebuffer.m';
const CORE_SIMULATOR_HELPER_BINARY = 'mobile-preview-ios-framebuffer';
const IOS_HID_HELPER_SOURCE = 'mobile-preview-ios-hid-helper.py';
const DEFAULT_CORE_SIMULATOR_FPS = 30;
const MIN_CORE_SIMULATOR_FPS = 1;
const MAX_CORE_SIMULATOR_FPS = 60;
const SHOW_IOS_KEYBOARD_TIMEOUT_MS = 3_000;
const PASTE_IOS_TEXT_TIMEOUT_MS = 3_000;
const IOS_SCREENSHOT_TIMEOUT_MS = 5_000;
const IOS_HID_HELPER_READY_TIMEOUT_MS = 2_000;
const EXPO_CONFIG_TIMEOUT_MS = 10_000;
const IOS_HID_BACKSPACE_KEYCODE = 42;
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
const inputScreenDimensionsByDeviceId = new Map<string, RawStreamSize>();
const pendingIosSimulatorBootsByDeviceId = new Map<
  string,
  {
    promise: Promise<MobilePreviewDevice>;
    abortController: AbortController;
    waiters: Set<symbol>;
  }
>();
export function getPendingIosBootWaiterCountForTests(deviceId: string): number {
  return pendingIosSimulatorBootsByDeviceId.get(deviceId)?.waiters.size ?? 0;
}
type ActiveIosAppStatus = {
  promise: Promise<MobilePreviewIosAppStatus>;
  abortController: AbortController;
};
const activeIosAppStatuses = new Set<ActiveIosAppStatus>();
type ActiveIosAppRestart = {
  promise: Promise<MobilePreviewIosAppRestartResult>;
  abortController: AbortController;
};
const activeIosAppRestarts = new Set<ActiveIosAppRestart>();
let iosKeyboardInputQueue = Promise.resolve();
let iosInputGeneration = 0;
const activeIosSessionIds = new Set<string>();
const activeHidHelpersByDeviceId = new Map<
  string,
  ReturnType<typeof createIosHidHelper>
>();
const pendingHidHelpersByDeviceId = new Map<
  string,
  Promise<ReturnType<typeof createIosHidHelper>>
>();
const iosTouchInputQueues = new Map<string, Promise<void>>();
let iosPreviewDisposed = false;
const iosInputErrorByDeviceId = new Map<string, string>();
const activeIosTouchesByDeviceId = new Map<
  string,
  { sessionId?: string; x: number; y: number }
>();
const hidHelperReferenceCountsByDeviceId = new Map<string, number>();
type CoreSimulatorPoolEntry = {
  key: string;
  deviceId: string;
  stream: ReturnType<typeof spawnManaged>;
  parseFrames: (chunk: Buffer) => void;
  consumers: Map<string, CoreSimulatorActiveStream>;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  recentStderr: string;
};
type CoreSimulatorActiveStream = {
  frameCount: number;
  stopped: boolean;
  helperSettled: boolean;
  didPrewarmInput: boolean;
  firstFrameTimer: ReturnType<typeof setTimeout> | null;
  handleHelperFailure: ((reason: string) => void) | null;
  stop: (() => Promise<void>) | null;
  params: {
    taskId: string;
    deviceId: string;
    fps?: number;
    quality?: MobilePreviewQuality;
    onFrame: (frame: Buffer) => void;
    onSession: (patch: Partial<MobilePreviewSession>) => void;
  };
};
const coreSimulatorPool = new Map<string, CoreSimulatorPoolEntry>();
const pendingCoreSimulatorPoolEntries = new Map<
  string,
  {
    abortController: AbortController;
    promise: Promise<CoreSimulatorPoolEntry>;
    waiters: Set<symbol>;
  }
>();
const activeScreenshotStreamStops = new Set<() => Promise<void>>();
const activeCoreSimulatorStreamStops = new Set<() => Promise<void>>();
const activeIosNonTouchInputs = new Set<{
  sessionId?: string;
  controller: AbortController;
  promise: Promise<void>;
}>();

function waitForSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function runIosNonTouchInput(
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

async function cancelIosNonTouchInputs(sessionId?: string): Promise<void> {
  const inputs = Array.from(activeIosNonTouchInputs).filter(
    (input) => sessionId === undefined || input.sessionId === sessionId,
  );
  inputs.forEach(({ controller }) => controller.abort());
  await Promise.allSettled(inputs.map(({ promise }) => promise));
}

export async function resetCoreSimulatorFramebufferPoolForTests(): Promise<void> {
  iosPreviewDisposed = true;
  iosInputGeneration += 1;
  activeIosSessionIds.clear();
  const nonTouchInputs = cancelIosNonTouchInputs();
  const pendingBoots = Array.from(pendingIosSimulatorBootsByDeviceId.values());
  const activeStatuses = Array.from(activeIosAppStatuses);
  const activeRestarts = Array.from(activeIosAppRestarts);
  activeStatuses.forEach(({ abortController }) =>
    abortController.abort(new Error('iOS preview is shutting down.')),
  );
  activeRestarts.forEach(({ abortController }) =>
    abortController.abort(new Error('iOS preview is shutting down.')),
  );
  pendingBoots.forEach(({ abortController }) =>
    abortController.abort(new Error('iOS preview is shutting down.')),
  );
  await Promise.allSettled([
    nonTouchInputs,
    ...activeStatuses.map(({ promise }) => promise),
    ...activeRestarts.map(({ promise }) => promise),
    ...pendingBoots.map(({ promise }) => promise),
  ]);
  const pendingBuilds = Array.from(pendingCoreSimulatorPoolEntries.values());
  pendingBuilds.forEach(({ abortController }) => abortController.abort());
  await Promise.allSettled(pendingBuilds.map(({ promise }) => promise));
  const entries = Array.from(coreSimulatorPool.values());
  const screenshotStops = Array.from(activeScreenshotStreamStops);
  const hidHelpers = Array.from(activeHidHelpersByDeviceId.values());
  coreSimulatorPool.clear();
  activeIosAppStatuses.clear();
  activeIosAppRestarts.clear();
  pendingIosSimulatorBootsByDeviceId.clear();
  pendingCoreSimulatorPoolEntries.clear();
  activeScreenshotStreamStops.clear();
  activeCoreSimulatorStreamStops.clear();
  activeHidHelpersByDeviceId.clear();
  pendingHidHelpersByDeviceId.clear();
  iosTouchInputQueues.clear();
  hidHelperReferenceCountsByDeviceId.clear();
  fallbackTouchesByDeviceId.clear();
  activeIosTouchesByDeviceId.clear();
  inputScreenDimensionsByDeviceId.clear();
  iosInputErrorByDeviceId.clear();
  await Promise.all(
    [
      ...entries.map((entry) => {
        if (entry.cleanupTimer) {
          clearTimeout(entry.cleanupTimer);
          entry.cleanupTimer = null;
        }
        return entry.stream.stop();
      }),
      ...screenshotStops.map((stop) => stop()),
      ...hidHelpers.map((helper) => helper.stream.stop()),
    ],
  );
  iosPreviewDisposed = false;
}

async function disposeIosPreviewResources(): Promise<void> {
  const stopErrors: unknown[] = [];
  const collectStopErrors = (results: PromiseSettledResult<unknown>[]) => {
    for (const result of results) {
      if (result.status === 'rejected') stopErrors.push(result.reason);
    }
  };
  iosInputGeneration += 1;
  activeIosSessionIds.clear();
  const nonTouchInputs = cancelIosNonTouchInputs();
  const establishedTouches = Array.from(
    activeIosTouchesByDeviceId,
    ([deviceId, touch]) => ({ deviceId, sessionId: touch.sessionId }),
  );
  iosPreviewDisposed = true;
  const pendingBoots = Array.from(pendingIosSimulatorBootsByDeviceId.values());
  const activeStatuses = Array.from(activeIosAppStatuses);
  const activeRestarts = Array.from(activeIosAppRestarts);
  debug(
    'iOS preview disposal aborting active statuses=%d active restarts=%d pending boots=%d',
    activeStatuses.length,
    activeRestarts.length,
    pendingBoots.length,
  );
  activeStatuses.forEach(({ abortController }) =>
    abortController.abort(new Error('iOS preview is shutting down.')),
  );
  activeRestarts.forEach(({ abortController }) =>
    abortController.abort(new Error('iOS preview is shutting down.')),
  );
  pendingBoots.forEach(({ abortController }) =>
    abortController.abort(new Error('iOS preview is shutting down.')),
  );
  await Promise.all(
    establishedTouches.map(({ deviceId, sessionId }) =>
      enqueueIosTouchInput(deviceId, async () => {
        await compensateIosTouch(deviceId, sessionId, true);
      }),
    ),
  );
  await Promise.allSettled([
    ...activeStatuses.map(({ promise }) => promise),
    ...activeRestarts.map(({ promise }) => promise),
    ...pendingBoots.map(({ promise }) => promise),
  ]);
  const pendingBuilds = Array.from(pendingCoreSimulatorPoolEntries.values());
  pendingBuilds.forEach(({ abortController }) => abortController.abort());
  await Promise.allSettled(pendingBuilds.map(({ promise }) => promise));
  const queuedInput = [
    iosKeyboardInputQueue,
    ...Array.from(iosTouchInputQueues.values()),
  ];
  const pendingStarts = [
    ...Array.from(pendingHidHelpersByDeviceId.values()),
  ];
  for (const pending of pendingStarts) {
    void pending.catch(() => undefined);
  }
  const earlyHidHelpers = Array.from(activeHidHelpersByDeviceId.values());
  const earlyHidStops = earlyHidHelpers.map((helper) => helper.stream.stop());
  const [, earlyStopResults] = await Promise.all([
    Promise.allSettled([...queuedInput, nonTouchInputs]),
    Promise.allSettled(earlyHidStops),
  ]);
  collectStopErrors(earlyStopResults);
  const poolEntries = Array.from(coreSimulatorPool.values());
  const activeStops = Array.from(activeCoreSimulatorStreamStops);
  const screenshotStops = Array.from(activeScreenshotStreamStops);
  coreSimulatorPool.clear();
  activeIosAppStatuses.clear();
  activeIosAppRestarts.clear();
  pendingIosSimulatorBootsByDeviceId.clear();
  pendingCoreSimulatorPoolEntries.clear();
  activeScreenshotStreamStops.clear();
  activeCoreSimulatorStreamStops.clear();
  collectStopErrors(
    await Promise.allSettled([
      ...activeStops.map((stop) => stop()),
      ...screenshotStops.map((stop) => stop()),
    ]),
  );
  const hidHelpers = Array.from(activeHidHelpersByDeviceId.values());
  activeHidHelpersByDeviceId.clear();
  pendingHidHelpersByDeviceId.clear();
  iosTouchInputQueues.clear();
  hidHelperReferenceCountsByDeviceId.clear();
  fallbackTouchesByDeviceId.clear();
  activeIosTouchesByDeviceId.clear();
  inputScreenDimensionsByDeviceId.clear();
  iosInputErrorByDeviceId.clear();
  collectStopErrors(
    await Promise.allSettled([
      ...poolEntries.map((entry) => {
        if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
        return entry.stream.stop();
      }),
      ...hidHelpers.map((helper) => helper.stream.stop()),
    ]),
  );
  if (stopErrors.length > 0) {
    const messages = stopErrors.map((error) =>
      error instanceof Error ? error.message : String(error),
    );
    throw new AggregateError(
      stopErrors,
      `Failed to dispose iOS preview resources: ${messages.join('; ')}`,
    );
  }
}
const fallbackTouchesByDeviceId = new Map<
  string,
  {
    x: number;
    y: number;
    currentX: number;
    currentY: number;
    startedAt: number;
    sessionId?: string;
  }
>();

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

const debug = dbg.mobilePreview;

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

const IOS_IDB_COMPRESSION_QUALITY: Record<MobilePreviewQuality, string> = {
  low: '0.35',
  balanced: '0.6',
  high: '0.9',
  'very-high': '1.0',
};

const IOS_CORE_SIMULATOR_JPEG_QUALITY: Record<MobilePreviewQuality, string> = {
  low: '0.35',
  balanced: '0.6',
  high: '0.9',
  'very-high': '1.0',
};

function buildStartStreamArgs(
  deviceId: string,
  quality: MobilePreviewQuality = 'high',
): string[] {
  return [
    'video-stream',
    '--udid',
    deviceId,
    '--format',
    'rbga',
    '--fps',
    '15',
    '--compression-quality',
    IOS_IDB_COMPRESSION_QUALITY[quality],
  ];
}

function normalizePreviewFps(fps: number | undefined): number {
  if (fps === undefined || !Number.isFinite(fps)) {
    return DEFAULT_CORE_SIMULATOR_FPS;
  }
  return Math.min(
    MAX_CORE_SIMULATOR_FPS,
    Math.max(MIN_CORE_SIMULATOR_FPS, Math.round(fps)),
  );
}

function getScreenshotPollIntervalMs(fps: number | undefined): number {
  return Math.round(1000 / normalizePreviewFps(fps));
}

function describeChunk(chunk: Buffer): string {
  return chunk.subarray(0, 24).toString('hex');
}

async function getCommandPath(command: string): Promise<string> {
  try {
    const { stdout } = await runCommand('which', [command]);
    return stdout.trim() || '(not found)';
  } catch (error) {
    return `lookup failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function assertXcrunAvailable(signal?: AbortSignal): Promise<void> {
  const available = signal
    ? await commandExists('xcrun', { signal })
    : await commandExists('xcrun');
  if (!available) {
    throw new Error(
      'Missing required iOS preview tool: xcrun. Install Xcode Command Line Tools with `xcode-select --install` to list and boot iOS simulators.',
    );
  }
}

async function assertIdbAvailable(signal?: AbortSignal): Promise<void> {
  if (!(await commandExists('idb', signal ? { signal } : undefined))) {
    throw new Error(
      'Missing required iOS preview tool: idb. Install iOS streaming tools: `brew tap facebook/fb && brew install idb-companion` and `python3 -m pip install fb-idb` (or `pipx install fb-idb`). Then ensure the `idb` command is on PATH and restart Jean-Claude.',
    );
  }
}

function mapDeviceState(state: unknown): MobilePreviewDevice['state'] {
  if (state === 'Booted') return 'booted';
  if (state === 'Shutdown') return 'shutdown';
  return 'unknown';
}

function formatIosRuntimeVersion(runtime: string): string {
  const version = runtime.slice(IOS_RUNTIME_PREFIX.length).replaceAll('-', '.');
  return `iOS ${version}`;
}

export function parseSimctlDevices(json: string): MobilePreviewDevice[] {
  let parsed: SimctlDevicesResponse;

  try {
    parsed = JSON.parse(json) as SimctlDevicesResponse;
  } catch (error) {
    throw new Error(
      `Invalid simctl devices JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !parsed.devices ||
    typeof parsed.devices !== 'object' ||
    Array.isArray(parsed.devices)
  ) {
    throw new Error(
      'Invalid simctl devices JSON: expected root devices object.',
    );
  }

  return Object.entries(parsed.devices).flatMap(([runtime, devices]) => {
    if (!runtime.startsWith(IOS_RUNTIME_PREFIX)) return [];
    if (!Array.isArray(devices)) return [];

    return devices.flatMap((device) => {
      if (typeof device.udid !== 'string' || typeof device.name !== 'string') {
        return [];
      }

      return [
        {
          id: device.udid,
          name: device.name,
          platform: 'ios' as const,
          state: mapDeviceState(device.state),
          osVersion: formatIosRuntimeVersion(runtime),
        },
      ];
    });
  });
}

export function parseSimctlRuntimes(
  json: string,
): MobilePreviewIosRuntime[] {
  let parsed: { runtimes?: unknown };

  try {
    parsed = JSON.parse(json) as { runtimes?: unknown };
  } catch (error) {
    throw new Error(
      `Invalid simctl runtimes JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.runtimes)) {
    throw new Error(
      'Invalid simctl runtimes JSON: expected root runtimes array.',
    );
  }

  return parsed.runtimes
    .filter(
      (runtime): runtime is Record<string, unknown> =>
        !!runtime && typeof runtime === 'object',
    )
    .filter((runtime) => runtime.platform === 'iOS')
    .map((runtime) => ({
      id: typeof runtime.identifier === 'string' ? runtime.identifier : '',
      name: typeof runtime.name === 'string' ? runtime.name : '',
      version: typeof runtime.version === 'string' ? runtime.version : null,
      platform: 'iOS',
      available: runtime.isAvailable === true,
    }))
    .filter((runtime) => runtime.id && runtime.name)
    .sort((a, b) =>
      (b.version ?? b.name).localeCompare(a.version ?? a.name, undefined, {
        numeric: true,
      }),
    );
}

export function parseSimctlDeviceTypes(
  json: string,
): MobilePreviewIosDeviceType[] {
  let parsed: { devicetypes?: unknown };

  try {
    parsed = JSON.parse(json) as { devicetypes?: unknown };
  } catch (error) {
    throw new Error(
      `Invalid simctl device types JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray(parsed.devicetypes)
  ) {
    throw new Error(
      'Invalid simctl device types JSON: expected root devicetypes array.',
    );
  }

  return parsed.devicetypes
    .filter(
      (deviceType): deviceType is Record<string, unknown> =>
        !!deviceType && typeof deviceType === 'object',
    )
    .map((deviceType) => ({
      id:
        typeof deviceType.identifier === 'string' ? deviceType.identifier : '',
      name: typeof deviceType.name === 'string' ? deviceType.name : '',
      productFamily:
        typeof deviceType.productFamily === 'string'
          ? deviceType.productFamily
          : null,
      screen: parseIosDeviceTypeScreen(deviceType),
    }))
    .filter(
      (deviceType) =>
        deviceType.id &&
        deviceType.name &&
        deviceType.productFamily === 'iPhone',
    );
}

function parseIosDeviceTypeScreen(deviceType: Record<string, unknown>) {
  const screen = deviceType.screen;
  if (screen && typeof screen === 'object' && !Array.isArray(screen)) {
    const width = Number((screen as Record<string, unknown>).width);
    const height = Number((screen as Record<string, unknown>).height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }

  const width = Number(deviceType.width ?? deviceType.screenWidth);
  const height = Number(deviceType.height ?? deviceType.screenHeight);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width, height };
  }

  return null;
}

export function createMjpegFrameParser(
  onFrame: (frame: Buffer) => void,
  options: { maxPendingBytes?: number } = {},
): (chunk: Buffer) => void {
  let pending = Buffer.alloc(0);
  const maxPendingBytes = options.maxPendingBytes ?? MAX_MJPEG_PENDING_BYTES;

  const dropOrResyncOversizedPending = () => {
    if (pending.length <= maxPendingBytes) return;

    const lastSoi = pending.lastIndexOf(JPEG_SOI);
    if (lastSoi > 0 && pending.length - lastSoi <= maxPendingBytes) {
      pending = pending.subarray(lastSoi);
      return;
    }

    pending = pending.at(-1) === 0xff ? pending.subarray(-1) : Buffer.alloc(0);
  };

  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    dropOrResyncOversizedPending();

    while (pending.length > 0) {
      const soi = pending.indexOf(JPEG_SOI);
      if (soi === -1) {
        pending =
          pending.at(-1) === 0xff ? pending.subarray(-1) : Buffer.alloc(0);
        return;
      }

      if (soi > 0) pending = pending.subarray(soi);

      const eoi = pending.indexOf(JPEG_EOI, 2);
      if (eoi === -1) {
        dropOrResyncOversizedPending();
        return;
      }

      const frameEnd = eoi + 2;
      onFrame(Buffer.from(pending.subarray(0, frameEnd)));
      pending = pending.subarray(frameEnd);
    }
  };
}

function assertDeviceId(deviceId: string): void {
  if (!deviceId.trim()) {
    throw new Error('iOS simulator deviceId is required.');
  }
}

function assertSafeSimctlValue(label: string, value: string): void {
  if (!value.trim()) {
    throw new Error(`${label} is required.`);
  }

  if (value.startsWith('-')) {
    throw new Error(`${label} cannot start with '-'.`);
  }
}

function assertSafeSimctlDeviceSelector(label: string, value: string): void {
  assertSafeSimctlValue(label, value);

  const selector = value.trim().toLowerCase();
  if (
    selector === 'all' ||
    selector === 'unavailable' ||
    selector === 'booted'
  ) {
    throw new Error(`${label} cannot be a simctl selector: ${value}.`);
  }
}

class UnsafeIosAppPathError extends Error {}

function isSameOrChildPath(rootPath: string, targetPath: string): boolean {
  const relativePath = relative(rootPath, targetPath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  );
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

async function resolveInsideAppRoot(
  appRoot: string,
  targetPath: string,
): Promise<string> {
  const canonicalPath = await realpath(targetPath);
  if (!isSameOrChildPath(appRoot, canonicalPath)) {
    throw new UnsafeIosAppPathError(
      'iOS app path resolves outside trusted root.',
    );
  }
  return canonicalPath;
}

async function findInsideAppRoot(
  appRoot: string,
  targetPath: string,
): Promise<string | null> {
  try {
    return await resolveInsideAppRoot(appRoot, targetPath);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

async function readTextFileInsideAppRoot(
  appRoot: string,
  targetPath: string,
): Promise<string> {
  const canonicalPath = await resolveInsideAppRoot(appRoot, targetPath);
  const handle = await open(
    canonicalPath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function resolveTrustedIosAppRoot({
  trustedRoot,
  appPath,
}: {
  trustedRoot: string;
  appPath: string;
}): Promise<string> {
  if (!appPath.trim()) {
    throw new Error('iOS app path is required.');
  }
  if (!isAbsolute(appPath)) {
    throw new Error('iOS app path must be absolute.');
  }
  if (!trustedRoot.trim() || !isAbsolute(trustedRoot)) {
    throw new Error('iOS trusted root must be absolute.');
  }
  const canonicalTrustedRoot = await realpath(resolve(trustedRoot));
  if (canonicalTrustedRoot !== resolve(trustedRoot)) {
    throw new UnsafeIosAppPathError('iOS trusted root changed after validation.');
  }
  const canonicalAppPath = await realpath(resolve(appPath));
  if (!isSameOrChildPath(canonicalTrustedRoot, canonicalAppPath)) {
    throw new UnsafeIosAppPathError(
      'iOS app path resolves outside trusted root.',
    );
  }
  return canonicalAppPath;
}

function normalizeBundleId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const bundleId = value.trim();
  if (
    !bundleId ||
    bundleId.startsWith('-') ||
    bundleId.includes('$(') ||
    bundleId.includes('${') ||
    !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(bundleId)
  ) {
    return null;
  }
  return bundleId;
}

function parseExpoBundleId(output: string): string | null {
  const config = JSON.parse(output) as Record<string, unknown>;
  const expo =
    config.expo && typeof config.expo === 'object'
      ? (config.expo as Record<string, unknown>)
      : config;
  const ios = expo.ios;
  return ios && typeof ios === 'object'
    ? normalizeBundleId((ios as Record<string, unknown>).bundleIdentifier)
    : null;
}

function getExpoConfigCommand(
  packageManager: MobilePreviewIosAppStatusParams['packageManager'],
): { command: string; args: string[] } {
  if (packageManager === 'pnpm') {
    return { command: 'pnpm', args: ['exec', 'expo', 'config', '--json'] };
  }
  if (packageManager === 'yarn') {
    return { command: 'yarn', args: ['expo', 'config', '--json'] };
  }
  if (packageManager === 'bun') {
    return {
      command: 'bunx',
      args: ['--no-install', 'expo', 'config', '--json'],
    };
  }
  return {
    command: 'npm',
    args: ['exec', '--offline', '--', 'expo', 'config', '--json'],
  };
}

function parsePackageManager(value: unknown) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(pnpm|npm|yarn|bun)(?:@|$)/);
  return match?.[1] as MobilePreviewIosAppStatusParams['packageManager'];
}

async function resolveAppPackageManager(
  appPath: string,
): Promise<MobilePreviewIosAppStatusParams['packageManager']> {
  const packageJsonPath = await findInsideAppRoot(
    appPath,
    join(appPath, 'package.json'),
  );
  if (packageJsonPath) {
    try {
      const packageJson = JSON.parse(
        await readTextFileInsideAppRoot(appPath, packageJsonPath),
      ) as Record<string, unknown>;
      const packageManager = parsePackageManager(packageJson.packageManager);
      if (packageManager) return packageManager;
    } catch (error) {
      if (error instanceof UnsafeIosAppPathError) throw error;
      // Invalid package metadata does not prevent lockfile detection.
    }
  }

  for (const [lockfile, packageManager] of [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ] as const) {
    if (await findInsideAppRoot(appPath, join(appPath, lockfile))) {
      return packageManager;
    }
  }
  return null;
}

async function readExpoBundleId({
  appPath,
  packageManager,
  signal,
}: {
  appPath: string;
  packageManager: MobilePreviewIosAppStatusParams['packageManager'];
  signal?: AbortSignal;
}): Promise<string | null> {
  const dynamicConfig =
    (await findInsideAppRoot(appPath, join(appPath, 'app.config.js'))) ??
    (await findInsideAppRoot(appPath, join(appPath, 'app.config.ts')));
  if (dynamicConfig) {
    const appPackageManager = await resolveAppPackageManager(appPath);
    signal?.throwIfAborted();
    const { command, args } = getExpoConfigCommand(
      appPackageManager ?? packageManager,
    );
    try {
      const { stdout } = await runCommand(command, args, {
        cwd: appPath,
        env: { ...process.env, EXPO_OFFLINE: '1', CI: '1' },
        timeoutMs: EXPO_CONFIG_TIMEOUT_MS,
        signal,
      });
      return parseExpoBundleId(stdout);
    } catch (error) {
      debug(
        'Expo config resolution failed errorType=%s',
        error instanceof Error ? error.name : typeof error,
      );
      return null;
    }
  }

  const configPath =
    (await findInsideAppRoot(appPath, join(appPath, 'app.config.json'))) ??
    (await findInsideAppRoot(appPath, join(appPath, 'app.json')));
  if (!configPath) return null;
  try {
    return parseExpoBundleId(await readTextFileInsideAppRoot(appPath, configPath));
  } catch (error) {
    if (error instanceof UnsafeIosAppPathError) throw error;
    return null;
  }
}

async function getNativeProjectFiles(
  appPath: string,
  signal?: AbortSignal,
): Promise<{
  iosPath: string | null;
  projectFiles: string[];
}> {
  const iosPath = await findInsideAppRoot(appPath, join(appPath, 'ios'));
  if (!iosPath) return { iosPath: null, projectFiles: [] };
  let entries;
  try {
    entries = await readdir(iosPath, { withFileTypes: true });
  } catch (error) {
    if (error instanceof UnsafeIosAppPathError) throw error;
    return { iosPath, projectFiles: [] };
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.xcodeproj'))
    .map((entry) => join(iosPath, entry.name, 'project.pbxproj'))
    .sort();
  const projectFiles: string[] = [];
  for (const projectFile of candidates) {
    signal?.throwIfAborted();
    try {
      const canonicalProjectFile = await resolveInsideAppRoot(
        appPath,
        projectFile,
      );
      if ((await stat(canonicalProjectFile)).isFile()) {
        await access(canonicalProjectFile, fsConstants.R_OK);
        projectFiles.push(canonicalProjectFile);
      }
    } catch (error) {
      if (error instanceof UnsafeIosAppPathError) throw error;
      // Ignore incomplete or unreadable Xcode projects.
    }
  }
  return { iosPath, projectFiles };
}

function parseXcodeApplicationBundleIds(json: string): string[] | null {
  let settings: unknown;
  try {
    settings = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(settings)) return null;

  const bundleIds = settings.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const buildSettings = (entry as Record<string, unknown>).buildSettings;
    if (!buildSettings || typeof buildSettings !== 'object') return [];
    const values = buildSettings as Record<string, unknown>;
    if (values.PRODUCT_TYPE !== 'com.apple.product-type.application') return [];
    const bundleId = normalizeBundleId(values.PRODUCT_BUNDLE_IDENTIFIER);
    return bundleId ? [bundleId] : [];
  });
  return [...new Set(bundleIds)];
}

function parseBuildSetting(block: string, name: string): string | null {
  const match = block.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|([^;\\n]+))\\s*;`),
  );
  return match ? (match[1] ?? match[2]).trim() : null;
}

function resolveProductNameVariable(value: string, productName: string | null) {
  if (!productName || /\$\(|\$\{/.test(productName)) return value;
  return value
    .replaceAll('$(PRODUCT_NAME)', productName)
    .replaceAll('${PRODUCT_NAME}', productName)
    .replaceAll(
      '$(PRODUCT_NAME:rfc1034identifier)',
      productName.replace(/[^A-Za-z0-9.-]+/g, '-'),
    );
}

async function readPbxFallbackBundleIds(
  appPath: string,
  projectFiles: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const bundleIds: string[] = [];
  for (const projectFile of projectFiles) {
    signal?.throwIfAborted();
    try {
      const project = await readTextFileInsideAppRoot(appPath, projectFile);
      const parsed = parsePbxApplicationBundleIds(project);
      if (parsed === null) return [];
      bundleIds.push(...parsed);
    } catch (error) {
      if (error instanceof UnsafeIosAppPathError) throw error;
      // Ignore incomplete Xcode projects and try the next project.
    }
  }
  return [...new Set(bundleIds)];
}

function readPbxObjectBlock(project: string, objectId: string): string | null {
  const startMatch = new RegExp(
    `(?:^|\\n)\\s*${objectId}(?:\\s*\\/\\*[^\n]*?\\*\\/)?\\s*=\\s*\\{`,
  ).exec(project);
  if (!startMatch) return null;
  const blockStart = startMatch.index + startMatch[0].lastIndexOf('{');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = blockStart; index < project.length; index += 1) {
    const char = project[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) {
      return project.slice(blockStart + 1, index);
    }
  }
  return null;
}

function parsePbxReference(block: string, name: string): string | null {
  return block.match(new RegExp(`\\b${name}\\s*=\\s*([A-Fa-f0-9]{24})\\b`))?.[1] ?? null;
}

function parsePbxReferenceList(block: string, name: string): string[] | null {
  const list = block.match(new RegExp(`\\b${name}\\s*=\\s*\\(([\\s\\S]*?)\\);`))?.[1];
  if (list === undefined) return null;
  return [...list.matchAll(/\b([A-Fa-f0-9]{24})\b/g)].map((match) => match[1]);
}

function parsePbxApplicationBundleIds(project: string): string[] | null {
  const targetIds = [
    ...project.matchAll(
      /(?:^|\n)\s*([A-Fa-f0-9]{24})(?:\s*\/\*[^\n]*?\*\/)?\s*=\s*\{/g,
    ),
  ].flatMap((match) => {
    const block = readPbxObjectBlock(project, match[1]);
    return block?.match(/\bisa\s*=\s*PBXNativeTarget\s*;/) &&
      parseBuildSetting(block, 'productType') ===
        'com.apple.product-type.application'
      ? [match[1]]
      : [];
  });
  const bundleIds: string[] = [];
  for (const targetId of targetIds) {
    const target = readPbxObjectBlock(project, targetId);
    const configurationListId = target
      ? parsePbxReference(target, 'buildConfigurationList')
      : null;
    const configurationList = configurationListId
      ? readPbxObjectBlock(project, configurationListId)
      : null;
    const configurationIds = configurationList
      ? parsePbxReferenceList(configurationList, 'buildConfigurations')
      : null;
    if (!configurationIds?.length) return null;
    for (const configurationId of configurationIds) {
      const configuration = readPbxObjectBlock(project, configurationId);
      if (!configuration?.match(/\bisa\s*=\s*XCBuildConfiguration\s*;/)) {
        return null;
      }
      const buildSettings = configuration.match(
        /\bbuildSettings\s*=\s*\{([\s\S]*?)\};/,
      )?.[1];
      const rawBundleId = buildSettings
        ? parseBuildSetting(buildSettings, 'PRODUCT_BUNDLE_IDENTIFIER')
        : null;
      if (!rawBundleId) return null;
      const bundleId = normalizeBundleId(
        resolveProductNameVariable(
          rawBundleId,
          parseBuildSetting(buildSettings!, 'PRODUCT_NAME'),
        ),
      );
      if (!bundleId) return null;
      bundleIds.push(bundleId);
    }
  }
  return [...new Set(bundleIds)];
}

async function readNativeBundleId(
  appPath: string,
  iosPath: string,
  projectFiles: string[],
  signal?: AbortSignal,
): Promise<string | null> {
  const resolvedBundleIds: string[] = [];
  let gotValidBuildSettings = false;
  for (const projectFile of projectFiles) {
    signal?.throwIfAborted();
    try {
      const canonicalProjectFile = await resolveInsideAppRoot(
        appPath,
        projectFile,
      );
      const projectDirectory = await resolveInsideAppRoot(
        appPath,
        dirname(canonicalProjectFile),
      );
      const canonicalIosPath = await resolveInsideAppRoot(appPath, iosPath);
      // xcodebuild accepts paths, not directory handles; canonicalize immediately
      // before spawn, leaving only an unavoidable local pathname race.
      const { stdout } = await runCommand(
        'xcrun',
        [
          'xcodebuild',
          '-project',
          projectDirectory,
          '-alltargets',
          '-showBuildSettings',
          '-json',
          '-disableAutomaticPackageResolution',
          '-skipPackageUpdates',
        ],
        { cwd: canonicalIosPath, timeoutMs: 15_000, signal },
      );
      const bundleIds = parseXcodeApplicationBundleIds(stdout);
      if (bundleIds) {
        gotValidBuildSettings = true;
        resolvedBundleIds.push(...bundleIds);
      }
    } catch (error) {
      if (error instanceof UnsafeIosAppPathError) throw error;
      if (signal?.aborted) throw error;
      // Fall back to static project parsing when Xcode cannot load the project.
    }
  }
  if (gotValidBuildSettings) {
    const uniqueBundleIds = [...new Set(resolvedBundleIds)];
    return uniqueBundleIds.length === 1 ? uniqueBundleIds[0] : null;
  }

  const fallbackBundleIds = await readPbxFallbackBundleIds(
    appPath,
    projectFiles,
    signal,
  );
  return fallbackBundleIds.length === 1 ? fallbackBundleIds[0] : null;
}

async function resolveIosApp({
  appPath,
  iosBundleId,
  packageManager,
  signal,
}: MobilePreviewIosAppStatusParams & { signal?: AbortSignal }): Promise<{
  bundleId: string | null;
  nativeProjectExists: boolean;
}> {
  const { iosPath, projectFiles } = await getNativeProjectFiles(appPath, signal);
  signal?.throwIfAborted();
  const nativeProjectExists = projectFiles.length > 0;
  const bundleId =
    (nativeProjectExists && iosPath
      ? await readNativeBundleId(appPath, iosPath, projectFiles, signal)
      : null) ??
    (await readExpoBundleId({ appPath, packageManager, signal })) ??
    normalizeBundleId(iosBundleId);
  return { bundleId, nativeProjectExists };
}

function validateSimctlInstalledApps(
  apps: unknown,
  errorMessage: string,
): Record<string, unknown> {
  if (
    !apps ||
    typeof apps !== 'object' ||
    Array.isArray(apps) ||
    Object.values(apps).some(
      (app) => !app || typeof app !== 'object' || Array.isArray(app),
    )
  ) {
    throw new Error(errorMessage);
  }
  return apps as Record<string, unknown>;
}

async function parseSimctlInstalledApps({
  deviceId,
  output,
  signal,
}: {
  deviceId: string;
  output: string;
  signal: AbortSignal;
}): Promise<Record<string, unknown>> {
  let apps: unknown;
  try {
    apps = JSON.parse(output);
  } catch {
    let convertedOutput: string;
    try {
      const converted = await runCommand(
        'plutil',
        ['-convert', 'json', '-o', '-', '--', '-'],
        { input: output, signal },
      );
      convertedOutput = converted.stdout;
    } catch (conversionError) {
      debug(
        'Invalid simctl listapps output deviceId=%s format=%s bytes=%d conversionError=%s',
        deviceId,
        'openstep-or-unknown',
        Buffer.byteLength(output),
        conversionError instanceof Error
          ? conversionError.name
          : typeof conversionError,
      );
      if (signal.aborted) throw conversionError;
      throw new Error(
        'Invalid simctl listapps output: plist conversion failed.',
        { cause: conversionError },
      );
    }

    try {
      apps = JSON.parse(convertedOutput);
      return validateSimctlInstalledApps(
        apps,
        'Invalid simctl listapps output after plist conversion.',
      );
    } catch (conversionError) {
      debug(
        'Invalid simctl listapps output deviceId=%s format=%s bytes=%d conversionError=%s',
        deviceId,
        'openstep-or-unknown',
        Buffer.byteLength(output),
        conversionError instanceof SyntaxError
          ? 'SyntaxError'
          : 'invalid-converted-shape',
      );
      throw new Error(
        'Invalid simctl listapps output after plist conversion.',
        { cause: conversionError },
      );
    }
  }

  try {
    return validateSimctlInstalledApps(
      apps,
      'Invalid simctl listapps JSON output.',
    );
  } catch (shapeError) {
    debug(
      'Invalid simctl listapps output deviceId=%s format=%s bytes=%d conversionError=%s',
      deviceId,
      'json',
      Buffer.byteLength(output),
      'not-attempted',
    );
    throw shapeError;
  }
}

function isAppNotRunningError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /found nothing to terminate/i.test(message) ||
    (/domain=NSPOSIXErrorDomain,\s*code=3\b/i.test(message) &&
      /No such process/i.test(message))
  );
}

function assertFiniteNumber(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid iOS input ${name}: expected a finite number.`);
  }
}

function assertTextInput(text: string): void {
  if (typeof text !== 'string') {
    throw new Error('Invalid iOS text input: expected text string.');
  }
}

function assertInputEvent(
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

function scaleInputEventToPoints(
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

function isTouchLifecycleEvent(
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

function createIosHidHelper(deviceId: string, scriptPath: string) {
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

async function getIosHidHelper(deviceId: string) {
  const active = activeHidHelpersByDeviceId.get(deviceId);
  if (active && !active.isClosed()) {
    await active.ready;
    return active;
  }

  const pending = pendingHidHelpersByDeviceId.get(deviceId);
  if (pending) return pending;

  const helperPromise = (async () => {
    const scriptPath = await findIosHidHelperSource();
    if (iosPreviewDisposed) {
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

function enqueueIosTouchInput(
  deviceId: string,
  operation: (isCurrent: () => boolean) => Promise<void>,
  sessionId?: string,
): Promise<void> {
  const generation = iosInputGeneration;
  const isCurrent = () =>
    generation === iosInputGeneration &&
    (!sessionId || activeIosSessionIds.has(sessionId));
  const previous = iosTouchInputQueues.get(deviceId) ?? Promise.resolve();
  const result = previous.then(() => {
    if (!isCurrent()) {
      if (generation === iosInputGeneration && sessionId) {
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

function retainIosHidHelper(deviceId: string): void {
  hidHelperReferenceCountsByDeviceId.set(
    deviceId,
    (hidHelperReferenceCountsByDeviceId.get(deviceId) ?? 0) + 1,
  );
}

async function releaseIosHidHelper(deviceId: string): Promise<void> {
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

async function sendIosHidLifecycleEvent(
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

async function sendIosHidKeyPress(
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

function prewarmIosHidInput(params: {
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

async function sendIdbUiInputEvent(
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

async function compensateIosTouch(
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
      () => allowDuringDisposal || !iosPreviewDisposed,
    );
  } catch {
    // Gesture release is best-effort during session cancellation.
  }
  if (released && activeIosTouchesByDeviceId.get(deviceId) === touch) {
    activeIosTouchesByDeviceId.delete(deviceId);
  }
  return released;
}

async function cancelIosSessionInput(sessionId: string): Promise<void> {
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

function enqueueIosKeyboardInput(
  operation: (isCurrent: () => boolean) => Promise<void>,
  sessionId?: string,
): Promise<void> {
  const generation = iosInputGeneration;
  const isCurrent = () =>
    generation === iosInputGeneration &&
    (!sessionId || activeIosSessionIds.has(sessionId));
  const result = iosKeyboardInputQueue.then(() => {
    if (!isCurrent()) return;
    return operation(isCurrent);
  });
  iosKeyboardInputQueue = result.catch(() => undefined);
  return result;
}

function ownIosStream<T extends {
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

async function showIosSoftwareKeyboard(signal?: AbortSignal): Promise<void> {
  await runCommand('osascript', ['-e', SHOW_IOS_KEYBOARD_SCRIPT], {
    signal,
    timeoutMs: SHOW_IOS_KEYBOARD_TIMEOUT_MS,
  });
}

async function pasteIosText(text: string, signal?: AbortSignal): Promise<void> {
  assertTextInput(text);
  if (!text) return;

  await runCommand('osascript', ['-e', PASTE_IOS_TEXT_SCRIPT, text], {
    signal,
    timeoutMs: PASTE_IOS_TEXT_TIMEOUT_MS,
  });
}

async function sendFallbackTouchLifecycleEvent(
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

function appendBoundedText(current: string, chunk: Buffer): string {
  const next = current + chunk.toString();
  if (next.length <= MAX_STREAM_STDERR_BYTES) return next;
  return next.slice(-MAX_STREAM_STDERR_BYTES);
}

function formatStreamExitError({
  code,
  signal,
  stderr,
}: {
  code: number | null;
  signal: string | null;
  stderr: string;
}): string {
  const stderrText = stderr.trim();
  const stderrSuffix = stderrText ? ` Stderr: ${stderrText}` : '';
  return `idb video stream exited unexpectedly (code ${code ?? 'unknown'}, signal ${signal ?? 'none'}).${stderrSuffix}`;
}

async function captureSimulatorScreenshot(
  deviceId: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const outputPath = join(
    tmpdir(),
    `jean-claude-ios-preview-${randomUUID()}.jpg`,
  );
  try {
    await runCommand(
      'xcrun',
      [
        'simctl',
        'io',
        deviceId,
        'screenshot',
        '--type=jpeg',
        outputPath,
      ],
      { timeoutMs: IOS_SCREENSHOT_TIMEOUT_MS, signal },
    );
    return await readFile(outputPath);
  } finally {
    await unlink(outputPath).catch(() => undefined);
  }
}

async function getSimulatorScreenshotSize(
  deviceId: string,
  signal?: AbortSignal,
): Promise<{ width: number; height: number }> {
  const screenshotPath = join(
    tmpdir(),
    `jean-claude-ios-preview-size-${randomUUID()}.png`,
  );
  try {
    await runCommand(
      'xcrun',
      [
        'simctl',
        'io',
        deviceId,
        'screenshot',
        '--type=png',
        screenshotPath,
      ],
      { timeoutMs: IOS_SCREENSHOT_TIMEOUT_MS, signal },
    );
    const png = await readFile(screenshotPath);
    if (png.length < 24 || png.toString('ascii', 12, 16) !== 'IHDR') {
      throw new Error('simctl screenshot did not produce a valid PNG.');
    }
    return {
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
    };
  } finally {
    await unlink(screenshotPath).catch(() => undefined);
  }
}

function getCoreSimulatorHelperSourceCandidates(): string[] {
  const candidates = [
    ...(process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE
      ? [process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE]
      : []),
    join(process.cwd(), 'electron', 'native', CORE_SIMULATOR_HELPER_SOURCE),
    join(__dirname, '..', 'native', CORE_SIMULATOR_HELPER_SOURCE),
  ];

  if (process.resourcesPath) {
    candidates.push(
      join(process.resourcesPath, 'native', CORE_SIMULATOR_HELPER_SOURCE),
    );
  }

  candidates.push(
    join(
      __dirname,
      '..',
      '..',
      'electron',
      'native',
      CORE_SIMULATOR_HELPER_SOURCE,
    ),
  );

  return candidates;
}

async function findCoreSimulatorHelperSource(): Promise<string> {
  if (process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE) {
    return process.env.JC_MOBILE_PREVIEW_IOS_HELPER_SOURCE;
  }

  for (const candidate of getCoreSimulatorHelperSourceCandidates()) {
    try {
      await access(candidate, fsConstants.R_OK);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  throw new Error('CoreSimulator framebuffer helper source not found.');
}

async function buildCoreSimulatorFramebufferHelper(
  signal: AbortSignal,
): Promise<string> {
  const sourcePath = await findCoreSimulatorHelperSource();
  signal.throwIfAborted();
  const developerDir = await getXcodeDeveloperDir(signal);
  signal.throwIfAborted();
  const outputDir = join(tmpdir(), 'jean-claude-mobile-preview');
  const outputPath = join(outputDir, CORE_SIMULATOR_HELPER_BINARY);
  await mkdir(outputDir, { recursive: true });
  await runCommand(
    'xcrun',
    [
      'clang',
      '-fobjc-arc',
      '-fblocks',
      '-framework',
      'Foundation',
      '-framework',
      'CoreGraphics',
      '-framework',
      'ImageIO',
      '-framework',
      'IOSurface',
      `-F${join(developerDir, 'Library', 'PrivateFrameworks')}`,
      '-F/Library/Developer/PrivateFrameworks',
      '-framework',
      'CoreSimulator',
      sourcePath,
      '-o',
      outputPath,
    ],
    { signal, timeoutMs: 20_000 },
  );
  return outputPath;
}

async function getXcodeDeveloperDir(signal?: AbortSignal): Promise<string> {
  if (process.env.DEVELOPER_DIR) {
    return process.env.DEVELOPER_DIR;
  }

  const { stdout } = await runCommand('xcode-select', ['-p'], {
    signal,
    timeoutMs: 5_000,
  });
  return stdout.trim();
}

function createScreenshotStream(
  params: {
    taskId: string;
    deviceId: string;
    fps?: number;
    quality?: MobilePreviewQuality;
    onFrame: (frame: Buffer) => void;
    onSession: (patch: Partial<MobilePreviewSession>) => void;
    signal?: AbortSignal;
  },
  screenshotSize: { width: number; height: number },
): { session: MobilePreviewSession; stop: () => Promise<void> } {
  debug(
    'iOS preview using simctl screenshot stream deviceId=%s width=%d height=%d',
    params.deviceId,
    screenshotSize.width,
    screenshotSize.height,
  );

  const session: MobilePreviewSession = {
    id: randomUUID(),
    taskId: params.taskId,
    platform: 'ios',
    deviceId: params.deviceId,
    status: 'streaming',
    width: screenshotSize.width,
    height: screenshotSize.height,
    frameFormat: 'mjpeg',
    streamStrategy: 'simctl-screenshot',
    inputStatus: 'starting',
    error: null,
  };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let currentRun: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let frameCount = 0;
  const pollIntervalMs = getScreenshotPollIntervalMs(params.fps);
  retainIosHidHelper(params.deviceId);

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      startScreenshotStreamRun();
    }, pollIntervalMs);
  };

  const startScreenshotStreamRun = () => {
    const run = runScreenshotStream();
    currentRun = run;
    void run.finally(() => {
      if (currentRun === run) currentRun = null;
    });
  };

  const runScreenshotStream = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const screenshot = await captureSimulatorScreenshot(
        params.deviceId,
        params.signal,
      );
      if (stopped) return;
      frameCount += 1;
      if (frameCount === 1 || frameCount % 10 === 0) {
        debug(
          'iOS preview simctl screenshot frame sessionId=%s frames=%d bytes=%d',
          session.id,
          frameCount,
          screenshot.length,
        );
      }
      params.onFrame(screenshot);
    } catch (error) {
      if (!stopped) {
        params.onSession({
          status: 'error',
          error: `simctl screenshot stream failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
      return;
    } finally {
      running = false;
    }
    scheduleNext();
  };

  const stop = () => {
    stopPromise ??= (async () => {
      try {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        await currentRun;
        await releaseIosHidHelper(params.deviceId);
      } finally {
        activeScreenshotStreamStops.delete(stop);
      }
    })();
    return stopPromise;
  };
  activeScreenshotStreamStops.add(stop);
  startScreenshotStreamRun();
  prewarmIosHidInput(params);

  return { session, stop };
}

async function createCoreSimulatorFramebufferStream(
  params: {
    taskId: string;
    deviceId: string;
    fps?: number;
    quality?: MobilePreviewQuality;
    onFrame: (frame: Buffer) => void;
    onSession: (patch: Partial<MobilePreviewSession>) => void;
    signal?: AbortSignal;
  },
  screenshotSize: { width: number; height: number } | null,
): Promise<{ session: MobilePreviewSession; stop: () => Promise<void> }> {
  params.signal?.throwIfAborted();
  const developerDir = await getXcodeDeveloperDir(params.signal);
  const fps = normalizePreviewFps(params.fps);
  const quality = params.quality ?? 'high';
  const poolKey = `${params.deviceId}:${fps}:${quality}:${developerDir}`;
  let entry = coreSimulatorPool.get(poolKey);
  if (entry?.closed) {
    coreSimulatorPool.delete(poolKey);
    entry = undefined;
  }
  const shouldResumeWarmEntry = !!entry && entry.consumers.size === 0;
  const session: MobilePreviewSession = {
    id: randomUUID(),
    taskId: params.taskId,
    platform: 'ios',
    deviceId: params.deviceId,
    status: 'streaming',
    width: screenshotSize?.width ?? null,
    height: screenshotSize?.height ?? null,
    frameFormat: 'mjpeg',
    streamStrategy: 'coresimulator-framebuffer',
    inputStatus: 'starting',
    error: null,
  };
  if (!entry) {
    let pendingBuild = pendingCoreSimulatorPoolEntries.get(poolKey);
    if (!pendingBuild) {
      const abortController = new AbortController();
      const promise = (async () => {
        const helperPath = await buildCoreSimulatorFramebufferHelper(
          abortController.signal,
        );
        if (iosPreviewDisposed) {
          throw new Error('iOS preview is shutting down.');
        }
        const stream = spawnManaged(
          helperPath,
          [
            params.deviceId,
            String(fps),
            IOS_CORE_SIMULATOR_JPEG_QUALITY[quality],
            developerDir,
          ],
          { signal: abortController.signal },
        );
        const createdEntry: CoreSimulatorPoolEntry = {
          key: poolKey,
          deviceId: params.deviceId,
          stream,
          parseFrames: createMjpegFrameParser((frame) => {
            for (const active of createdEntry.consumers.values()) {
              if (active.stopped || active.helperSettled) continue;
              try {
                active.params.onFrame(frame);
              } catch (error) {
                debug(
                  'iOS preview frame consumer failed taskId=%s deviceId=%s error=%s',
                  active.params.taskId,
                  active.params.deviceId,
                  error instanceof Error ? error.message : String(error),
                );
              }
              active.frameCount += 1;
              if (active.firstFrameTimer) {
                clearTimeout(active.firstFrameTimer);
                active.firstFrameTimer = null;
              }
              if (!active.didPrewarmInput) {
                active.didPrewarmInput = true;
                prewarmIosHidInput(active.params);
              }
            }
          }),
          consumers: new Map(),
          cleanupTimer: null,
          closed: false,
          recentStderr: '',
        };
        coreSimulatorPool.set(poolKey, createdEntry);
        stream.child.stdout.removeAllListeners('data');
        stream.child.stdout.on('data', (chunk: Buffer) => {
          createdEntry.parseFrames(chunk);
        });
        stream.child.stderr.on('data', (chunk: Buffer) => {
          createdEntry.recentStderr = appendBoundedText(
            createdEntry.recentStderr,
            chunk,
          );
        });
        stream.child.once('error', (error) => {
          const stderr = createdEntry.recentStderr.trim();
          for (const active of createdEntry.consumers.values()) {
            active.handleHelperFailure?.(
              `CoreSimulator framebuffer helper failed: ${error.message}.${stderr ? ` Stderr: ${stderr}` : ''} Falling back to simctl screenshots.`,
            );
          }
        });
        stream.child.once('close', (code, signal) => {
          createdEntry.closed = true;
          if (coreSimulatorPool.get(poolKey) === createdEntry) {
            coreSimulatorPool.delete(poolKey);
          }
          const stderr = createdEntry.recentStderr.trim();
          for (const active of createdEntry.consumers.values()) {
            active.handleHelperFailure?.(
              `CoreSimulator framebuffer helper exited (code ${code ?? 'unknown'}, signal ${signal ?? 'none'}).${stderr ? ` Stderr: ${stderr}` : ''} Falling back to simctl screenshots.`,
            );
          }
        });
        return createdEntry;
      })();
      pendingBuild = { abortController, promise, waiters: new Set() };
      pendingCoreSimulatorPoolEntries.set(poolKey, pendingBuild);
      const createdPendingBuild = pendingBuild;
      void promise
        .finally(() => {
          if (
            pendingCoreSimulatorPoolEntries.get(poolKey) === createdPendingBuild
          ) {
            pendingCoreSimulatorPoolEntries.delete(poolKey);
          }
        })
        .catch(() => undefined);
    }
    const waiter = Symbol('core-simulator-start-waiter');
    pendingBuild.waiters.add(waiter);
    try {
      entry = await waitForSignal(pendingBuild.promise, params.signal);
    } finally {
      pendingBuild.waiters.delete(waiter);
      if (params.signal?.aborted && pendingBuild.waiters.size === 0) {
        pendingBuild.abortController.abort(params.signal.reason);
      }
    }
    params.signal?.throwIfAborted();
  }

  if (entry.cleanupTimer) {
    clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = null;
  }
  if (shouldResumeWarmEntry) {
    entry.stream.child.kill('SIGUSR2');
  }
  let screenshotFallback: ReturnType<typeof createScreenshotStream> | null =
    null;
  let screenshotFallbackPromise: Promise<void> | null = null;
  let nativeStreamStopPromise: Promise<void> | null = null;
  retainIosHidHelper(params.deviceId);

  const active: CoreSimulatorActiveStream = {
    frameCount: 0,
    stopped: false,
    helperSettled: false,
    didPrewarmInput: false,
    firstFrameTimer: null,
    handleHelperFailure: null,
    stop: null,
    params,
  };
  entry.consumers.set(session.id, active);

  const switchToScreenshotFallback = (reason: string) => {
    if (active.stopped || active.helperSettled || screenshotFallback) return;
    active.helperSettled = true;
    if (active.firstFrameTimer) {
      clearTimeout(active.firstFrameTimer);
      active.firstFrameTimer = null;
    }
    entry!.consumers.delete(session.id);
    if (entry!.consumers.size === 0) {
      if (coreSimulatorPool.get(poolKey) === entry) {
        coreSimulatorPool.delete(poolKey);
      }
      if (!nativeStreamStopPromise) {
        nativeStreamStopPromise = entry!.stream.stop();
        void nativeStreamStopPromise.catch(() => undefined);
      }
    }
    screenshotFallbackPromise = (async () => {
      const fallbackSize =
        screenshotSize ??
        (await getSimulatorScreenshotSize(params.deviceId, params.signal));
      if (active.stopped || iosPreviewDisposed) return;
      screenshotFallback = createScreenshotStream(params, fallbackSize);
      params.onSession({
        status: 'streaming',
        width: fallbackSize.width,
        height: fallbackSize.height,
        frameFormat: 'mjpeg',
        streamStrategy: 'simctl-screenshot',
        error: reason,
      });
    })().catch((error) => {
      if (active.stopped || iosPreviewDisposed) return;
      params.onSession({
        status: 'error',
        error: `CoreSimulator framebuffer helper failed and screenshot fallback could not start: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    });
  };
  active.handleHelperFailure = switchToScreenshotFallback;

  active.firstFrameTimer = setTimeout(() => {
    if (active.stopped || active.frameCount > 0) return;
    switchToScreenshotFallback(
      `CoreSimulator framebuffer helper did not emit a frame within ${CORE_SIMULATOR_FIRST_FRAME_TIMEOUT_MS / 1000}s. Falling back to simctl screenshots.`,
    );
  }, CORE_SIMULATOR_FIRST_FRAME_TIMEOUT_MS);

  let stopPromise: Promise<void> | null = null;
  const stop = () => {
    stopPromise ??= (async () => {
      try {
        active.stopped = true;
        if (active.firstFrameTimer) {
          clearTimeout(active.firstFrameTimer);
          active.firstFrameTimer = null;
        }
        if (entry!.consumers.get(session.id) === active) {
          entry!.consumers.delete(session.id);
          if (
            entry!.consumers.size === 0 &&
            !entry!.closed &&
            !active.helperSettled
          ) {
            entry!.stream.child.kill('SIGUSR1');
            entry!.cleanupTimer = setTimeout(() => {
              if (coreSimulatorPool.get(poolKey) === entry) {
                coreSimulatorPool.delete(poolKey);
              }
              void entry!.stream.stop();
            }, CORE_SIMULATOR_POOL_TTL_MS);
          }
        }
        await Promise.all([
          nativeStreamStopPromise,
          screenshotFallbackPromise
            ?.catch(() => undefined)
            .then(() => screenshotFallback?.stop()),
          releaseIosHidHelper(params.deviceId),
        ]);
      } finally {
        activeCoreSimulatorStreamStops.delete(stop);
      }
    })();
    return stopPromise;
  };
  active.stop = stop;
  activeCoreSimulatorStreamStops.add(stop);

  return { session, stop };
}

async function getIdbScreenDimensions(
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

async function getInputScreenDimensions(
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

async function getRawStreamSize(
  deviceId: string,
  signal?: AbortSignal,
): Promise<RawStreamSize> {
  try {
    return await getIdbScreenDimensions(deviceId, signal);
  } catch (error) {
    signal?.throwIfAborted();
    debug(
      'iOS preview idb describe dimensions failed deviceId=%s error=%s',
      deviceId,
      error instanceof Error ? error.message : String(error),
    );
    return {
      ...(await getSimulatorScreenshotSize(deviceId, signal)),
      source: 'simctl-screenshot',
    };
  }
}

function createRawRgbaFrameParser({
  width,
  height,
  onFrame,
}: {
  width: number;
  height: number;
  onFrame: (frame: Buffer) => void;
}) {
  const frameBytes = width * height * 4;
  let pending = Buffer.alloc(0);

  return (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= frameBytes) {
      onFrame(Buffer.from(pending.subarray(0, frameBytes)));
      pending = pending.subarray(frameBytes);
    }
  };
}

async function getDevice(
  deviceId: string,
  signal: AbortSignal,
): Promise<MobilePreviewDevice | null> {
  const { stdout } = await runCommand(
    'xcrun',
    ['simctl', 'list', 'devices', '--json'],
    { signal },
  );
  return (
    parseSimctlDevices(stdout).find((device) => device.id === deviceId) ?? null
  );
}

async function ensureIosSimulatorBooted(
  deviceId: string,
  signal?: AbortSignal,
): Promise<MobilePreviewDevice> {
  if (iosPreviewDisposed) throw new Error('iOS preview is shutting down.');
  let entry = pendingIosSimulatorBootsByDeviceId.get(deviceId);
  if (entry?.abortController.signal.aborted) {
    if (pendingIosSimulatorBootsByDeviceId.get(deviceId) === entry) {
      pendingIosSimulatorBootsByDeviceId.delete(deviceId);
    }
    entry = undefined;
  }
  if (!entry) {
    const abortController = new AbortController();
    const promise = (async () => {
      const device = await getDevice(deviceId, abortController.signal);
      if (iosPreviewDisposed) throw new Error('iOS preview is shutting down.');
      if (!device) {
        throw new Error(`iOS simulator not found: ${deviceId}`);
      }
      if (device.state === 'booted') return device;
      if (device.state !== 'shutdown') {
        throw new Error(
          `iOS simulator ${deviceId} is not ready to stream (state: ${device.state}). Only booted or shutdown simulators are supported.`,
        );
      }

      debug('iOS preview booting simulator deviceId=%s', deviceId);
      await runCommand('xcrun', ['simctl', 'boot', deviceId], {
        signal: abortController.signal,
      });
      if (iosPreviewDisposed) throw new Error('iOS preview is shutting down.');
      await runCommand('xcrun', ['simctl', 'bootstatus', deviceId, '-b'], {
        signal: abortController.signal,
      });
      if (iosPreviewDisposed) throw new Error('iOS preview is shutting down.');
      void minimizeMobilePreviewWindows({
        processNames: IOS_SIMULATOR_PROCESS_NAMES,
        windowNameIncludes: [device.name],
      });
      debug('iOS preview simulator booted deviceId=%s', deviceId);
      return device;
    })();
    entry = { promise, abortController, waiters: new Set() };
    pendingIosSimulatorBootsByDeviceId.set(deviceId, entry);
    const createdEntry = entry;
    void promise
      .finally(() => {
        if (pendingIosSimulatorBootsByDeviceId.get(deviceId) === createdEntry) {
          pendingIosSimulatorBootsByDeviceId.delete(deviceId);
        }
      })
      .catch(() => {});
  }

  const waiter = Symbol('ios-simulator-boot-waiter');
  entry.waiters.add(waiter);
  return new Promise<MobilePreviewDevice>((resolveWaiter, rejectWaiter) => {
    let settled = false;
    const releaseWaiter = (cancelled: boolean, reason?: unknown) => {
      if (settled) return false;
      settled = true;
      signal?.removeEventListener('abort', cancelWaiter);
      entry.waiters.delete(waiter);
      if (cancelled && entry.waiters.size === 0) {
        entry.abortController.abort(reason);
      }
      return true;
    };
    const cancelWaiter = () => {
      const reason =
        signal?.reason ?? new DOMException('Operation cancelled', 'AbortError');
      if (releaseWaiter(true, reason)) rejectWaiter(reason);
    };
    entry.promise.then(
      (device) => {
        if (releaseWaiter(false)) resolveWaiter(device);
      },
      (error) => {
        if (releaseWaiter(false)) rejectWaiter(error);
      },
    );
    if (signal?.aborted) cancelWaiter();
    else signal?.addEventListener('abort', cancelWaiter, { once: true });
  });
}

export const iosIdbAdapter = {
  getIosAppStatus(
    params: MobilePreviewIosAppStatusParams & {
      trustedRoot: string;
      signal?: AbortSignal;
    },
  ): Promise<MobilePreviewIosAppStatus> {
    const abortController = new AbortController();
    const abortFromExternalSignal = () =>
      abortController.abort(params.signal?.reason);
    if (params.signal?.aborted) abortFromExternalSignal();
    else {
      params.signal?.addEventListener('abort', abortFromExternalSignal, {
        once: true,
      });
    }
    let entry: ActiveIosAppStatus;
    const startedAt = performance.now();
    const promise = (async () => {
      if (iosPreviewDisposed) throw new Error('iOS preview is shutting down.');
      debug(
        'iOS app status started deviceId=%s appPath=%s',
        params.deviceId,
        params.appPath,
      );
      assertSafeSimctlDeviceSelector('iOS simulator deviceId', params.deviceId);
      const appPath = await resolveTrustedIosAppRoot({
        trustedRoot: params.trustedRoot,
        appPath: params.appPath,
      });
      abortController.signal.throwIfAborted();
      const resolvedApp = await resolveIosApp({
        ...params,
        appPath,
        signal: abortController.signal,
      });
      abortController.signal.throwIfAborted();
      if (!resolvedApp.bundleId) {
        return {
          appInstalled: null,
          bundleId: null,
          nativeProjectExists: resolvedApp.nativeProjectExists,
        };
      }

      await ensureIosSimulatorBooted(params.deviceId, abortController.signal);
      abortController.signal.throwIfAborted();
      const { stdout } = await runCommand(
        'xcrun',
        ['simctl', 'listapps', params.deviceId, '--json'],
        { signal: abortController.signal },
      );
      const installedApps = await parseSimctlInstalledApps({
        deviceId: params.deviceId,
        output: stdout,
        signal: abortController.signal,
      });
      return {
        ...resolvedApp,
        appInstalled: Object.prototype.hasOwnProperty.call(
          installedApps,
          resolvedApp.bundleId,
        ),
      };
    })().finally(() => {
      debug(
        'iOS app status completed deviceId=%s elapsedMs=%d',
        params.deviceId,
        elapsedMs(startedAt),
      );
      activeIosAppStatuses.delete(entry);
      params.signal?.removeEventListener('abort', abortFromExternalSignal);
    });
    entry = { abortController, promise };
    activeIosAppStatuses.add(entry);
    return promise;
  },

  restartIosApp(
    params: MobilePreviewIosAppRestartParams & { trustedRoot: string },
  ): Promise<MobilePreviewIosAppRestartResult> {
    const abortController = new AbortController();
    let entry: ActiveIosAppRestart;
    const promise = (async () => {
      if (iosPreviewDisposed) throw new Error('iOS preview is shutting down.');
      assertSafeSimctlDeviceSelector('iOS simulator deviceId', params.deviceId);
      const appPath = await resolveTrustedIosAppRoot({
        trustedRoot: params.trustedRoot,
        appPath: params.appPath,
      });
      abortController.signal.throwIfAborted();
      const { bundleId } = await resolveIosApp({
        ...params,
        appPath,
        signal: abortController.signal,
      });
      abortController.signal.throwIfAborted();
      if (!bundleId) {
        throw new Error('Unable to detect iOS bundle identifier.');
      }

      try {
        await runCommand('xcrun', [
          'simctl',
          'terminate',
          params.deviceId,
          bundleId,
        ], { signal: abortController.signal });
      } catch (error) {
        if (abortController.signal.aborted || !isAppNotRunningError(error)) {
          throw error;
        }
      }
      abortController.signal.throwIfAborted();
      await runCommand('xcrun', [
        'simctl',
        'launch',
        params.deviceId,
        bundleId,
      ], { signal: abortController.signal });
      return { bundleId, restartedAt: new Date().toISOString() };
    })().finally(() => activeIosAppRestarts.delete(entry));
    entry = { abortController, promise };
    activeIosAppRestarts.add(entry);
    return promise;
  },

  async getIosToolStatus(): Promise<MobilePreviewIosToolStatus> {
    const xcrunPath = (await commandExists('xcrun'))
      ? await getCommandPath('xcrun')
      : null;

    return {
      xcrunPath,
      missingTools: xcrunPath ? [] : ['xcrun'],
    };
  },

  async listIosRuntimes(): Promise<MobilePreviewIosRuntime[]> {
    await assertXcrunAvailable();
    const { stdout } = await runCommand('xcrun', [
      'simctl',
      'list',
      'runtimes',
      '--json',
    ]);
    return parseSimctlRuntimes(stdout);
  },

  async listIosDeviceTypes(): Promise<MobilePreviewIosDeviceType[]> {
    await assertXcrunAvailable();
    const { stdout } = await runCommand('xcrun', [
      'simctl',
      'list',
      'devicetypes',
      '--json',
    ]);
    return parseSimctlDeviceTypes(stdout);
  },

  async createIosDevice(
    params: MobilePreviewIosCreateDeviceParams,
  ): Promise<string> {
    await assertXcrunAvailable();
    assertSafeSimctlValue('iOS simulator name', params.name);
    assertSafeSimctlValue('iOS simulator device type', params.deviceTypeId);
    assertSafeSimctlValue('iOS simulator runtime', params.runtimeId);
    const { stdout } = await runCommand('xcrun', [
      'simctl',
      'create',
      params.name,
      params.deviceTypeId,
      params.runtimeId,
    ]);
    const deviceId = stdout.trim();
    if (!deviceId) {
      throw new Error('xcrun simctl create did not return a device id.');
    }
    return deviceId;
  },

  async deleteIosDevice(deviceId: string): Promise<void> {
    await assertXcrunAvailable();
    assertSafeSimctlDeviceSelector('iOS simulator deviceId', deviceId);
    await runCommand('xcrun', ['simctl', 'delete', deviceId]);
  },

  async eraseIosDevice(deviceId: string): Promise<void> {
    await assertXcrunAvailable();
    assertSafeSimctlDeviceSelector('iOS simulator deviceId', deviceId);
    await runCommand('xcrun', ['simctl', 'erase', deviceId]);
  },

  async renameIosDevice(
    params: MobilePreviewIosRenameDeviceParams,
  ): Promise<void> {
    await assertXcrunAvailable();
    assertSafeSimctlDeviceSelector('iOS simulator deviceId', params.deviceId);
    assertSafeSimctlValue('iOS simulator name', params.name);
    await runCommand('xcrun', [
      'simctl',
      'rename',
      params.deviceId,
      params.name,
    ]);
  },

  async listDevices(): Promise<MobilePreviewDevice[]> {
    await assertXcrunAvailable();
    const { stdout } = await runCommand('xcrun', [
      'simctl',
      'list',
      'devices',
      '--json',
    ]);
    return parseSimctlDevices(stdout);
  },

  async startStream(params: {
    taskId: string;
    deviceId: string;
    fps?: number;
    quality?: MobilePreviewQuality;
    signal?: AbortSignal;
    onFrame: (frame: Buffer) => void;
    onSession: (patch: Partial<MobilePreviewSession>) => void;
  }): Promise<{ session: MobilePreviewSession; stop: () => Promise<void> }> {
    const startedAt = performance.now();
    debug(
      'iOS preview start requested taskId=%s deviceId=%s',
      params.taskId,
      params.deviceId,
    );
    params.signal?.throwIfAborted();
    await assertXcrunAvailable(params.signal);
    assertDeviceId(params.deviceId);
    if (iosPreviewDisposed) throw new Error('iOS preview is shutting down.');

    const device = await ensureIosSimulatorBooted(
      params.deviceId,
      params.signal,
    );
    params.signal?.throwIfAborted();
    if (iosPreviewDisposed) throw new Error('iOS preview is shutting down.');
    debug(
      'iOS preview device resolved deviceId=%s name=%s state=%s elapsedMs=%d',
      device.id,
      device.name,
      device.state,
      elapsedMs(startedAt),
    );

    if (process.env.JC_MOBILE_PREVIEW_IOS_RAW_STREAM !== '1') {
      if (process.env.JC_MOBILE_PREVIEW_IOS_CORE_SIMULATOR !== '0') {
        try {
          return ownIosStream(
            await createCoreSimulatorFramebufferStream(params, null),
          );
        } catch {
          params.signal?.throwIfAborted();
          // Fall back to simctl screenshots below.
        }
      }
      if (iosPreviewDisposed) throw new Error('iOS preview is shutting down.');

      debug(
        'iOS preview screenshot size probe starting deviceId=%s elapsedMs=%d',
        params.deviceId,
        elapsedMs(startedAt),
      );
      const screenshotSize = await getSimulatorScreenshotSize(
        params.deviceId,
        params.signal,
      );
      params.signal?.throwIfAborted();
      if (iosPreviewDisposed) throw new Error('iOS preview is shutting down.');
      debug(
        'iOS preview screenshot size probe completed deviceId=%s width=%d height=%d elapsedMs=%d',
        params.deviceId,
        screenshotSize.width,
        screenshotSize.height,
        elapsedMs(startedAt),
      );
      return ownIosStream(createScreenshotStream(params, screenshotSize));
    }

    await assertIdbAvailable(params.signal);

    const rawStreamSize = await getRawStreamSize(
      params.deviceId,
      params.signal,
    );
    params.signal?.throwIfAborted();
    debug(
      'iOS preview raw stream size probe deviceId=%s source=%s width=%d height=%d frameBytes=%d',
      params.deviceId,
      rawStreamSize.source,
      rawStreamSize.width,
      rawStreamSize.height,
      rawStreamSize.width * rawStreamSize.height * 4,
    );

    const session: MobilePreviewSession = {
      id: randomUUID(),
      taskId: params.taskId,
      platform: 'ios',
      deviceId: params.deviceId,
      status: 'streaming',
      width: rawStreamSize.width,
      height: rawStreamSize.height,
      frameFormat: 'raw-rgba',
      streamStrategy: 'idb-rbga-stream',
      inputStatus: 'starting',
      error: null,
    };

    const streamArgs = buildStartStreamArgs(params.deviceId, params.quality);
    debug('iOS preview spawning stream: idb %s', streamArgs.join(' '));
    const stream = spawnManaged('idb', streamArgs, { signal: params.signal });
    debug(
      'iOS preview stream spawned pid=%s sessionId=%s',
      stream.child.pid ?? '(unknown)',
      session.id,
    );
    let stopped = false;
    let terminalSettled = false;
    let recentStderr = '';
    let stdoutBytes = 0;
    let frameCount = 0;
    let idbChunkCount = 0;
    let fallbackFrameCount = 0;
    let firstFrameTimer: ReturnType<typeof setTimeout> | null = null;
    let screenshotFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let screenshotFallbackRunning = false;
    let usingScreenshotFallback = false;
    retainIosHidHelper(params.deviceId);
    prewarmIosHidInput(params);

    const emitTerminalError = (error: string) => {
      if (stopped || terminalSettled) return;
      terminalSettled = true;
      debug(
        'iOS preview terminal error sessionId=%s stdoutBytes=%d frames=%d fallbackFrames=%d error=%s stderr=%s',
        session.id,
        stdoutBytes,
        idbChunkCount,
        fallbackFrameCount,
        error,
        recentStderr.trim(),
      );
      if (firstFrameTimer) {
        clearTimeout(firstFrameTimer);
        firstFrameTimer = null;
      }
      if (screenshotFallbackTimer) {
        clearTimeout(screenshotFallbackTimer);
        screenshotFallbackTimer = null;
      }
      params.onSession({ status: 'error', error });
    };

    const scheduleScreenshotFallback = () => {
      if (stopped || terminalSettled) return;
      screenshotFallbackTimer = setTimeout(() => {
        void runScreenshotFallback();
      }, SCREENSHOT_POLL_INTERVAL_MS);
    };

    const runScreenshotFallback = async () => {
      if (stopped || terminalSettled || screenshotFallbackRunning) return;
      screenshotFallbackRunning = true;
      try {
        if (!usingScreenshotFallback) {
          usingScreenshotFallback = true;
          debug(
            'iOS preview switching to simctl screenshot fallback sessionId=%s stdoutBytes=%d stderr=%s',
            session.id,
            stdoutBytes,
            recentStderr.trim(),
          );
          params.onSession({
            frameFormat: 'mjpeg',
            streamStrategy: 'simctl-screenshot',
          });
        }
        const screenshot = await captureSimulatorScreenshot(
          params.deviceId,
          params.signal,
        );
        frameCount += 1;
        fallbackFrameCount += 1;
        if (fallbackFrameCount === 1 || fallbackFrameCount % 10 === 0) {
          debug(
            'iOS preview fallback screenshot frame sessionId=%s fallbackFrames=%d bytes=%d',
            session.id,
            fallbackFrameCount,
            screenshot.length,
          );
        }
        params.onFrame(screenshot);
        scheduleScreenshotFallback();
      } catch (error) {
        emitTerminalError(
          `idb video-stream did not emit frames and simctl screenshot fallback failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        screenshotFallbackRunning = false;
      }
    };

    const emitRawRgbaFrame = (frame: Buffer) => {
      frameCount += 1;
      idbChunkCount += 1;
      if (idbChunkCount === 1 || idbChunkCount % 30 === 0) {
        debug(
          'iOS preview idb raw RGBA frame sessionId=%s idbFrames=%d bytes=%d',
          session.id,
          idbChunkCount,
          frame.length,
        );
      }
      if (firstFrameTimer) {
        clearTimeout(firstFrameTimer);
        firstFrameTimer = null;
      }
      if (screenshotFallbackTimer) {
        clearTimeout(screenshotFallbackTimer);
        screenshotFallbackTimer = null;
      }
      if (usingScreenshotFallback) {
        usingScreenshotFallback = false;
        debug(
          'iOS preview idb stream recovered after fallback sessionId=%s stdoutBytes=%d idbFrames=%d fallbackFrames=%d',
          session.id,
          stdoutBytes,
          idbChunkCount,
          fallbackFrameCount,
        );
        params.onSession({
          frameFormat: 'raw-rgba',
          streamStrategy: 'idb-rbga-stream',
          error: null,
        });
      }
      params.onFrame(frame);
    };

    const parseRawRgbaFrames = createRawRgbaFrameParser({
      ...rawStreamSize,
      onFrame: emitRawRgbaFrame,
    });

    firstFrameTimer = setTimeout(() => {
      if (stopped || terminalSettled || frameCount > 0) return;
      const stderrText = recentStderr.trim();
      debug(
        'iOS preview first frame timeout sessionId=%s stdoutBytes=%d stderr=%s',
        session.id,
        stdoutBytes,
        stderrText,
      );
      params.onSession({
        error: `idb raw video-stream started but did not emit bytes within ${FIRST_FRAME_TIMEOUT_MS / 1000}s (stdout bytes: ${stdoutBytes}). Falling back to simctl screenshots.${
          stderrText ? ` Recent stderr: ${stderrText}` : ''
        }`,
      });
      void runScreenshotFallback();
    }, FIRST_FRAME_TIMEOUT_MS);

    stream.child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      debug(
        'iOS preview idb stdout chunk sessionId=%s chunkBytes=%d totalBytes=%d headHex=%s',
        session.id,
        chunk.length,
        stdoutBytes,
        describeChunk(chunk),
      );
      parseRawRgbaFrames(chunk);
    });
    stream.child.stdout.once('error', (error) => {
      debug(
        'iOS preview idb stdout error sessionId=%s error=%s',
        session.id,
        error.message,
      );
      emitTerminalError(`idb raw video stream stdout error: ${error.message}`);
    });
    stream.child.stderr.on('data', (chunk: Buffer) => {
      recentStderr = appendBoundedText(recentStderr, chunk);
      debug(
        'iOS preview idb stderr chunk sessionId=%s chunk=%s',
        session.id,
        chunk.toString().trim(),
      );
    });
    stream.child.once('error', (error) => {
      debug(
        'iOS preview idb process error sessionId=%s error=%s',
        session.id,
        error.message,
      );
      emitTerminalError(error.message);
    });
    stream.child.once('close', (code, signal) => {
      debug(
        'iOS preview idb process closed sessionId=%s code=%s signal=%s stdoutBytes=%d idbFrames=%d fallbackFrames=%d stderr=%s',
        session.id,
        code ?? 'null',
        signal ?? 'null',
        stdoutBytes,
        idbChunkCount,
        fallbackFrameCount,
        recentStderr.trim(),
      );
      emitTerminalError(
        formatStreamExitError({ code, signal, stderr: recentStderr }),
      );
    });

    return ownIosStream({
      session,
      stop: async () => {
        stopped = true;
        debug(
          'iOS preview stopping sessionId=%s stdoutBytes=%d idbFrames=%d fallbackFrames=%d',
          session.id,
          stdoutBytes,
          idbChunkCount,
          fallbackFrameCount,
        );
        if (firstFrameTimer) {
          clearTimeout(firstFrameTimer);
          firstFrameTimer = null;
        }
        if (screenshotFallbackTimer) {
          clearTimeout(screenshotFallbackTimer);
          screenshotFallbackTimer = null;
        }
        await Promise.all([
          stream.stop(),
          releaseIosHidHelper(params.deviceId),
        ]);
      },
    });
  },

  async sendInput(
    deviceId: string,
    event: MobilePreviewInputEvent,
    sessionId?: string,
  ): Promise<void> {
    if (iosPreviewDisposed) {
      throw new Error('iOS preview is shutting down.');
    }

    if (event.type === 'showKeyboard') {
      await runIosNonTouchInput(sessionId, (signal) =>
        enqueueIosKeyboardInput(
          () => showIosSoftwareKeyboard(signal),
          sessionId,
        ),
      );
      return;
    }

    if (event.type === 'text') {
      await runIosNonTouchInput(sessionId, (signal) =>
        enqueueIosKeyboardInput(
          () => pasteIosText(event.text, signal),
          sessionId,
        ),
      );
      return;
    }

    if (event.type === 'key' && event.key === 'backspace') {
      await runIosNonTouchInput(sessionId, () =>
        enqueueIosKeyboardInput(async (isCurrent) => {
          await assertIdbAvailable();
          if (!isCurrent()) return;
          await sendIosHidKeyPress(
            deviceId,
            IOS_HID_BACKSPACE_KEYCODE,
            isCurrent,
          );
        }, sessionId),
      );
      return;
    }

    if (event.type === 'key' && event.key === 'enter') {
      await runIosNonTouchInput(sessionId, (signal) =>
        enqueueIosKeyboardInput(async (isCurrent) => {
          await assertIdbAvailable();
          if (!isCurrent()) return;
          await sendIdbUiInputEvent(deviceId, event, isCurrent, signal);
        }, sessionId),
      );
      return;
    }

    if (isTouchLifecycleEvent(event)) {
      await enqueueIosTouchInput(deviceId, async (isCurrent) => {
        await assertIdbAvailable();
        if (!isCurrent()) return;
        const activeTouch = activeIosTouchesByDeviceId.get(deviceId);
        const fallbackTouch = fallbackTouchesByDeviceId.get(deviceId);
        if (event.type === 'touchDown') {
          if (activeTouch && activeTouch.sessionId !== sessionId) {
            const released = await compensateIosTouch(
              deviceId,
              activeTouch.sessionId,
            );
            if (!released || !isCurrent()) return;
          }
          if (fallbackTouch && fallbackTouch.sessionId !== sessionId) {
            await compensateIosTouch(deviceId, fallbackTouch.sessionId);
            if (!isCurrent()) return;
          }
        } else if (activeTouch) {
          if (activeTouch.sessionId !== sessionId) return;
        } else if (fallbackTouch?.sessionId === sessionId) {
          await sendFallbackTouchLifecycleEvent(
            deviceId,
            event,
            sessionId,
            isCurrent,
          );
          return;
        } else {
          return;
        }
        const previousTouch = activeIosTouchesByDeviceId.get(deviceId);
        let provisionalTouch:
          | { sessionId?: string; x: number; y: number }
          | undefined;
        const rollbackProvisionalTouch = () => {
          if (
            provisionalTouch &&
            activeIosTouchesByDeviceId.get(deviceId) === provisionalTouch
          ) {
            if (previousTouch) {
              activeIosTouchesByDeviceId.set(deviceId, previousTouch);
            } else {
              activeIosTouchesByDeviceId.delete(deviceId);
            }
          }
        };
        try {
          const sent = await sendIosHidLifecycleEvent(
            deviceId,
            event,
            isCurrent,
            event.type === 'touchDown'
              ? () => {
                  provisionalTouch = {
                    sessionId,
                    x: event.x,
                    y: event.y,
                  };
                  activeIosTouchesByDeviceId.set(deviceId, provisionalTouch);
                }
              : undefined,
          );
          if (!sent) {
            rollbackProvisionalTouch();
            return;
          }
          if (event.type === 'touchDown') {
            // Provisional ownership becomes final after successful write.
          } else if (event.type === 'touchMove') {
            const touch = activeIosTouchesByDeviceId.get(deviceId);
            if (touch && touch.sessionId === sessionId) {
              touch.x = event.x;
              touch.y = event.y;
            }
          } else if (
            activeIosTouchesByDeviceId.get(deviceId)?.sessionId === sessionId
          ) {
            activeIosTouchesByDeviceId.delete(deviceId);
          }
        } catch (error) {
          rollbackProvisionalTouch();
          if (!isCurrent()) return;
          debug(
            'iOS HID helper input failed; falling back to idb gesture synthesis deviceId=%s event=%s error=%s',
            deviceId,
            event.type,
            error instanceof Error ? error.message : String(error),
          );
          await sendFallbackTouchLifecycleEvent(
            deviceId,
            event,
            sessionId,
            isCurrent,
          );
        }
      }, sessionId);
      return;
    }

    const inputGeneration = iosInputGeneration;
    const isCurrent = () =>
      !iosPreviewDisposed &&
      inputGeneration === iosInputGeneration &&
      (!sessionId || activeIosSessionIds.has(sessionId));
    await runIosNonTouchInput(sessionId, async (signal) => {
      await assertIdbAvailable();
      if (!isCurrent()) return;
      await sendIdbUiInputEvent(deviceId, event, isCurrent, signal);
    });
  },

  dispose: disposeIosPreviewResources,

  async openDeeplink(
    deviceId: string,
    url: string,
    externalSignal?: AbortSignal,
  ): Promise<void> {
    const timeoutSignal = AbortSignal.timeout(
      MOBILE_PREVIEW_DEEPLINK_OPEN_TIMEOUT_MS,
    );
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, timeoutSignal])
      : timeoutSignal;
    signal.throwIfAborted();
    await assertXcrunAvailable(signal);
    assertDeviceId(deviceId);
    assertDeeplinkUrl(url);
    try {
      await runCommand('xcrun', ['simctl', 'openurl', deviceId, url], {
        signal,
        timeoutMs: MOBILE_PREVIEW_DEEPLINK_OPEN_TIMEOUT_MS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('LSApplicationWorkspaceErrorDomain')) {
        const scheme = url.split(':')[0];
        throw new Error(
          `Simulator has no app registered for "${scheme}://". Install the dev client (or Expo Go) on this simulator, then retry.`,
        );
      }
      throw error;
    }
  },

  async setTextSize(
    deviceId: string,
    size: MobilePreviewTextSize,
  ): Promise<void> {
    await assertXcrunAvailable();
    assertDeviceId(deviceId);
    await runCommand('xcrun', [
      'simctl',
      'ui',
      deviceId,
      'content_size',
      IOS_CONTENT_SIZE[size],
    ]);
  },

  async setColorScheme(
    deviceId: string,
    scheme: MobileColorScheme,
  ): Promise<void> {
    await assertXcrunAvailable();
    await runCommand('xcrun', ['simctl', 'ui', deviceId, 'appearance', scheme]);
  },

  async rotate(
    _deviceId: string,
    _direction: MobileRotationDirection,
  ): Promise<void> {
    // iOS preview rotation is applied in the renderer. simctl has no scoped
    // rotate command, and Simulator menu automation can target the wrong window.
  },
};
