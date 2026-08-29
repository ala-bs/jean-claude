import {
  access,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import { AdbScrcpyClient, AdbScrcpyOptions2_3 } from '@yume-chan/adb-scrcpy';
import { AdbServerClient } from '@yume-chan/adb';
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp';
import { DefaultServerPath } from '@yume-chan/scrcpy';
import { ReadableStream } from '@yume-chan/stream-extra';
import { BIN as SCRCPY_SERVER_BIN } from '@yume-chan/fetch-scrcpy-server';

import type {
  MobileColorScheme,
  MobilePreviewAndroidCreateDeviceParams,
  MobilePreviewAndroidDeviceProfile,
  MobilePreviewAndroidInstallSystemImageParams,
  MobilePreviewAndroidSystemImage,
  MobilePreviewAndroidToolStatus,
  MobilePreviewDevice,
  MobilePreviewInputEvent,
  MobilePreviewQuality,
  MobilePreviewSession,
  MobilePreviewTextSize,
  MobileRotationDirection,
} from '../../shared/mobile-simulator-types';

import {
  ANDROID_EMULATOR_PROCESS_NAMES,
  minimizeMobilePreviewWindows,
} from './mobile-preview-window-utils';
import {
  commandExists,
  MOBILE_PREVIEW_DEEPLINK_OPEN_TIMEOUT_MS,
  runBinaryCommand,
  runCommand,
  spawnManaged,
} from './mobile-preview-process';

type AndroidScrcpyStarter = (params: {
  adbSerial: string;
  signal?: AbortSignal;
  fps?: number;
  quality?: MobilePreviewQuality;
  onFrame: (frame: MobilePreviewFramePayload) => void;
  onSize: (size: { width: number; height: number }) => void;
  onError: (error: Error) => void;
}) => Promise<{ stop: () => Promise<void> }>;

type MobilePreviewFramePayload =
  | Buffer
  | {
      data: Buffer;
      h264PacketType: 'configuration' | 'data';
      keyframe?: boolean;
    };

const DEVICE_LINE_STATES = new Set(['device', 'offline', 'unauthorized']);
const MAX_ANDROID_COORDINATE = 100_000;
const MAX_ANDROID_DURATION_MS = 60_000;
const ANDROID_EMULATOR_BOOT_TIMEOUT_MS = 90_000;
const ANDROID_PREVIEW_READY_TIMEOUT_MS = 30_000;
const ANDROID_EMULATOR_POLL_INTERVAL_MS = 1_000;
const ANDROID_SCREENSHOT_POLL_INTERVAL_MS = 250;
const ANDROID_SCREENSHOT_TIMEOUT_MS = 5_000;
const ANDROID_SDK_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const ANDROID_PREVIEW_QUALITY: Record<
  MobilePreviewQuality,
  { bitRate: number; maxSize: number }
> = {
  low: { bitRate: 2_000_000, maxSize: 480 },
  balanced: { bitRate: 8_000_000, maxSize: 720 },
  high: { bitRate: 16_000_000, maxSize: 1080 },
  'very-high': { bitRate: 24_000_000, maxSize: 1440 },
};
const ANDROID_SCRCPY_START_TIMEOUT_MS = 5_000;
const ADB_SERVER_HOST = '127.0.0.1';
const ADB_SERVER_PORT = 5037;
const REMOTE_SHELL_TEXT_META_CHARS = new Set([
  ' ',
  ';',
  '&',
  '|',
  '$',
  '`',
  '"',
  "'",
  '(',
  ')',
  '<',
  '>',
  '\\',
  // Glob characters: the device-side shell expands these before `input text`
  // sees them, so an unescaped `*` is replaced by matching filenames.
  '*',
  '?',
  '[',
  ']',
  '~',
  '#',
  '!',
]);
const ANDROID_FONT_SCALE: Record<MobilePreviewTextSize, string> = {
  small: '0.85',
  normal: '1.0',
  large: '1.15',
  'x-large': '1.3',
};
const ANDROID_DEVICE_PROFILE_SCREEN_FALLBACKS: Record<
  string,
  { width: number; height: number; densityDpi: number }
> = {
  pixel_8: { width: 1080, height: 2400, densityDpi: 420 },
  pixel_8_pro: { width: 1344, height: 2992, densityDpi: 560 },
  pixel_7: { width: 1080, height: 2400, densityDpi: 420 },
  pixel_7_pro: { width: 1440, height: 3120, densityDpi: 560 },
  pixel_tablet: { width: 1600, height: 2560, densityDpi: 320 },
  medium_phone: { width: 1080, height: 2400, densityDpi: 420 },
  small_phone: { width: 720, height: 1280, densityDpi: 320 },
};

function formatAndroidScrcpyFallbackError(error: Error): string {
  return `scrcpy unavailable: ${error.message}`;
}

function formatAndroidScreenrecordFallbackError(error: Error): string {
  return `adb screenrecord unavailable: ${error.message}`;
}

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

function assertPort(port: number, label: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be between 1 and 65535`);
  }
}

async function assertAdbInstalled(signal?: AbortSignal): Promise<void> {
  await getAdbCommand(signal);
}

function createBufferReadableStream(buffer: Buffer) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(buffer);
      controller.close();
    },
  });
}

async function drainTextStream(stream: ReadableStream<string>): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

async function startAndroidScrcpyStream({
  adbSerial,
  signal,
  fps,
  quality = 'high',
  onFrame,
  onSize,
  onError,
}: Parameters<AndroidScrcpyStarter>[0]): Promise<{
  stop: () => Promise<void>;
}> {
  signal?.throwIfAborted();
  const connector = new AdbServerNodeTcpConnector({
    host: ADB_SERVER_HOST,
    port: ADB_SERVER_PORT,
  });
  const adbServer = new AdbServerClient(connector);
  const adb = await adbServer.createAdb({ serial: adbSerial });
  let client: Awaited<ReturnType<typeof AdbScrcpyClient.start>> | null = null;
  let stopped = false;
  const previewQuality = ANDROID_PREVIEW_QUALITY[quality];

  try {
    const server = await readFile(SCRCPY_SERVER_BIN);
    signal?.throwIfAborted();
    await AdbScrcpyClient.pushServer(
      adb,
      createBufferReadableStream(server),
      DefaultServerPath,
    );

    client = await AdbScrcpyClient.start(
      adb,
      DefaultServerPath,
      new AdbScrcpyOptions2_3({
        audio: false,
        clipboardAutosync: false,
        control: false,
        maxFps: fps ?? 0,
        maxSize: previewQuality.maxSize,
        video: true,
        videoBitRate: previewQuality.bitRate,
        videoCodec: 'h264',
      }),
    );
    signal?.throwIfAborted();

    void drainTextStream(client.output).catch(() => undefined);

    const videoStream = await withTimeout({
      promise: client.videoStream,
      timeoutMs: ANDROID_SCRCPY_START_TIMEOUT_MS,
      message: 'Timed out waiting for Android scrcpy video stream.',
      signal,
    });
    onSize({ width: videoStream.width, height: videoStream.height });
    const disposeSizeChanged = videoStream.sizeChanged((size) => {
      onSize(size);
    });
    const reader = videoStream.stream.getReader();

    const readFrame = async () => {
      const result = await reader.read();
      if (result.done) {
        throw new Error(
          'Android scrcpy video stream ended before first frame.',
        );
      }
      onFrame({
        data: Buffer.from(result.value.data),
        h264PacketType: result.value.type,
        keyframe:
          result.value.type === 'data' ? result.value.keyframe : undefined,
      });
    };

    await withTimeout({
      promise: readFrame(),
      timeoutMs: ANDROID_SCRCPY_START_TIMEOUT_MS,
      message: 'Timed out waiting for first Android scrcpy frame.',
      signal,
    });

    void (async () => {
      try {
        while (!stopped) {
          await readFrame();
        }
      } catch (error) {
        if (!stopped) onError(toError(error));
      }
    })();

    return {
      stop: async () => {
        stopped = true;
        disposeSizeChanged();
        await reader.cancel().catch(() => undefined);
        await client?.close().catch(() => undefined);
        await adb.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await client?.close().catch(() => undefined);
    await adb.close().catch(() => undefined);
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function sdkRootHasCommandLineTool(sdkRoot: string): Promise<boolean> {
  if (await fileExists(join(sdkRoot, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'))) {
    return true;
  }

  try {
    const entries = await readdir(join(sdkRoot, 'cmdline-tools'), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'latest') continue;
      if (
        await fileExists(
          join(sdkRoot, 'cmdline-tools', entry.name, 'bin', 'sdkmanager'),
        )
      ) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}

async function getEmulatorCommand(signal?: AbortSignal): Promise<string | null> {
  return getAndroidSdkToolCommand('emulator', signal);
}

async function getSdkRoot(): Promise<string | null> {
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), 'Library', 'Android', 'sdk'),
  ].filter((value): value is string => !!value);

  for (const sdkRoot of sdkRoots) {
    if (await fileExists(join(sdkRoot, 'platform-tools', 'adb'))) return sdkRoot;
    if (await fileExists(join(sdkRoot, 'emulator', 'emulator'))) return sdkRoot;
    if (await sdkRootHasCommandLineTool(sdkRoot)) return sdkRoot;
  }

  return null;
}

function getAndroidSdkEnv(sdkRoot: string | null): NodeJS.ProcessEnv | undefined {
  if (!sdkRoot) return undefined;
  return {
    ...process.env,
    ANDROID_HOME: sdkRoot,
    ANDROID_SDK_ROOT: sdkRoot,
  };
}

async function getAndroidSdkToolCommand(
  tool: 'adb' | 'emulator' | 'avdmanager' | 'sdkmanager',
  signal?: AbortSignal,
): Promise<string | null> {
  const sdkRoot = await getSdkRoot();
  if (sdkRoot && (tool === 'avdmanager' || tool === 'sdkmanager')) {
    const commandLineToolPath = await getAndroidCommandLineToolPath(
      sdkRoot,
      tool,
    );
    if (commandLineToolPath) return commandLineToolPath;
  }

  const exists = signal
    ? await commandExists(tool, { signal })
    : await commandExists(tool);
  if (exists) return tool;

  if (!sdkRoot) return null;

  const relativePath =
    tool === 'adb'
      ? ['platform-tools', 'adb']
      : tool === 'emulator'
        ? ['emulator', 'emulator']
        : ['cmdline-tools', 'latest', 'bin', tool];
  const toolPath = join(sdkRoot, ...relativePath);
  if (await fileExists(toolPath)) return toolPath;

  if (tool === 'avdmanager' || tool === 'sdkmanager') {
    const homebrewToolPaths = [
      join(
        '/opt/homebrew/share/android-commandlinetools/cmdline-tools/latest/bin',
        tool,
      ),
      join('/opt/homebrew/share/android-commandlinetools/cmdline-tools/bin', tool),
      join(
        '/usr/local/share/android-commandlinetools/cmdline-tools/latest/bin',
        tool,
      ),
      join('/usr/local/share/android-commandlinetools/cmdline-tools/bin', tool),
      join('/opt/homebrew/share/android-sdk/cmdline-tools/latest/bin', tool),
      join('/opt/homebrew/share/android-sdk/cmdline-tools/bin', tool),
      join('/usr/local/share/android-sdk/cmdline-tools/latest/bin', tool),
      join('/usr/local/share/android-sdk/cmdline-tools/bin', tool),
    ];
    for (const homebrewToolPath of homebrewToolPaths) {
      if (await fileExists(homebrewToolPath)) return homebrewToolPath;
    }
  }

  return null;
}

async function getAndroidCommandLineToolPath(
  sdkRoot: string,
  tool: 'avdmanager' | 'sdkmanager',
): Promise<string | null> {
  const latestToolPath = join(sdkRoot, 'cmdline-tools', 'latest', 'bin', tool);
  if (await fileExists(latestToolPath)) return latestToolPath;

  try {
    const entries = await readdir(join(sdkRoot, 'cmdline-tools'), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'latest') continue;
      const versionedToolPath = join(
        sdkRoot,
        'cmdline-tools',
        entry.name,
        'bin',
        tool,
      );
      if (await fileExists(versionedToolPath)) return versionedToolPath;
    }
  } catch {
    return null;
  }

  return null;
}

async function getAdbCommand(signal?: AbortSignal): Promise<string> {
  const adb = await getAndroidSdkToolCommand('adb', signal);
  if (adb) return adb;

  throw new Error(
    'Missing required Android preview tool: adb. Install Android Platform Tools with `brew install --cask android-platform-tools` or install Android Studio SDK Platform-Tools, ensure `adb` is on PATH, then restart Jean-Claude.',
  );
}

async function runAdbCommand(
  args: string[],
  options?: Parameters<typeof runCommand>[2],
) {
  const adb = await getAdbCommand(options?.signal);
  return options ? runCommand(adb, args, options) : runCommand(adb, args);
}

async function runAdbBinaryCommand(
  args: string[],
  options?: Parameters<typeof runBinaryCommand>[2],
) {
  return runBinaryCommand(await getAdbCommand(options?.signal), args, options);
}

function assertDeviceId(deviceId: string): void {
  if (!deviceId.trim()) {
    throw new Error('Android deviceId is required.');
  }
}

function assertAndroidAvdName(name: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error(
      'Android device name can only contain letters, numbers, underscore, dot, and dash.',
    );
  }
}

function getMissingAndroidToolError(tool: string): Error {
  return new Error(
    `Missing Android SDK tool: ${tool}. Install Android SDK Command-line Tools.`,
  );
}

function assertAndroidInteger(
  name: string,
  value: number,
  maxValue: number,
): void {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid Android input ${name}: expected a finite number.`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`Invalid Android input ${name}: expected an integer.`);
  }
  if (value < 0) {
    throw new Error(
      `Invalid Android input ${name}: expected a non-negative integer.`,
    );
  }
  if (value > maxValue) {
    throw new Error(
      `Invalid Android input ${name}: expected a value no greater than ${maxValue}.`,
    );
  }
}

