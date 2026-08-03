import type {
  MobilePreviewQuality,
  MobilePreviewSession,
} from '../../shared/mobile-simulator-types';

import type {
  CoreSimulatorActiveStream,
  CoreSimulatorPoolEntry,
  RawStreamSize,
} from './mobile-preview-ios-shared-state';

import { access, mkdir, readFile, unlink } from 'node:fs/promises';
import {
  activeCoreSimulatorStreamStops,
  activeScreenshotStreamStops,
  appendBoundedText,
  coreSimulatorPool,
  debug,
  isIosPreviewDisposed,
  pendingCoreSimulatorPoolEntries,
  waitForSignal,
} from './mobile-preview-ios-shared-state';
import {
  getIdbScreenDimensions,
  prewarmIosHidInput,
  releaseIosHidHelper,
  retainIosHidHelper,
} from './mobile-preview-ios-hid-input';
import { runCommand, spawnManaged } from './mobile-preview-process';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

const CORE_SIMULATOR_POOL_TTL_MS = 5 * 60_000;
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
const CORE_SIMULATOR_HELPER_SOURCE = 'mobile-preview-ios-framebuffer.m';
const CORE_SIMULATOR_HELPER_BINARY = 'mobile-preview-ios-framebuffer';
const DEFAULT_CORE_SIMULATOR_FPS = 30;
const MIN_CORE_SIMULATOR_FPS = 1;
const MAX_CORE_SIMULATOR_FPS = 60;
const IOS_SCREENSHOT_TIMEOUT_MS = 5_000;

export const MAX_MJPEG_PENDING_BYTES = 5 * 1024 * 1024;
export const FIRST_FRAME_TIMEOUT_MS = 7_000;
export const SCREENSHOT_POLL_INTERVAL_MS = 250;
export const CORE_SIMULATOR_FIRST_FRAME_TIMEOUT_MS = 15_000;

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

export function buildStartStreamArgs(
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

export function normalizePreviewFps(fps: number | undefined): number {
  if (fps === undefined || !Number.isFinite(fps)) {
    return DEFAULT_CORE_SIMULATOR_FPS;
  }
  return Math.min(
    MAX_CORE_SIMULATOR_FPS,
    Math.max(MIN_CORE_SIMULATOR_FPS, Math.round(fps)),
  );
}

export function getScreenshotPollIntervalMs(fps: number | undefined): number {
  return Math.round(1000 / normalizePreviewFps(fps));
}

export function describeChunk(chunk: Buffer): string {
  return chunk.subarray(0, 24).toString('hex');
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

export function formatStreamExitError({
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

export async function captureSimulatorScreenshot(
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

export async function getSimulatorScreenshotSize(
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

export async function findCoreSimulatorHelperSource(): Promise<string> {
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

let orphanedHelperSweep: Promise<void> | null = null;

/**
 * Older app runs could leave the framebuffer helper behind as an orphan
 * (re-parented to launchd) where it kept encoding frames at full CPU forever.
 * Sweep those once per app run. Only processes re-parented to launchd are
 * matched, so a helper owned by another running app instance is never killed.
 */
export function resetOrphanedHelperSweepForTests(): void {
  orphanedHelperSweep = null;
}

export function killOrphanedCoreSimulatorHelpers(): Promise<void> {
  orphanedHelperSweep ??= sweepOrphanedCoreSimulatorHelpers().catch((error) => {
    // Allow a later attempt if this one failed outright.
    orphanedHelperSweep = null;
    debug(
      'iOS preview orphan helper sweep failed: %s',
      error instanceof Error ? error.message : String(error),
    );
  });
  return orphanedHelperSweep;
}

async function sweepOrphanedCoreSimulatorHelpers(): Promise<void> {
  const binaryPath = join(
    tmpdir(),
    'jean-claude-mobile-preview',
    CORE_SIMULATOR_HELPER_BINARY,
  );
  const { stdout } = await runCommand('ps', ['-axo', 'pid=,ppid=,command='], {
    timeoutMs: 5_000,
  });
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, pid, ppid, command] = match;
    if (ppid !== '1' || !command.startsWith(binaryPath)) continue;
    debug('iOS preview killing orphaned framebuffer helper pid=%s', pid);
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      // Process already gone.
    }
  }
}

export async function buildCoreSimulatorFramebufferHelper(
  signal: AbortSignal,
): Promise<string> {
  const sourcePath = await findCoreSimulatorHelperSource();
  signal.throwIfAborted();
  const developerDir = await getXcodeDeveloperDir(signal);
  signal.throwIfAborted();
  const outputDir = join(tmpdir(), 'jean-claude-mobile-preview');
  const outputPath = join(outputDir, CORE_SIMULATOR_HELPER_BINARY);
  await mkdir(outputDir, { recursive: true });
  await killOrphanedCoreSimulatorHelpers();
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

export async function getXcodeDeveloperDir(signal?: AbortSignal): Promise<string> {
  if (process.env.DEVELOPER_DIR) {
    return process.env.DEVELOPER_DIR;
  }

  const { stdout } = await runCommand('xcode-select', ['-p'], {
    signal,
    timeoutMs: 5_000,
  });
  return stdout.trim();
}

export function createScreenshotStream(
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

export async function createCoreSimulatorFramebufferStream(
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
        if (isIosPreviewDisposed()) {
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
      if (active.stopped || isIosPreviewDisposed()) return;
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
      if (active.stopped || isIosPreviewDisposed()) return;
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

export async function getRawStreamSize(
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

export function createRawRgbaFrameParser({
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
