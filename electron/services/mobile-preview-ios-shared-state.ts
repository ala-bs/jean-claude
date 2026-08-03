import type {
  MobilePreviewDevice,
  MobilePreviewQuality,
  MobilePreviewSession,
} from '../../shared/mobile-simulator-types';

import type { spawnManaged } from './mobile-preview-process';

import { dbg } from '../lib/debug';

export const debug = dbg.mobilePreview;

export const MAX_STREAM_STDERR_BYTES = 8 * 1024;

export function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

export function appendBoundedText(current: string, chunk: Buffer): string {
  const next = current + chunk.toString();
  if (next.length <= MAX_STREAM_STDERR_BYTES) return next;
  return next.slice(-MAX_STREAM_STDERR_BYTES);
}

export function waitForSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
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

export type RawStreamSize = {
  width: number;
  height: number;
  density?: number;
  widthPoints?: number;
  heightPoints?: number;
  source: 'idb-describe' | 'simctl-screenshot';
};

export type IosHidHelper = {
  stream: ReturnType<typeof spawnManaged>;
  ready: Promise<void>;
  isClosed: () => boolean;
};

export type CoreSimulatorActiveStream = {
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

export type CoreSimulatorPoolEntry = {
  key: string;
  deviceId: string;
  stream: ReturnType<typeof spawnManaged>;
  parseFrames: (chunk: Buffer) => void;
  consumers: Map<string, CoreSimulatorActiveStream>;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  recentStderr: string;
};

// Shared mutable state. This module is the single owner; every other iOS
// preview module reads and writes through these bindings so the adapter,
// input, and framebuffer layers observe the same lifecycle.
export const inputScreenDimensionsByDeviceId = new Map<string, RawStreamSize>();
export const pendingIosSimulatorBootsByDeviceId = new Map<
  string,
  {
    promise: Promise<MobilePreviewDevice>;
    abortController: AbortController;
    waiters: Set<symbol>;
  }
>();
export const activeIosSessionIds = new Set<string>();
export const activeHidHelpersByDeviceId = new Map<string, IosHidHelper>();
export const pendingHidHelpersByDeviceId = new Map<
  string,
  Promise<IosHidHelper>
>();
export const iosTouchInputQueues = new Map<string, Promise<void>>();
export const iosInputErrorByDeviceId = new Map<string, string>();
export const activeIosTouchesByDeviceId = new Map<
  string,
  { sessionId?: string; x: number; y: number }
>();
export const hidHelperReferenceCountsByDeviceId = new Map<string, number>();
export const fallbackTouchesByDeviceId = new Map<
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
export const coreSimulatorPool = new Map<string, CoreSimulatorPoolEntry>();
export const pendingCoreSimulatorPoolEntries = new Map<
  string,
  {
    abortController: AbortController;
    promise: Promise<CoreSimulatorPoolEntry>;
    waiters: Set<symbol>;
  }
>();
export const activeScreenshotStreamStops = new Set<() => Promise<void>>();
export const activeCoreSimulatorStreamStops = new Set<() => Promise<void>>();
export const activeIosNonTouchInputs = new Set<{
  sessionId?: string;
  controller: AbortController;
  promise: Promise<void>;
}>();

let iosPreviewDisposed = false;
let iosInputGeneration = 0;
let iosKeyboardInputQueue = Promise.resolve();

export function isIosPreviewDisposed(): boolean {
  return iosPreviewDisposed;
}

export function setIosPreviewDisposed(disposed: boolean): void {
  iosPreviewDisposed = disposed;
}

export function getIosInputGeneration(): number {
  return iosInputGeneration;
}

export function bumpIosInputGeneration(): void {
  iosInputGeneration += 1;
}

export function getIosKeyboardInputQueue(): Promise<void> {
  return iosKeyboardInputQueue;
}

export function setIosKeyboardInputQueue(queue: Promise<void>): void {
  iosKeyboardInputQueue = queue;
}