function assertAndroidIntegerRange(
  name: string,
  value: number | undefined,
  minValue: number,
  maxValue: number,
): void {
  if (value === undefined) return;
  assertAndroidInteger(name, value, maxValue);
  if (value < minValue) {
    throw new Error(
      `Invalid Android input ${name}: expected a value no less than ${minValue}.`,
    );
  }
}

function assertAndroidAvdAdvancedSettings(
  values: Pick<
    MobilePreviewAndroidCreateDeviceParams,
    'ramMb' | 'vmHeapMb' | 'storageMb'
  >,
): void {
  assertAndroidIntegerRange('ramMb', values.ramMb, 512, 32_768);
  assertAndroidIntegerRange('vmHeapMb', values.vmHeapMb, 64, 4_096);
  assertAndroidIntegerRange('storageMb', values.storageMb, 1_024, 131_072);
}

function hasAndroidAvdAdvancedSettings(
  values: Pick<
    MobilePreviewAndroidCreateDeviceParams,
    'ramMb' | 'vmHeapMb' | 'storageMb' | 'hwKeyboard'
  >,
): boolean {
  return (
    values.ramMb !== undefined ||
    values.vmHeapMb !== undefined ||
    values.storageMb !== undefined ||
    values.hwKeyboard !== undefined
  );
}

