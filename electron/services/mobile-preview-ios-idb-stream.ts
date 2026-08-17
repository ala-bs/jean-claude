import type {
  MobilePreviewQuality,
  MobilePreviewSession,
} from '../../shared/mobile-simulator-types';

import { appendBoundedText, debug } from './mobile-preview-ios-shared-state';
import {
  buildStartStreamArgs,
  captureSimulatorScreenshot,
  createRawRgbaFrameParser,
  describeChunk,
  FIRST_FRAME_TIMEOUT_MS,
  formatStreamExitError,
  getRawStreamSize,
  SCREENSHOT_POLL_INTERVAL_MS,
} from './mobile-preview-ios-framebuffer';
import {
  prewarmIosHidInput,
  releaseIosHidHelper,
  retainIosHidHelper,
} from './mobile-preview-ios-hid-input';
import { randomUUID } from 'node:crypto';
import { spawnManaged } from './mobile-preview-process';

/**
 * Legacy raw `idb video-stream` capture path, used when
 * JC_MOBILE_PREVIEW_IOS_RAW_STREAM=1. Falls back to simctl screenshots when
 * idb produces no frames.
 */
export async function createIdbRawVideoStream(params: {
  taskId: string;
  deviceId: string;
  fps?: number;
  quality?: MobilePreviewQuality;
  signal?: AbortSignal;
  onFrame: (frame: Buffer) => void;
  onSession: (patch: Partial<MobilePreviewSession>) => void;
}): Promise<{ session: MobilePreviewSession; stop: () => Promise<void> }> {
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

  return {
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
  };
}