async function writeAndroidAvdAdvancedConfig(
  name: string,
  values: MobilePreviewAndroidCreateDeviceParams,
): Promise<void> {
  const avdHome =
    process.env.ANDROID_AVD_HOME ??
    (process.env.ANDROID_USER_HOME
      ? join(process.env.ANDROID_USER_HOME, 'avd')
      : undefined) ??
    (process.env.ANDROID_SDK_HOME
      ? join(process.env.ANDROID_SDK_HOME, '.android', 'avd')
      : join(homedir(), '.android', 'avd'));
  const configPath = join(avdHome, `${name}.avd`, 'config.ini');
  const tempPath = join(avdHome, `${name}.avd`, `config.ini.${randomUUID()}.tmp`);
  const config = await readFile(configPath, 'utf8');
  const mergedConfig = mergeAndroidAvdConfig(config, values);

  try {
    await writeFile(tempPath, mergedConfig);
    await rename(tempPath, configPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function assertTextInput(text: string): void {
  if (typeof text !== 'string') {
    throw new Error('Invalid Android text input: expected text string.');
  }
  if (text.includes('%')) {
    throw new Error(
      'Unsupported Android text input: percent characters are not supported because adb shell input text treats %s specially.',
    );
  }
  // `adb shell` joins its argv into one string that the device-side shell
  // parses, so a raw newline terminates `input text` and starts a new command.
  // Backslash-escaping does not help: `\<newline>` is a line continuation and
  // would silently drop the break. Callers must split lines and send
  // KEYCODE_ENTER between them instead.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(
      'Unsupported Android text input: control characters (including newlines and tabs) must be sent as separate key events.',
    );
  }
}

function assertInputEvent(
  event: unknown,
): asserts event is MobilePreviewInputEvent {
  if (!event || typeof event !== 'object' || !('type' in event)) {
    throw new Error(
      'Invalid Android input event: expected event object with type.',
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
    throw new Error(`Unsupported Android input event type: ${String(type)}.`);
  }
}

function parseDeviceName(id: string, details: string[]): string {
  const model = details
    .find((detail) => detail.startsWith('model:'))
    ?.slice('model:'.length);
  if (model) return model.replaceAll('_', ' ');

  const product = details
    .find((detail) => detail.startsWith('product:'))
    ?.slice('product:'.length);
  if (product) return product.replaceAll('_', ' ');

  return id;
}

function mapDeviceState(state: string): MobilePreviewDevice['state'] {
  return state === 'device' ? 'booted' : 'unknown';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function withTimeout<T>({
  promise,
  timeoutMs,
  message,
  signal,
}: {
  promise: Promise<T>;
  timeoutMs: number;
  message: string;
  signal?: AbortSignal;
}): Promise<T> {
  signal?.throwIfAborted();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  let rejectAbort: ((reason?: unknown) => void) | null = null;
  const onAbort = () => rejectAbort?.(signal?.reason);
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  return Promise.race([promise, timeoutPromise, abortPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  });
}

export function mergeAndroidAvdConfig(
  currentConfig: string,
  values: Pick<
    MobilePreviewAndroidCreateDeviceParams,
    'ramMb' | 'vmHeapMb' | 'storageMb' | 'hwKeyboard'
  >,
): string {
  const managedValues = new Map<string, string>();
  if (values.ramMb !== undefined) {
    managedValues.set('hw.ramSize', String(values.ramMb));
  }
  if (values.vmHeapMb !== undefined) {
    managedValues.set('vm.heapSize', String(values.vmHeapMb));
  }
  if (values.storageMb !== undefined) {
    managedValues.set('disk.dataPartition.size', `${values.storageMb}M`);
  }
  if (values.hwKeyboard !== undefined) {
    managedValues.set('hw.keyboard', values.hwKeyboard ? 'yes' : 'no');
  }

  const replacedKeys = new Set<string>();
  const lines = currentConfig.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();

  const mergedLines = lines.flatMap((line) => {
    const key = line.match(/^([^=]+)=/)?.[1];
    if (!key || !managedValues.has(key)) return [line];
    if (replacedKeys.has(key)) return [];
    replacedKeys.add(key);
    return [`${key}=${managedValues.get(key)}`];
  });

  for (const [key, value] of managedValues) {
    if (!replacedKeys.has(key)) {
      mergedLines.push(`${key}=${value}`);
    }
  }

  return `${mergedLines.join('\n')}\n`;
}

export function parseAvdList(output: string): MobilePreviewDevice[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => ({
      id: name,
      name: name.replaceAll('_', ' '),
      platform: 'android' as const,
      state: 'shutdown' as const,
    }));
}

export function parseAndroidDeviceProfiles(
  output: string,
): MobilePreviewAndroidDeviceProfile[] {
  return output.split(/-{5,}/).flatMap((entry) => {
    const id = entry.match(/id:\s*\d+\s+or\s+"([^"]+)"/)?.[1];
    const name = entry.match(/Name:\s*(.+)/)?.[1]?.trim();
    const manufacturer = entry.match(/OEM\s*:\s*(.+)/)?.[1]?.trim() ?? null;
    if (!id || !name) return [];
    const screenMatch = entry.match(/Screen:\s*(\d+)\s*x\s*(\d+)/i);
    const densityDpi = Number(
      entry.match(/Density:\s*(\d+)/i)?.[1] ?? Number.NaN,
    );
    const fallbackScreen = ANDROID_DEVICE_PROFILE_SCREEN_FALLBACKS[id] ?? null;
    const screen = screenMatch
      ? {
          width: Number(screenMatch[1]),
          height: Number(screenMatch[2]),
          densityDpi: Number.isFinite(densityDpi) ? densityDpi : null,
        }
      : fallbackScreen;
    return [{ id, name, manufacturer, screen }];
  });
}

export function parseAndroidSystemImages(
  output: string,
): MobilePreviewAndroidSystemImage[] {
  return output
    .split(/\r?\n/)
    .flatMap((line) => {
      const packagePath = line.split('|')[0]?.trim();
      const match = packagePath?.match(
        /^system-images;android-(\d+(?:\.\d+)?);([^;]+);([^;]+)$/,
      );
      if (!packagePath || !match) return [];
      return [
        {
          id: packagePath,
          packagePath,
          apiLevel: Number(match[1]),
          tag: match[2],
          abi: match[3],
          installed: true,
        },
      ];
    })
    .sort((a, b) => b.apiLevel - a.apiLevel || a.tag.localeCompare(b.tag));
}

function parseAndroidInstalledPackagePaths(output: string): Set<string> {
  return new Set(
    output
      .split(/\r?\n/)
      .map((line) => line.split('|')[0]?.trim())
      .filter((path): path is string => !!path && !path.startsWith('-')),
  );
}

function getAndroidPlatformPackageForSystemImage(systemImageId: string):
  | string
  | null {
  const api = systemImageId.match(/^system-images;android-([^;]+);/)?.[1];
  return api ? `platforms;android-${api}` : null;
}

function assertAndroidDeviceProfileId(id: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
    throw new Error('Invalid Android device profile id.');
  }
}

function assertAndroidSystemImageId(id: string): void {
  if (
    !/^system-images;android-\d+(?:\.\d+)?;[A-Za-z0-9_.-]+;[A-Za-z0-9_.-]+$/.test(
      id,
    )
  ) {
    throw new Error('Invalid Android system image id.');
  }
}

export function parseAndroidWmSize(output: string): {
  width: number;
  height: number;
} | null {
  const matches = Array.from(
    output.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/g),
  );
  const match = matches.at(-1);
  if (!match) return null;

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width <= 0 || height <= 0) return null;

  return { width, height };
}

export function buildAdbScreenrecordArgs(
  adbSerial: string,
  _fps: number | undefined,
  quality: MobilePreviewQuality = 'high',
): string[] {
  assertDeviceId(adbSerial);
  const previewQuality = ANDROID_PREVIEW_QUALITY[quality];

  return [
    '-s',
    adbSerial,
    'exec-out',
    'screenrecord',
    '--output-format=h264',
    '--bit-rate',
    String(previewQuality.bitRate),
    '--time-limit',
    '180',
    '-',
  ];
}

export function buildAdbScreenshotArgs(adbSerial: string): string[] {
  assertDeviceId(adbSerial);

  return ['-s', adbSerial, 'exec-out', 'screencap', '-p'];
}

export function parseAdbDevices(output: string): MobilePreviewDevice[] {
  const lines = output.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) =>
    line.trim().startsWith('List of devices attached'),
  );

  if (headerIndex === -1) return [];

  return lines.slice(headerIndex + 1).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) return [];

    const [id, state, ...details] = trimmed.split(/\s+/);
    if (!id || !state || !DEVICE_LINE_STATES.has(state)) return [];

    return [
      {
        id,
        name: parseDeviceName(id, details),
        platform: 'android' as const,
        state: mapDeviceState(state),
      },
    ];
  });
}

async function getBootedAvdNameByDeviceId(
  devices: MobilePreviewDevice[],
  signal?: AbortSignal,
) {
  const names = new Map<string, string>();
  await Promise.all(
    devices
      .filter((device) => device.id.startsWith('emulator-'))
      .map(async (device) => {
        try {
          const { stdout } = await runAdbCommand(
            ['-s', device.id, 'emu', 'avd', 'name'],
            signal ? { signal } : undefined,
          );
          const name = stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line && line !== 'OK');
          if (name) names.set(device.id, name);
        } catch {
          signal?.throwIfAborted();
          // Physical devices and some emulator states do not answer emu commands.
        }
      }),
  );
  return names;
}

async function listAllAndroidDevices(): Promise<MobilePreviewDevice[]> {
  const { stdout } = await runAdbCommand(['devices', '-l']);
  const adbDevices = parseAdbDevices(stdout);
  const emulatorCommand = await getEmulatorCommand();
  if (!emulatorCommand) return adbDevices;

  const [{ stdout: avdOutput }, bootedAvdNameByDeviceId] = await Promise.all([
    runCommand(emulatorCommand, ['-list-avds']),
    getBootedAvdNameByDeviceId(adbDevices),
  ]);
  const bootedAvdNames = new Set(bootedAvdNameByDeviceId.values());
  const namedAdbDevices = adbDevices.map((device) => {
    const avdName = bootedAvdNameByDeviceId.get(device.id);
    return avdName
      ? { ...device, id: avdName, name: avdName.replaceAll('_', ' ') }
      : device;
  });
  const shutdownAvds = parseAvdList(avdOutput).filter(
    (device) => !bootedAvdNames.has(device.id),
  );

  return [...namedAdbDevices, ...shutdownAvds];
}

async function waitForBootedAndroidDevice({
  previousDeviceIds,
  avdName,
  signal,
}: {
  previousDeviceIds: Set<string>;
  avdName: string;
  signal?: AbortSignal;
}): Promise<string> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < ANDROID_EMULATOR_BOOT_TIMEOUT_MS) {
    signal?.throwIfAborted();
    const devices = parseAdbDevices(
      (
        await runAdbCommand(
          ['devices', '-l'],
          signal ? { signal } : undefined,
        )
      ).stdout,
    ).filter((device) => device.state === 'booted');
    const bootedAvdNameByDeviceId = await getBootedAvdNameByDeviceId(
      devices,
      signal,
    );
    const matchingDevice = devices.find(
      (device) =>
        bootedAvdNameByDeviceId.get(device.id) === avdName ||
        !previousDeviceIds.has(device.id),
    );

    if (matchingDevice) {
      try {
        const { stdout } = await runAdbCommand(
          [
            '-s',
            matchingDevice.id,
            'shell',
            'getprop',
            'sys.boot_completed',
          ],
          signal ? { signal } : undefined,
        );
        if (stdout.trim() === '1') return matchingDevice.id;
      } catch {
        signal?.throwIfAborted();
        // Device is visible before Android userspace is ready.
      }
    }

    await sleep(ANDROID_EMULATOR_POLL_INTERVAL_MS, signal);
  }

  throw new Error(`Timed out waiting for Android emulator to boot: ${avdName}`);
}

async function waitForAndroidPreviewReady(
  adbSerial: string,
  signal?: AbortSignal,
): Promise<void> {
  const startedAt = Date.now();
  let lastError: Error | null = null;

  while (Date.now() - startedAt < ANDROID_PREVIEW_READY_TIMEOUT_MS) {
    signal?.throwIfAborted();
    try {
      const [bootCompleted, bootAnimation, screenSize] = await Promise.all([
        runAdbCommand(
          ['-s', adbSerial, 'shell', 'getprop', 'sys.boot_completed'],
          signal ? { signal } : undefined,
        ),
        runAdbCommand(
          ['-s', adbSerial, 'shell', 'getprop', 'init.svc.bootanim'],
          signal ? { signal } : undefined,
        ),
        runAdbCommand(
          ['-s', adbSerial, 'shell', 'wm', 'size'],
          signal ? { signal } : undefined,
        ),
      ]);

      const bootAnimationState = bootAnimation.stdout.trim();
      const bootAnimationDone =
        bootAnimationState === '' ||
        bootAnimationState === 'stopped' ||
        bootAnimationState === 'not found';
      if (
        bootCompleted.stdout.trim() === '1' &&
        bootAnimationDone &&
        parseAndroidWmSize(screenSize.stdout)
      ) {
        return;
      }
    } catch (error) {
      signal?.throwIfAborted();
      lastError = toError(error);
    }

    await sleep(ANDROID_EMULATOR_POLL_INTERVAL_MS, signal);
  }

  throw new Error(
    `Timed out waiting for Android preview display to be ready: ${adbSerial}${
      lastError ? ` (${lastError.message})` : ''
    }`,
  );
}

async function resolveBootedAndroidAvdName(
  devices: MobilePreviewDevice[],
  avdName: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const bootedEmulators = devices.filter(
    (device) => device.id.startsWith('emulator-') && device.state === 'booted',
  );
  const bootedAvdNameByDeviceId = await getBootedAvdNameByDeviceId(
    bootedEmulators,
    signal,
  );
  const matchingDevice = bootedEmulators.find(
    (device) => bootedAvdNameByDeviceId.get(device.id) === avdName,
  );
  return matchingDevice?.id ?? null;
}

async function resolveAndroidAdbSerial(
  deviceIdOrAvdName: string,
  signal?: AbortSignal,
) {
  const devices = parseAdbDevices(
    (await runAdbCommand(['devices', '-l'], signal ? { signal } : undefined)).stdout,
  );
  if (devices.some((device) => device.id === deviceIdOrAvdName)) {
    return deviceIdOrAvdName;
  }

  const bootedDeviceId = await resolveBootedAndroidAvdName(
    devices,
    deviceIdOrAvdName,
    signal,
  );
  if (bootedDeviceId) return bootedDeviceId;

  const emulatorCommand = await getEmulatorCommand(signal);
  if (!emulatorCommand) {
    throw new Error(
      'Missing required Android emulator tool: emulator. Install Android Studio or ensure the Android SDK emulator command is on PATH.',
    );
  }

  spawn(emulatorCommand, ['-avd', deviceIdOrAvdName], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  const windowNameIncludes = [
    deviceIdOrAvdName,
    deviceIdOrAvdName.replaceAll('_', ' '),
  ];
  void minimizeMobilePreviewWindows({
    processNames: ANDROID_EMULATOR_PROCESS_NAMES,
    windowNameIncludes,
  });

  const adbSerial = await waitForBootedAndroidDevice({
    previousDeviceIds: new Set(devices.map((device) => device.id)),
    avdName: deviceIdOrAvdName,
    signal,
  });
  await waitForAndroidPreviewReady(adbSerial, signal);
  void minimizeMobilePreviewWindows({
    processNames: ANDROID_EMULATOR_PROCESS_NAMES,
    windowNameIncludes: [...windowNameIncludes, adbSerial],
  });
  return adbSerial;
}

function escapeAdbInputText(text: string): string {
  return Array.from(text)
    .map((char) =>
      REMOTE_SHELL_TEXT_META_CHARS.has(char) ? `\\${char}` : char,
    )
    .join('');
}

export function buildAdbInputArgs(
  adbSerial: string,
  event: MobilePreviewInputEvent | unknown,
): string[] {
  assertDeviceId(adbSerial);
  assertInputEvent(event);

  switch (event.type) {
    case 'touchDown':
    case 'touchMove':
    case 'touchUp': {
      assertAndroidInteger('x', event.x, MAX_ANDROID_COORDINATE);
      assertAndroidInteger('y', event.y, MAX_ANDROID_COORDINATE);
      const action =
        event.type === 'touchDown'
          ? 'DOWN'
          : event.type === 'touchMove'
            ? 'MOVE'
            : 'UP';
      return [
        '-s',
        adbSerial,
        'shell',
        'input',
        'motionevent',
        action,
        String(event.x),
        String(event.y),
      ];
    }
    case 'tap':
      assertAndroidInteger('x', event.x, MAX_ANDROID_COORDINATE);
      assertAndroidInteger('y', event.y, MAX_ANDROID_COORDINATE);
      return [
        '-s',
        adbSerial,
        'shell',
        'input',
        'tap',
        String(event.x),
        String(event.y),
      ];
    case 'longPress':
      assertAndroidInteger('x', event.x, MAX_ANDROID_COORDINATE);
      assertAndroidInteger('y', event.y, MAX_ANDROID_COORDINATE);
      assertAndroidInteger(
        'durationMs',
        event.durationMs,
        MAX_ANDROID_DURATION_MS,
      );
      return [
        '-s',
        adbSerial,
        'shell',
        'input',
        'swipe',
        String(event.x),
        String(event.y),
        String(event.x),
        String(event.y),
        String(event.durationMs),
      ];
    case 'swipe':
      assertAndroidInteger('x1', event.x1, MAX_ANDROID_COORDINATE);
      assertAndroidInteger('y1', event.y1, MAX_ANDROID_COORDINATE);
      assertAndroidInteger('x2', event.x2, MAX_ANDROID_COORDINATE);
      assertAndroidInteger('y2', event.y2, MAX_ANDROID_COORDINATE);
      assertAndroidInteger(
        'durationMs',
        event.durationMs,
        MAX_ANDROID_DURATION_MS,
      );
      return [
        '-s',
        adbSerial,
        'shell',
        'input',
        'swipe',
        String(event.x1),
        String(event.y1),
        String(event.x2),
        String(event.y2),
        String(event.durationMs),
      ];
    case 'text':
      assertTextInput(event.text);
      return [
        '-s',
        adbSerial,
        'shell',
        'input',
        'text',
        escapeAdbInputText(event.text),
      ];
    case 'showKeyboard':
      return [
        '-s',
        adbSerial,
        'shell',
        'cmd',
        'input_method',
        'show-soft-input',
      ];
    case 'key':
      if (event.key === 'back') {
        return ['-s', adbSerial, 'shell', 'input', 'keyevent', 'KEYCODE_BACK'];
      }
      if (event.key === 'home') {
        return ['-s', adbSerial, 'shell', 'input', 'keyevent', 'KEYCODE_HOME'];
      }
      if (event.key === 'enter') {
        return ['-s', adbSerial, 'shell', 'input', 'keyevent', 'KEYCODE_ENTER'];
      }
      if (event.key === 'backspace') {
        return ['-s', adbSerial, 'shell', 'input', 'keyevent', 'KEYCODE_DEL'];
      }
      throw new Error(`Unsupported Android key input: ${String(event.key)}.`);
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

async function sendAndroidShowKeyboard(
  adbSerial: string,
  isCurrent: () => boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (!isCurrent()) return;
  try {
    await runAdbCommand(buildAdbInputArgs(adbSerial, { type: 'showKeyboard' }), {
      signal,
    });
    return;
  } catch {
    // Some emulator images return 255 for cmd input_method show-soft-input.
  }

  try {
    if (!isCurrent()) return;
    await runAdbCommand(
      ['-s', adbSerial, 'shell', 'input', 'keyevent', 'KEYCODE_MENU'],
      { signal },
    );
  } catch {
    // Showing the soft keyboard is best-effort; text input still works via adb.
  }
}

async function startAndroidScreenshotStream({
  adbSerial,
  activeStops,
  taskId,
  error,
  onFrame,
  onSession,
  signal,
}: {
  adbSerial: string;
  activeStops: Set<() => Promise<void>>;
  taskId: string;
  error?: string | null;
  onFrame: (frame: MobilePreviewFramePayload) => void;
  onSession: (patch: Partial<MobilePreviewSession>) => void;
  signal?: AbortSignal;
}): Promise<{ session: MobilePreviewSession; stop: () => Promise<void> }> {
  signal?.throwIfAborted();
  const screenSize = parseAndroidWmSize(
    (
      await runAdbCommand(
        ['-s', adbSerial, 'shell', 'wm', 'size'],
        signal ? { signal } : undefined,
      )
    ).stdout,
  );
  const session: MobilePreviewSession = {
    id: randomUUID(),
    taskId,
    platform: 'android',
    deviceId: adbSerial,
    status: 'streaming',
    width: screenSize?.width ?? null,
    height: screenSize?.height ?? null,
    frameFormat: 'png',
    streamStrategy: 'adb-screenshot',
    inputStatus: 'ready',
    error: error ?? null,
  };

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let captureController: AbortController | null = null;
  let capturePromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  const scheduleNextFrame = () => {
    if (stopped) return;
    timer = setTimeout(captureFrame, ANDROID_SCREENSHOT_POLL_INTERVAL_MS);
  };

  const captureFrame = () => {
    if (stopped || capturePromise) return;
    const controller = new AbortController();
    captureController = controller;
    const promise = runAdbBinaryCommand(buildAdbScreenshotArgs(adbSerial), {
      timeoutMs: ANDROID_SCREENSHOT_TIMEOUT_MS,
      signal: signal
        ? AbortSignal.any([controller.signal, signal])
        : controller.signal,
    })
      .then(({ stdout }) => {
        if (stopped) return;
        if (stdout.length > 0) onFrame(stdout);
        onSession({ error: null });
      })
      .catch((error: unknown) => {
        if (!stopped) {
          onSession({
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .finally(() => {
        if (captureController === controller) captureController = null;
        if (capturePromise === promise) capturePromise = null;
        scheduleNextFrame();
      });
    capturePromise = promise;
  };

  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      try {
        stopped = true;
        if (timer) clearTimeout(timer);
        captureController?.abort();
        await capturePromise;
      } finally {
        activeStops.delete(stop);
      }
    })();
    return stopPromise;
  };
  activeStops.add(stop);
  captureFrame();

  return { session, stop };
}

async function startAndroidScreenrecordStream({
  adbSerial,
  taskId,
  fps,
  quality = 'high',
  error,
  onFrame,
  onError,
  signal,
}: {
  adbSerial: string;
  taskId: string;
  fps?: number;
  quality?: MobilePreviewQuality;
  error?: string | null;
  onFrame: (frame: MobilePreviewFramePayload) => void;
  onError: (error: Error) => void;
  signal?: AbortSignal;
}): Promise<{ session: MobilePreviewSession; stop: () => Promise<void> }> {
  signal?.throwIfAborted();
  const screenSize = parseAndroidWmSize(
    (
      await runAdbCommand(
        ['-s', adbSerial, 'shell', 'wm', 'size'],
        signal ? { signal } : undefined,
      )
    ).stdout,
  );
  const session: MobilePreviewSession = {
    id: randomUUID(),
    taskId,
    platform: 'android',
    deviceId: adbSerial,
    status: 'streaming',
    width: screenSize?.width ?? null,
    height: screenSize?.height ?? null,
    frameFormat: 'h264',
    streamStrategy: 'adb-screenrecord',
    inputStatus: 'ready',
    error: error ?? null,
  };

  const adbCommand = await getAdbCommand(signal);
  const screenrecordArgs = buildAdbScreenrecordArgs(adbSerial, fps, quality);
  const { child, stop } = signal
    ? spawnManaged(adbCommand, screenrecordArgs, { signal })
    : spawnManaged(adbCommand, screenrecordArgs);
  let stopped = false;
  let stderr = '';
  let sawFrame = false;
  let resolveFirstFrame: (() => void) | null = null;
  let rejectFirstFrame: ((error: Error) => void) | null = null;
  const firstFrame = new Promise<void>((resolve, reject) => {
    resolveFirstFrame = resolve;
    rejectFirstFrame = reject;
  });

  child.stdout.on('data', (chunk: Buffer) => {
    if (chunk.length === 0) return;
    sawFrame = true;
    resolveFirstFrame?.();
    onFrame(Buffer.from(chunk));
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  child.on('error', (processError: Error) => {
    rejectFirstFrame?.(processError);
    if (!stopped) onError(processError);
  });

  child.on('close', (code) => {
    if (stopped) return;
    const message =
      code === 0
        ? 'Android adb screenrecord stream ended.'
        : `Android adb screenrecord exited with code ${code ?? 'unknown'}${
            stderr.trim() ? `: ${stderr.trim()}` : ''
          }`;
    const error = new Error(message);
    if (!sawFrame) rejectFirstFrame?.(error);
    onError(error);
  });

  try {
    await withTimeout({
      promise: firstFrame,
      timeoutMs: ANDROID_SCRCPY_START_TIMEOUT_MS,
      message: 'Timed out waiting for first Android adb screenrecord frame.',
      signal,
    });
  } catch (streamError) {
    stopped = true;
    await stop().catch(() => undefined);
    throw streamError;
  }

  return {
    session,
    stop: async () => {
      stopped = true;
      await stop();
    },
  };
}

export function createAndroidMobilePreviewAdapter({
  startScrcpyStream = startAndroidScrcpyStream,
}: {
  startScrcpyStream?: AndroidScrcpyStarter;
} = {}) {
  type TouchEvent = Extract<
    MobilePreviewInputEvent,
    { type: 'touchDown' | 'touchMove' | 'touchUp' }
  >;
  type TouchQueueItem = {
    compensating?: boolean;
    event: TouchEvent;
    generation: number;
    sessionId?: string;
    waiters: Array<{
      resolve: () => void;
      reject: (error: unknown) => void;
    }>;
  };
  type TouchQueue = {
    activeGesture: {
      sessionId?: string;
      x: number;
      y: number;
    } | null;
    compensationPending: boolean;
    currentItem: TouchQueueItem | null;
    items: TouchQueueItem[];
    running: Promise<void> | null;
    adbSerial: Promise<string> | null;
  };
  const touchQueues = new Map<string, TouchQueue>();
  const activeSessionIds = new Set<string>();
  const activeScreenshotStreamStops = new Set<() => Promise<void>>();
  const activeNonTouchInputs = new Set<{
    sessionId?: string;
    controller: AbortController;
    promise: Promise<void>;
  }>();
  let generation = 0;
  let disposed = false;

  const isCurrentTouchItem = (item: TouchQueueItem) =>
    (item.compensating || item.generation === generation) &&
    (!item.sessionId || activeSessionIds.has(item.sessionId));

  const queueCompensatingUp = (queue: TouchQueue, sessionId?: string) => {
    const gesture = queue.activeGesture;
    if (
      !gesture ||
      gesture.sessionId !== sessionId ||
      queue.compensationPending ||
      queue.currentItem?.sessionId === sessionId
    ) {
      return;
    }
    queue.compensationPending = true;
    queue.items.unshift({
      compensating: true,
      event: { type: 'touchUp', x: gesture.x, y: gesture.y },
      generation,
      waiters: [],
    });
  };

  const runTouchQueue = (deviceId: string, queue: TouchQueue) => {
    if (queue.running) return;
    queue.running = (async () => {
      while (queue.items.length > 0) {
        const item = queue.items.shift()!;
        let sentEvent = false;
        queue.currentItem = item;
        if (!isCurrentTouchItem(item)) {
          for (const waiter of item.waiters) waiter.resolve();
          queue.currentItem = null;
          continue;
        }
        try {
          await assertAdbInstalled();
          assertDeviceId(deviceId);
          queue.adbSerial ??= resolveAndroidAdbSerial(deviceId);
          const adbSerial = await queue.adbSerial;
          if (isCurrentTouchItem(item)) {
            const gesture = queue.activeGesture;
            if (
              item.event.type === 'touchDown' &&
              gesture &&
              gesture.sessionId !== item.sessionId
            ) {
              let released = false;
              try {
                await runAdbCommand(
                  buildAdbInputArgs(adbSerial, {
                    type: 'touchUp',
                    x: gesture.x,
                    y: gesture.y,
                  }),
                );
                released = true;
              } catch {
                // Gesture takeover release is best-effort.
              }
              if (released) {
                queue.activeGesture = null;
                queue.compensationPending = false;
              }
            }
            const activeGesture = queue.activeGesture;
            const ownsGesture =
              item.compensating ||
              (item.event.type === 'touchDown'
                ? !activeGesture || activeGesture.sessionId === item.sessionId
                : false) ||
              (!!activeGesture && activeGesture.sessionId === item.sessionId);
            if (ownsGesture && isCurrentTouchItem(item)) {
              await runAdbCommand(buildAdbInputArgs(adbSerial, item.event));
              sentEvent = true;
            }
            if (sentEvent && item.event.type === 'touchDown') {
              queue.activeGesture = {
                sessionId: item.sessionId,
                x: item.event.x,
                y: item.event.y,
              };
            } else if (sentEvent && item.event.type === 'touchMove') {
              const currentGesture = queue.activeGesture;
              if (currentGesture && currentGesture.sessionId === item.sessionId) {
                currentGesture.x = item.event.x;
                currentGesture.y = item.event.y;
              }
            }
          } else if (!queue.activeGesture) {
            queue.adbSerial = null;
          }
          for (const waiter of item.waiters) waiter.resolve();
        } catch (error) {
          queue.adbSerial = null;
          for (const waiter of item.waiters) waiter.reject(error);
        }
        if (item.event.type === 'touchUp' && sentEvent) {
          queue.activeGesture = null;
          queue.compensationPending = false;
          queue.adbSerial = null;
        } else if (item.compensating) {
          queue.compensationPending = false;
        }
        queue.currentItem = null;
        if (
          item.event.type !== 'touchUp' &&
          item.sessionId &&
          !activeSessionIds.has(item.sessionId)
        ) {
          queueCompensatingUp(queue, item.sessionId);
        }
      }
    })().finally(() => {
      queue.running = null;
      if (queue.items.length > 0) {
        runTouchQueue(deviceId, queue);
      } else if (!queue.adbSerial && !queue.activeGesture) {
        touchQueues.delete(deviceId);
      }
    });
  };

  const enqueueTouchInput = (
    deviceId: string,
    event: TouchEvent,
    sessionId?: string,
  ): Promise<void> => {
    if (disposed) return Promise.resolve();
    const queue = touchQueues.get(deviceId) ?? {
      activeGesture: null,
      compensationPending: false,
      currentItem: null,
      items: [],
      running: null,
      adbSerial: null,
    };
    touchQueues.set(deviceId, queue);
    const result = new Promise<void>((resolve, reject) => {
      const last = queue.items.at(-1);
      if (
        event.type === 'touchMove' &&
        last?.event.type === 'touchMove' &&
        last.sessionId === sessionId
      ) {
        last.event = event;
        last.waiters.push({ resolve, reject });
      } else {
        queue.items.push({
          event,
          generation,
          sessionId,
          waiters: [{ resolve, reject }],
        });
      }
    });
    runTouchQueue(deviceId, queue);
    return result;
  };

  const cancelSessionInput = async (sessionId: string): Promise<void> => {
    const running: Promise<void>[] = [];
    for (const [deviceId, queue] of touchQueues) {
      queue.items = queue.items.filter((item) => {
        if (item.sessionId !== sessionId) return true;
        for (const waiter of item.waiters) waiter.resolve();
        return false;
      });
      queueCompensatingUp(queue, sessionId);
      if (!queue.running && queue.items.length > 0) runTouchQueue(deviceId, queue);
      if (queue.running) running.push(queue.running);
    }
    await Promise.all(running);
  };

  const runNonTouchInput = (
    sessionId: string | undefined,
    operation: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> => {
    const controller = new AbortController();
    const active = {
      sessionId,
      controller,
      promise: Promise.resolve(),
    };
    active.promise = Promise.resolve()
      .then(() => operation(controller.signal))
      .finally(() => activeNonTouchInputs.delete(active));
    activeNonTouchInputs.add(active);
    return active.promise;
  };

  const cancelNonTouchInputs = async (sessionId?: string): Promise<void> => {
    const inputs = Array.from(activeNonTouchInputs).filter(
      (input) => sessionId === undefined || input.sessionId === sessionId,
    );
    inputs.forEach(({ controller }) => controller.abort());
    await Promise.allSettled(inputs.map(({ promise }) => promise));
  };

  const ownStream = <T extends { session: MobilePreviewSession; stop: () => Promise<void> }>(
    stream: T,
  ): T => {
    activeSessionIds.add(stream.session.id);
    const originalStop = stream.stop;
    let stopPromise: Promise<void> | null = null;
    return {
      ...stream,
      stop: () => {
        stopPromise ??= (async () => {
          activeSessionIds.delete(stream.session.id);
          await Promise.all([
            cancelSessionInput(stream.session.id),
            cancelNonTouchInputs(stream.session.id),
          ]);
          await originalStop();
        })();
        return stopPromise;
      },
    };
  };

  return {
    async getAndroidToolStatus(): Promise<MobilePreviewAndroidToolStatus> {
      const [sdkRoot, adbPath, emulatorPath, avdmanagerPath, sdkmanagerPath] =
        await Promise.all([
          getSdkRoot(),
          getAndroidSdkToolCommand('adb'),
          getAndroidSdkToolCommand('emulator'),
          getAndroidSdkToolCommand('avdmanager'),
          getAndroidSdkToolCommand('sdkmanager'),
        ]);

      const missingTools = [
        !adbPath && 'adb',
        !emulatorPath && 'emulator',
        !avdmanagerPath && 'avdmanager',
        !sdkmanagerPath && 'sdkmanager',
      ].filter(Boolean) as MobilePreviewAndroidToolStatus['missingTools'];

      return {
        hostArch: process.arch,
        sdkRoot,
        adbPath,
        emulatorPath,
        avdmanagerPath,
        sdkmanagerPath,
        missingTools,
      };
    },

    async listAndroidDeviceProfiles(): Promise<
      MobilePreviewAndroidDeviceProfile[]
    > {
      const avdmanager = await getAndroidSdkToolCommand('avdmanager');
      if (!avdmanager) throw getMissingAndroidToolError('avdmanager');
      const sdkRoot = await getSdkRoot();
      const androidSdkEnv = getAndroidSdkEnv(sdkRoot);
      const { stdout } = androidSdkEnv
        ? await runCommand(avdmanager, ['list', 'device'], { env: androidSdkEnv })
        : await runCommand(avdmanager, ['list', 'device']);
      return parseAndroidDeviceProfiles(stdout);
    },

    async listAndroidSystemImages(): Promise<
      MobilePreviewAndroidSystemImage[]
    > {
      const sdkmanager = await getAndroidSdkToolCommand('sdkmanager');
      if (!sdkmanager) throw getMissingAndroidToolError('sdkmanager');
      const sdkRoot = await getSdkRoot();
      const { stdout } = await runCommand(
        sdkmanager,
        sdkRoot ? [`--sdk_root=${sdkRoot}`, '--list_installed'] : ['--list_installed'],
      );
      return parseAndroidSystemImages(stdout);
    },

    async createAndroidDevice(
      params: MobilePreviewAndroidCreateDeviceParams,
    ): Promise<void> {
      assertAndroidAvdName(params.name);
      assertAndroidDeviceProfileId(params.deviceProfileId);
      assertAndroidSystemImageId(params.systemImageId);
      assertAndroidAvdAdvancedSettings(params);
      const avdmanager = await getAndroidSdkToolCommand('avdmanager');
      if (!avdmanager) throw getMissingAndroidToolError('avdmanager');
      const sdkRoot = await getSdkRoot();
      const androidSdkEnv = getAndroidSdkEnv(sdkRoot);
      const emulator = await getEmulatorCommand();
      if (emulator) {
        const { stdout } = await runCommand(emulator, ['-list-avds']);
        if (parseAvdList(stdout).some((device) => device.id === params.name)) {
          throw new Error(`Android device already exists: ${params.name}`);
        }
      }

      const platformPackage = getAndroidPlatformPackageForSystemImage(
        params.systemImageId,
      );
      if (platformPackage) {
        const sdkmanager = await getAndroidSdkToolCommand('sdkmanager');
        if (!sdkmanager) throw getMissingAndroidToolError('sdkmanager');
        const listArgs = sdkRoot
          ? [`--sdk_root=${sdkRoot}`, '--list_installed']
          : ['--list_installed'];
        const { stdout } = await runCommand(sdkmanager, listArgs);
        if (!parseAndroidInstalledPackagePaths(stdout).has(platformPackage)) {
          await runCommand(
            sdkmanager,
            sdkRoot
              ? [`--sdk_root=${sdkRoot}`, platformPackage]
              : [platformPackage],
            { timeoutMs: ANDROID_SDK_INSTALL_TIMEOUT_MS },
          );
        }
      }

      await runCommand(
        avdmanager,
        [
          'create',
          'avd',
          '--name',
          params.name,
          '--device',
          params.deviceProfileId,
          '--package',
          params.systemImageId,
        ],
        { ...(androidSdkEnv && { env: androidSdkEnv }), input: 'no\n' },
      );

      if (hasAndroidAvdAdvancedSettings(params)) {
        await writeAndroidAvdAdvancedConfig(params.name, params);
      }
    },

    async deleteAndroidDevice(name: string): Promise<void> {
      assertAndroidAvdName(name);
      const avdmanager = await getAndroidSdkToolCommand('avdmanager');
      if (!avdmanager) throw getMissingAndroidToolError('avdmanager');
      const sdkRoot = await getSdkRoot();
      const androidSdkEnv = getAndroidSdkEnv(sdkRoot);

      if (androidSdkEnv) {
        await runCommand(avdmanager, ['delete', 'avd', '--name', name], {
          env: androidSdkEnv,
        });
        return;
      }

      await runCommand(avdmanager, ['delete', 'avd', '--name', name]);
    },

    async installAndroidSystemImage(
      params: MobilePreviewAndroidInstallSystemImageParams,
    ): Promise<void> {
      assertAndroidSystemImageId(params.systemImageId);
      const sdkmanager = await getAndroidSdkToolCommand('sdkmanager');
      if (!sdkmanager) throw getMissingAndroidToolError('sdkmanager');
      const sdkRoot = await getSdkRoot();

      await runCommand(
        sdkmanager,
        sdkRoot
          ? [`--sdk_root=${sdkRoot}`, params.systemImageId]
          : [params.systemImageId],
        {
          timeoutMs: ANDROID_SDK_INSTALL_TIMEOUT_MS,
        },
      );
    },

    async listDevices(): Promise<MobilePreviewDevice[]> {
      await assertAdbInstalled();
      return listAllAndroidDevices();
    },

    async startStream(params: {
      taskId: string;
      deviceId: string;
      fps?: number;
      quality?: MobilePreviewQuality;
      signal?: AbortSignal;
      onFrame: (frame: MobilePreviewFramePayload) => void;
      onSession: (patch: Partial<MobilePreviewSession>) => void;
    }): Promise<{ session: MobilePreviewSession; stop: () => Promise<void> }> {
      if (disposed) throw new Error('Android preview is shutting down.');
      params.signal?.throwIfAborted();
      await assertAdbInstalled(params.signal);
      assertDeviceId(params.deviceId);

      const adbSerial = await resolveAndroidAdbSerial(
        params.deviceId,
        params.signal,
      );
      params.signal?.throwIfAborted();
      if (disposed) throw new Error('Android preview is shutting down.');
      const screenSize = parseAndroidWmSize(
        (
          await runAdbCommand(
            ['-s', adbSerial, 'shell', 'wm', 'size'],
            params.signal ? { signal: params.signal } : undefined,
          )
        ).stdout,
      );
      const session: MobilePreviewSession = {
        id: randomUUID(),
        taskId: params.taskId,
        platform: 'android',
        deviceId: params.deviceId,
        status: 'starting',
        width: screenSize?.width ?? null,
        height: screenSize?.height ?? null,
        frameFormat: 'h264',
        streamStrategy: 'scrcpy',
        inputStatus: 'ready',
        error: null,
      };

      let stopped = false;
      let currentStop: (() => Promise<void>) | null = null;
      const startScreenshotFallback = async (reason: string) => {
        params.signal?.throwIfAborted();
        if (stopped) return null;
        await currentStop?.().catch(() => undefined);
        try {
          const fallback = await startAndroidScreenshotStream({
            adbSerial,
            activeStops: activeScreenshotStreamStops,
            error: reason,
            taskId: params.taskId,
            onFrame: params.onFrame,
            onSession: params.onSession,
            signal: params.signal,
          });
          if (stopped) {
            await fallback.stop();
            return;
          }
          currentStop = fallback.stop;
          const nextSession = {
            ...fallback.session,
            deviceId: params.deviceId,
          };
          params.onSession({
            status: nextSession.status,
            width: nextSession.width,
            height: nextSession.height,
            frameFormat: nextSession.frameFormat,
            streamStrategy: nextSession.streamStrategy,
            inputStatus: nextSession.inputStatus,
            error: reason,
          });
          return fallback;
        } catch (fallbackError) {
          if (!stopped) {
            params.onSession({
              error: `${reason}; screenshot fallback failed: ${toError(fallbackError).message}`,
            });
          }
          return null;
        }
      };
      const startVideoFallback = async (error: Error) => {
        params.signal?.throwIfAborted();
        const scrcpyFallbackReason = formatAndroidScrcpyFallbackError(error);
        if (stopped) return;
        await currentStop?.().catch(() => undefined);
        try {
          const fallback = await startAndroidScreenrecordStream({
            adbSerial,
            error: scrcpyFallbackReason,
            fps: params.fps,
            quality: params.quality,
            taskId: params.taskId,
            onFrame: params.onFrame,
            onError: (screenrecordError) => {
              const fallbackReason = `${scrcpyFallbackReason}; ${formatAndroidScreenrecordFallbackError(screenrecordError)}`;
              void startScreenshotFallback(fallbackReason);
            },
            signal: params.signal,
          });
          if (stopped) {
            await fallback.stop();
            return null;
          }
          currentStop = fallback.stop;
          params.onSession({
            status: fallback.session.status,
            width: fallback.session.width,
            height: fallback.session.height,
            frameFormat: fallback.session.frameFormat,
            streamStrategy: fallback.session.streamStrategy,
            inputStatus: fallback.session.inputStatus,
            error: scrcpyFallbackReason,
          });
          return fallback;
        } catch (screenrecordError) {
          return startScreenshotFallback(
            `${scrcpyFallbackReason}; ${formatAndroidScreenrecordFallbackError(toError(screenrecordError))}`,
          );
        }
      };

      try {
        const stream = await withTimeout({
          promise: startScrcpyStream({
            adbSerial,
            signal: params.signal,
            fps: params.fps,
            quality: params.quality,
            onFrame: params.onFrame,
            onError: (error) => {
              void startVideoFallback(error);
            },
            onSize: (size) => {
              if (!screenSize) {
                params.onSession(size);
                return;
              }
              // scrcpy sizes are downscaled by maxSize, so they can't be used as
              // input coordinates. Only adopt their orientation: keep `wm size`
              // magnitudes and transpose them when the device rotated.
              const streamLandscape = size.width > size.height;
              const screenLandscape = screenSize.width > screenSize.height;
              params.onSession(
                streamLandscape === screenLandscape
                  ? { width: screenSize.width, height: screenSize.height }
                  : { width: screenSize.height, height: screenSize.width },
              );
            },
          }),
          timeoutMs: ANDROID_SCRCPY_START_TIMEOUT_MS,
          message: 'Timed out starting Android scrcpy stream.',
          signal: params.signal,
        });
        currentStop = stream.stop;
        params.onSession({ status: 'streaming' });
        return ownStream({
          session: { ...session, status: 'streaming' },
          stop: async () => {
            stopped = true;
            await currentStop?.();
          },
        });
      } catch (error) {
        params.signal?.throwIfAborted();
        const fallback = await startVideoFallback(toError(error));
        if (fallback) {
          return ownStream({
            session: { ...fallback.session, deviceId: params.deviceId },
            stop: async () => {
              stopped = true;
              await currentStop?.();
            },
          });
        }

        return ownStream({
          session: {
            ...session,
            status: 'streaming',
            frameFormat: 'png',
            streamStrategy: 'adb-screenshot',
          },
          stop: async () => {
            stopped = true;
            await currentStop?.();
          },
        });
      }
    },

    async sendInput(
      deviceId: string,
      event: MobilePreviewInputEvent,
      sessionId?: string,
    ): Promise<void> {
      if (isTouchLifecycleEvent(event)) {
        await enqueueTouchInput(deviceId, event, sessionId);
        return;
      }

      if (disposed || (sessionId && !activeSessionIds.has(sessionId))) return;

      const inputGeneration = generation;
      const isCurrent = () =>
        !disposed &&
        inputGeneration === generation &&
        (!sessionId || activeSessionIds.has(sessionId));

      await runNonTouchInput(sessionId, async (signal) => {
        await assertAdbInstalled();
        assertDeviceId(deviceId);
        const adbSerial = await resolveAndroidAdbSerial(deviceId, signal);
        if (!isCurrent()) return;
        if (event.type === 'showKeyboard') {
          await sendAndroidShowKeyboard(adbSerial, isCurrent, signal);
          return;
        }
        if (!isCurrent()) return;
        await runAdbCommand(buildAdbInputArgs(adbSerial, event), { signal });
      });
    },

    async dispose(): Promise<void> {
      disposed = true;
      generation += 1;
      const sessionIds = Array.from(activeSessionIds);
      activeSessionIds.clear();
      const nonTouchInputs = cancelNonTouchInputs();
      const screenshotStops = Array.from(activeScreenshotStreamStops).map(
        (stop) => stop(),
      );
      for (const sessionId of sessionIds) {
        for (const queue of touchQueues.values()) {
          queueCompensatingUp(queue, sessionId);
        }
      }
      const running = Array.from(touchQueues, ([deviceId, queue]) => {
        queue.items = queue.items.filter((item) => {
          if (item.compensating) return true;
          for (const waiter of item.waiters) waiter.resolve();
          return false;
        });
        if (!queue.running && queue.items.length > 0) runTouchQueue(deviceId, queue);
        return queue.running;
      });
      await Promise.all([...running, ...screenshotStops, nonTouchInputs]);
      touchQueues.clear();
    },

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
      await assertAdbInstalled(signal);
      assertDeviceId(deviceId);
      assertDeeplinkUrl(url);
      const adbSerial = await resolveAndroidAdbSerial(deviceId, signal);
      await runAdbCommand(
        [
          '-s',
          adbSerial,
          'shell',
          'am',
          'start',
          '-a',
          'android.intent.action.VIEW',
          '-d',
          url,
        ],
        {
          signal,
          timeoutMs: MOBILE_PREVIEW_DEEPLINK_OPEN_TIMEOUT_MS,
        },
      );
    },

    async openDevMenu(deviceId: string): Promise<void> {
      await assertAdbInstalled();
      assertDeviceId(deviceId);
      const adbSerial = await resolveAndroidAdbSerial(deviceId);
      // KEYCODE_MENU — what a physical menu button / `adb shell input
      // keyevent 82` does, which RN maps to the dev menu.
      await runAdbCommand([
        '-s',
        adbSerial,
        'shell',
        'input',
        'keyevent',
        '82',
      ]);
    },

    async forwardPort({
      deviceId,
      hostPort,
      devicePort,
    }: {
      deviceId: string;
      hostPort: number;
      devicePort: number;
    }): Promise<void> {
      await assertAdbInstalled();
      assertDeviceId(deviceId);
      assertPort(hostPort, 'Host port');
      assertPort(devicePort, 'Device port');
      const adbSerial = await resolveAndroidAdbSerial(deviceId);
      await runAdbCommand([
        '-s',
        adbSerial,
        'reverse',
        `tcp:${devicePort}`,
        `tcp:${hostPort}`,
      ]);
    },

    async setTextSize(
      deviceId: string,
      size: MobilePreviewTextSize,
    ): Promise<void> {
      await assertAdbInstalled();
      assertDeviceId(deviceId);
      const adbSerial = await resolveAndroidAdbSerial(deviceId);
      await runAdbCommand([
        '-s',
        adbSerial,
        'shell',
        'settings',
        'put',
        'system',
        'font_scale',
        ANDROID_FONT_SCALE[size],
      ]);
    },

    async setColorScheme(
      deviceId: string,
      scheme: MobileColorScheme,
    ): Promise<void> {
      await assertAdbInstalled();
      assertDeviceId(deviceId);
      const adbSerial = await resolveAndroidAdbSerial(deviceId);
      await runAdbCommand([
        '-s',
        adbSerial,
        'shell',
        'cmd',
        'uimode',
        'night',
        scheme === 'dark' ? 'yes' : 'no',
      ]);
    },

    async rotate(
      _deviceId: string,
      _direction: MobileRotationDirection,
    ): Promise<void> {
      // Preview rotation is applied in the renderer so streams that ignore
      // device orientation still rotate, without double-rotating streams that do.
    },
  };
}

export const androidAdapter = createAndroidMobilePreviewAdapter();
