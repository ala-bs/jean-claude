import { app, BrowserWindow, type WebContents } from 'electron';

import {
  MOBILE_PREVIEW_H264_REPLAY_CHUNK_LIMIT,
  MOBILE_PREVIEW_REPLAY_BYTE_LIMIT,
  type MobileColorScheme,
  type MobilePlatform,
  type MobilePreviewAndroidCreateDeviceParams,
  type MobilePreviewAndroidDeviceProfile,
  type MobilePreviewAndroidInstallSystemImageParams,
  type MobilePreviewAndroidSystemImage,
  type MobilePreviewAndroidToolStatus,
  type MobilePreviewAttachSessionParams,
  type MobilePreviewDetachSessionParams,
  type MobilePreviewDevice,
  type MobilePreviewDeviceAssignment,
  type MobilePreviewForwardPortParams,
  type MobilePreviewFrameEvent,
  type MobilePreviewInputEvent,
  type MobilePreviewIosCreateDeviceParams,
  type MobilePreviewIosDeviceType,
  type MobilePreviewIosRenameDeviceParams,
  type MobilePreviewIosRuntime,
  type MobilePreviewIosToolStatus,
  type MobilePreviewListSessionsParams,
  type MobilePreviewOpenDeeplinkParams,
  type MobilePreviewOpenDevMenuParams,
  type MobilePreviewReloadExpoParams,
  type MobilePreviewSession,
  type MobilePreviewSetTextSizeParams,
  type MobilePreviewStartParams,
  type MobileRotationDirection,
} from '../../shared/mobile-simulator-types';

import {
  disposeReactNativeDevToolsForSession,
  disposeReactNativeDevToolsForTask,
} from './mobile-preview-react-native-devtools-service';
import {
  MobilePreviewDeviceUsageRepository,
  TaskRepository,
} from '../database/repositories';
import {
  type MobilePreviewLifecycle,
  registerBeforeQuitCleanup,
} from './mobile-preview-lifecycle';
import {
  sendMetroDevMenuCommand,
  sendMetroReloadCommand,
} from './mobile-preview-dev-menu';
import { androidAdapter } from './mobile-preview-android-adapter';
import { iosIdbAdapter } from './mobile-preview-ios-idb-adapter';

type MobilePreviewAdapter = {
  dispose?: () => Promise<void>;
  listDevices: () => Promise<MobilePreviewDevice[]>;
  startStream: (params: {
    taskId: string;
    deviceId: string;
    signal: AbortSignal;
    fps?: number;
    quality?: MobilePreviewStartParams['quality'];
    onFrame: (frame: MobilePreviewFramePayload) => void;
    onSession: (patch: Partial<MobilePreviewSession>) => void;
  }) => Promise<{ session: MobilePreviewSession; stop: () => Promise<void> }>;
  sendInput: (
    deviceId: string,
    event: MobilePreviewInputEvent,
    sessionId?: string,
  ) => Promise<void>;
  openDeeplink: (
    deviceId: string,
    url: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  openDevMenu?: (deviceId: string) => Promise<void>;
  forwardPort?: (params: {
    deviceId: string;
    hostPort: number;
    devicePort: number;
  }) => Promise<void>;
  setTextSize: (
    deviceId: string,
    size: MobilePreviewSetTextSizeParams['size'],
  ) => Promise<void>;
  setColorScheme: (
    deviceId: string,
    scheme: MobileColorScheme,
  ) => Promise<void>;
  rotate: (
    deviceId: string,
    direction: MobileRotationDirection,
  ) => Promise<void>;
  getAndroidToolStatus?: () => Promise<MobilePreviewAndroidToolStatus>;
  listAndroidDeviceProfiles?: () => Promise<
    MobilePreviewAndroidDeviceProfile[]
  >;
  listAndroidSystemImages?: () => Promise<MobilePreviewAndroidSystemImage[]>;
  createAndroidDevice?: (
    params: MobilePreviewAndroidCreateDeviceParams,
  ) => Promise<void>;
  deleteAndroidDevice?: (name: string) => Promise<void>;
  installAndroidSystemImage?: (
    params: MobilePreviewAndroidInstallSystemImageParams,
  ) => Promise<void>;
  getIosToolStatus?: () => Promise<MobilePreviewIosToolStatus>;
  listIosRuntimes?: () => Promise<MobilePreviewIosRuntime[]>;
  listIosDeviceTypes?: () => Promise<MobilePreviewIosDeviceType[]>;
  createIosDevice?: (
    params: MobilePreviewIosCreateDeviceParams,
  ) => Promise<string>;
  deleteIosDevice?: (deviceId: string) => Promise<void>;
  eraseIosDevice?: (deviceId: string) => Promise<void>;
  renameIosDevice?: (params: MobilePreviewIosRenameDeviceParams) => Promise<void>;
};

type MobilePreviewFramePayload =
  | Buffer
  | {
      data: Buffer;
      h264PacketType: 'configuration' | 'data';
      keyframe?: boolean;
    };

type ActiveSession = {
  session: MobilePreviewSession;
  stop: () => Promise<void>;
  platform: MobilePlatform;
  deviceId: string;
  webContents?: WebContents;
  delivery: 'broadcast' | 'attached' | 'detached';
  replay: {
    latestFrame?: ReplayFrame;
    h264Configuration?: ReplayFrame;
    h264Packets: ReplayFrame[];
    h264Overflowed: boolean;
  };
};

type ReplayFrame = {
  event: MobilePreviewFrameEvent;
  byteLength: number;
};

type MobilePreviewEmitter = {
  sendToWebContents: (
    webContents: WebContents,
    channel: string,
    payload: unknown,
  ) => void;
  sendToAllWindows: (channel: string, payload: unknown) => void;
};

/**
 * Persistence for the "last task that used this device" association shown in
 * the device rail. Injected so the service stays testable without a database.
 */
export type MobilePreviewDeviceUsageStore = {
  list: () => Promise<
    Array<{
      platform: MobilePlatform;
      deviceId: string;
      taskId: string;
      lastUsedAt: string;
    }>
  >;
  record: (params: {
    platform: MobilePlatform;
    deviceId: string;
    taskId: string;
  }) => Promise<void>;
};

function createInMemoryDeviceUsageStore(): MobilePreviewDeviceUsageStore {
  const usage = new Map<
    string,
    {
      platform: MobilePlatform;
      deviceId: string;
      taskId: string;
      lastUsedAt: string;
    }
  >();
  return {
    list: async () => Array.from(usage.values()),
    record: async ({ platform, deviceId, taskId }) => {
      usage.set(`${platform}:${deviceId}`, {
        platform,
        deviceId,
        taskId,
        lastUsedAt: new Date().toISOString(),
      });
    },
  };
}

type MobilePreviewServiceOptions = {
  adapters: Record<MobilePlatform, MobilePreviewAdapter>;
  emitter: MobilePreviewEmitter;
  lifecycle?: MobilePreviewLifecycle;
  logger?: Pick<typeof console, 'error'>;
  validateTaskCanStart: (taskId: string) => Promise<void>;
  deviceUsageStore?: MobilePreviewDeviceUsageStore;
};

type SenderAttachment = {
  sessionIds: Set<string>;
  onUnavailable: () => void;
};

const MAX_PENDING_FRAMES_BEFORE_SESSION =
  MOBILE_PREVIEW_H264_REPLAY_CHUNK_LIMIT;
export const MOBILE_PREVIEW_MAX_H264_REPLAY_PACKETS =
  MOBILE_PREVIEW_H264_REPLAY_CHUNK_LIMIT - 1;
export const MOBILE_PREVIEW_PENDING_START_TIMEOUT_MS = 5_000;

async function waitForPendingStarts(
  starts: Promise<MobilePreviewSession>[],
): Promise<PromiseSettledResult<MobilePreviewSession>[]> {
  if (starts.length === 0) return [];

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(
        new Error('Timed out waiting for mobile preview streams to start.'),
      );
    }, MOBILE_PREVIEW_PENDING_START_TIMEOUT_MS);
  });

  try {
    return await Promise.race([Promise.allSettled(starts), timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
}

function assertSupportedPlatform(
  platform: unknown,
): asserts platform is MobilePlatform {
  if (platform !== 'ios' && platform !== 'android') {
    throw new Error(`Unsupported mobile preview platform: ${String(platform)}`);
  }
}

function assertSupportedColorScheme(
  scheme: unknown,
): asserts scheme is MobileColorScheme {
  if (scheme !== 'light' && scheme !== 'dark') {
    throw new Error(
      `Unsupported mobile preview color scheme: ${String(scheme)}`,
    );
  }
}

function assertSupportedRotationDirection(
  direction: unknown,
): asserts direction is MobileRotationDirection {
  if (direction !== 'left' && direction !== 'right') {
    throw new Error(
      `Unsupported mobile preview rotation direction: ${String(direction)}`,
    );
  }
}

function isWebContentsDestroyed(webContents: WebContents): boolean {
  try {
    return webContents.isDestroyed?.() ?? false;
  } catch {
    return true;
  }
}

function getRequiredAndroidManagementMethod<Method extends keyof MobilePreviewAdapter>(
  adapter: MobilePreviewAdapter,
  method: Method,
): NonNullable<MobilePreviewAdapter[Method]> {
  const handler = adapter[method];
  if (!handler) {
    throw new Error('Android device management is unavailable.');
  }
  return handler as NonNullable<MobilePreviewAdapter[Method]>;
}

function getRequiredIosManagementMethod<Method extends keyof MobilePreviewAdapter>(
  adapter: MobilePreviewAdapter,
  method: Method,
): NonNullable<MobilePreviewAdapter[Method]> {
  const handler = adapter[method];
  if (!handler) {
    throw new Error('iOS simulator management is unavailable.');
  }
  return handler as NonNullable<MobilePreviewAdapter[Method]>;
}

export function createMobilePreviewService({
  adapters,
  emitter,
  lifecycle,
  logger = console,
  validateTaskCanStart,
  deviceUsageStore = createInMemoryDeviceUsageStore(),
}: MobilePreviewServiceOptions) {
  const sessions = new Map<string, ActiveSession>();
  const latestStartIdsByDevice = new Map<string, number>();
  const terminalTaskIds = new Set<string>();
  const taskGenerations = new Map<string, number>();
  const taskOperations = new Map<string, Promise<void>>();
  const pendingStarts = new Set<Promise<MobilePreviewSession>>();
  const pendingStartControllersByTask = new Map<
    string,
    Set<AbortController>
  >();
  const senderAttachments = new Map<WebContents, SenderAttachment>();
  let nextStartId = 0;
  let isShuttingDown = false;
  let stopAllPromise: Promise<void> | null = null;

  function getSessionDeviceKey(params: {
    taskId: string;
    platform: MobilePlatform;
    deviceId: string;
  }) {
    return `${params.taskId}:${params.platform}:${params.deviceId}`;
  }

  function getTaskGeneration(taskId: string): number {
    return taskGenerations.get(taskId) ?? 0;
  }

  function invalidateTaskStarts(taskId: string): number {
    const generation = getTaskGeneration(taskId) + 1;
    taskGenerations.set(taskId, generation);
    const taskPrefix = `${taskId}:`;
    latestStartIdsByDevice.forEach((_, deviceKey) => {
      if (deviceKey.startsWith(taskPrefix)) {
        latestStartIdsByDevice.delete(deviceKey);
      }
    });
    return generation;
  }

  function registerPendingStart(
    taskId: string,
    controller: AbortController,
  ): () => void {
    const controllers = pendingStartControllersByTask.get(taskId) ?? new Set();
    controllers.add(controller);
    pendingStartControllersByTask.set(taskId, controllers);
    return () => {
      controllers.delete(controller);
      if (controllers.size === 0) pendingStartControllersByTask.delete(taskId);
    };
  }

  function abortPendingStarts(taskId: string): void {
    pendingStartControllersByTask.get(taskId)?.forEach((controller) => {
      controller.abort(new DOMException('Task completed', 'AbortError'));
    });
  }

  function runTaskOperation<Result>(
    taskId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = taskOperations.get(taskId);
    const result = previous
      ? previous.catch(() => undefined).then(operation)
      : operation();
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    taskOperations.set(taskId, settled);
    void settled.then(() => {
      if (taskOperations.get(taskId) === settled) taskOperations.delete(taskId);
    });
    return result;
  }

  function detachWebContents(
    activeSession: ActiveSession,
    expectedWebContents?: WebContents,
  ) {
    if (
      expectedWebContents &&
      activeSession.webContents !== expectedWebContents
    ) {
      return;
    }
    const webContents = activeSession.webContents;
    if (!webContents) return;

    activeSession.webContents = undefined;
    activeSession.delivery = 'detached';
    const attachment = senderAttachments.get(webContents);
    if (!attachment) return;

    attachment.sessionIds.delete(activeSession.session.id);
    if (attachment.sessionIds.size > 0) return;

    webContents.removeListener?.('destroyed', attachment.onUnavailable);
    webContents.removeListener?.('render-process-gone', attachment.onUnavailable);
    senderAttachments.delete(webContents);
  }

  function attachWebContents(
    activeSession: ActiveSession,
    webContents: WebContents,
  ) {
    detachWebContents(activeSession);
    activeSession.webContents = webContents;
    activeSession.delivery = 'attached';
    let attachment = senderAttachments.get(webContents);
    if (!attachment) {
      const onUnavailable = () => {
        const currentAttachment = senderAttachments.get(webContents);
        if (!currentAttachment) return;

        Array.from(currentAttachment.sessionIds).forEach((sessionId) => {
          const attachedSession = sessions.get(sessionId);
          if (attachedSession?.webContents === webContents) {
            attachedSession.webContents = undefined;
            attachedSession.delivery = 'detached';
          }
        });
        webContents.removeListener?.('destroyed', onUnavailable);
        webContents.removeListener?.('render-process-gone', onUnavailable);
        senderAttachments.delete(webContents);
      };
      attachment = { sessionIds: new Set(), onUnavailable };
      senderAttachments.set(webContents, attachment);
      webContents.once?.('destroyed', onUnavailable);
      webContents.once?.('render-process-gone', onUnavailable);
    }
    attachment.sessionIds.add(activeSession.session.id);
  }

  function sendToSession(
    activeSession: ActiveSession,
    channel: string,
    payload: unknown,
  ) {
    const webContents = activeSession.webContents;
    if (!webContents) {
      if (activeSession.delivery === 'broadcast') {
        emitter.sendToAllWindows(channel, payload);
      }
      return;
    }

    try {
      if (isWebContentsDestroyed(webContents)) {
        detachWebContents(activeSession, webContents);
        return;
      }
      emitter.sendToWebContents(webContents, channel, payload);
    } catch (error) {
      if (isWebContentsDestroyed(webContents)) {
        detachWebContents(activeSession, webContents);
        return;
      }
      logger.error('Failed to send mobile preview event:', error);
    }
  }

  function toReplayFrame(
    sessionId: string,
    frame: MobilePreviewFramePayload,
  ): ReplayFrame {
    const frameData = Buffer.isBuffer(frame) ? frame : frame.data;
    const event: MobilePreviewFrameEvent = {
      sessionId,
      frameBase64: frameData.toString('base64'),
    };
    if (!Buffer.isBuffer(frame)) {
      event.h264PacketType = frame.h264PacketType;
      event.keyframe = frame.keyframe;
    }
    return { event, byteLength: event.frameBase64.length };
  }

  function cacheFrame(
    activeSession: ActiveSession,
    frame: ReplayFrame,
  ) {
    const replay = activeSession.replay;
    if (
      activeSession.session.frameFormat !== 'h264' &&
      frame.event.h264PacketType === undefined
    ) {
      replay.latestFrame =
        frame.byteLength <= MOBILE_PREVIEW_REPLAY_BYTE_LIMIT ? frame : undefined;
      replay.h264Configuration = undefined;
      replay.h264Packets = [];
      replay.h264Overflowed = false;
      return;
    }

    if (frame.event.h264PacketType === 'configuration') {
      replay.latestFrame = undefined;
      replay.h264Configuration =
        frame.byteLength <= MOBILE_PREVIEW_REPLAY_BYTE_LIMIT ? frame : undefined;
      replay.h264Packets = [];
      replay.h264Overflowed = false;
      return;
    }
    if (frame.event.h264PacketType !== 'data') return;

    if (frame.event.keyframe) {
      const configurationBytes = replay.h264Configuration?.byteLength ?? 0;
      replay.h264Packets =
        configurationBytes + frame.byteLength <= MOBILE_PREVIEW_REPLAY_BYTE_LIMIT
          ? [frame]
          : [];
      replay.h264Overflowed = false;
      return;
    }
    if (replay.h264Packets.length === 0 || replay.h264Overflowed) return;
    const replayBytes =
      (replay.h264Configuration?.byteLength ?? 0) +
      replay.h264Packets.reduce((total, packet) => total + packet.byteLength, 0);
    if (
      replay.h264Packets.length >= MOBILE_PREVIEW_MAX_H264_REPLAY_PACKETS ||
      replayBytes + frame.byteLength > MOBILE_PREVIEW_REPLAY_BYTE_LIMIT
    ) {
      // Preserve decoder bootstrap; discard deltas until next keyframe.
      replay.h264Packets = replay.h264Packets.slice(0, 1);
      replay.h264Overflowed = true;
      return;
    }
    replay.h264Packets.push(frame);
  }

  const service = {
    async listDevices(
      platform: MobilePlatform,
    ): Promise<MobilePreviewDevice[]> {
      assertSupportedPlatform(platform);
      return adapters[platform].listDevices();
    },

    listSessions(
      params: MobilePreviewListSessionsParams,
    ): MobilePreviewSession[] {
      return Array.from(sessions.values())
        .map((activeSession) => activeSession.session)
        .filter(
          (session) =>
            session.status !== 'stopped' &&
            session.taskId === params.taskId,
        );
    },

    /**
     * Device -> task associations across every task, for the device rail.
     *
     * A live session always wins over the persisted "last used" row, so a
     * device that is currently streaming is attributed to the task streaming
     * on it rather than to whoever used it previously.
     */
    async listDeviceAssignments(): Promise<MobilePreviewDeviceAssignment[]> {
      const assignments = new Map<string, MobilePreviewDeviceAssignment>();

      const usageRows = await deviceUsageStore.list().catch((error) => {
        logger.error('Failed to list mobile preview device usage', error);
        return [];
      });
      usageRows.forEach((row) => {
        // The column is TEXT; the Kysely type is a compile-time assertion only.
        // Drop anything that is not a platform this build understands rather
        // than forwarding it across IPC to renderer code that switches on it.
        if (row.platform !== 'ios' && row.platform !== 'android') return;
        assignments.set(`${row.platform}:${row.deviceId}`, {
          platform: row.platform,
          deviceId: row.deviceId,
          taskId: row.taskId,
          isActive: false,
          status: null,
          lastUsedAt: row.lastUsedAt,
        });
      });

      Array.from(sessions.values()).forEach((activeSession) => {
        const { session } = activeSession;
        if (session.status === 'stopped') return;
        const deviceKey = `${activeSession.platform}:${activeSession.deviceId}`;
        assignments.set(deviceKey, {
          platform: activeSession.platform,
          deviceId: activeSession.deviceId,
          taskId: session.taskId,
          isActive: true,
          status: session.status,
          lastUsedAt: assignments.get(deviceKey)?.lastUsedAt ?? null,
        });
      });

      return Array.from(assignments.values());
    },

    async attachSession(
      params: MobilePreviewAttachSessionParams,
      webContents: WebContents,
    ): Promise<MobilePreviewSession> {
      const activeSession = sessions.get(params.sessionId);
      if (
        !activeSession ||
        activeSession.session.taskId !== params.taskId ||
        activeSession.session.status === 'stopped'
      ) {
        throw new Error(`Mobile preview session not found: ${params.sessionId}`);
      }

      if (isWebContentsDestroyed(webContents)) return activeSession.session;
      const attachedWebContents = activeSession.webContents;
      // Renderer is trusted, but one live renderer cannot steal another's stream.
      if (
        attachedWebContents &&
        attachedWebContents !== webContents &&
        !isWebContentsDestroyed(attachedWebContents)
      ) {
        throw new Error('Mobile preview session is attached to another renderer.');
      }
      if (attachedWebContents !== webContents) {
        attachWebContents(activeSession, webContents);
      }
      sendToSession(activeSession, 'mobilePreview:session', {
        session: activeSession.session,
      });
      if (activeSession.replay.latestFrame) {
        sendToSession(
          activeSession,
          'mobilePreview:frame',
          activeSession.replay.latestFrame.event,
        );
      } else {
        if (activeSession.replay.h264Configuration) {
          sendToSession(
            activeSession,
            'mobilePreview:frame',
            activeSession.replay.h264Configuration.event,
          );
        }
        activeSession.replay.h264Packets.forEach((frame) => {
          sendToSession(activeSession, 'mobilePreview:frame', frame.event);
        });
      }
      return activeSession.session;
    },

    async detachSession(
      params: MobilePreviewDetachSessionParams,
      webContents: WebContents,
    ): Promise<void> {
      const activeSession = sessions.get(params.sessionId);
      if (
        !activeSession ||
        activeSession.session.taskId !== params.taskId ||
        activeSession.session.status === 'stopped'
      ) {
        throw new Error(`Mobile preview session not found: ${params.sessionId}`);
      }

      if (!activeSession.webContents) {
        if (activeSession.delivery === 'detached') return;
        throw new Error('Mobile preview session is attached to another renderer.');
      }
      if (activeSession.webContents !== webContents) {
        throw new Error('Mobile preview session is attached to another renderer.');
      }
      detachWebContents(activeSession, webContents);
    },

    async getAndroidToolStatus(): Promise<MobilePreviewAndroidToolStatus> {
      return getRequiredAndroidManagementMethod(
        adapters.android,
        'getAndroidToolStatus',
      )();
    },

    async listAndroidDeviceProfiles(): Promise<
      MobilePreviewAndroidDeviceProfile[]
    > {
      return getRequiredAndroidManagementMethod(
        adapters.android,
        'listAndroidDeviceProfiles',
      )();
    },

    async listAndroidSystemImages(): Promise<
      MobilePreviewAndroidSystemImage[]
    > {
      return getRequiredAndroidManagementMethod(
        adapters.android,
        'listAndroidSystemImages',
      )();
    },

    async createAndroidDevice(
      params: MobilePreviewAndroidCreateDeviceParams,
    ): Promise<void> {
      await getRequiredAndroidManagementMethod(
        adapters.android,
        'createAndroidDevice',
      )(params);
    },

    async deleteAndroidDevice(name: string): Promise<void> {
      await getRequiredAndroidManagementMethod(
        adapters.android,
        'deleteAndroidDevice',
      )(name);
    },

    async installAndroidSystemImage(
      params: MobilePreviewAndroidInstallSystemImageParams,
    ): Promise<void> {
      await getRequiredAndroidManagementMethod(
        adapters.android,
        'installAndroidSystemImage',
      )(params);
    },

    async getIosToolStatus(): Promise<MobilePreviewIosToolStatus> {
      return getRequiredIosManagementMethod(
        adapters.ios,
        'getIosToolStatus',
      )();
    },

    async listIosRuntimes(): Promise<MobilePreviewIosRuntime[]> {
      return getRequiredIosManagementMethod(
        adapters.ios,
        'listIosRuntimes',
      )();
    },

    async listIosDeviceTypes(): Promise<MobilePreviewIosDeviceType[]> {
      return getRequiredIosManagementMethod(
        adapters.ios,
        'listIosDeviceTypes',
      )();
    },

    async createIosDevice(
      params: MobilePreviewIosCreateDeviceParams,
    ): Promise<string> {
      return getRequiredIosManagementMethod(
        adapters.ios,
        'createIosDevice',
      )(params);
    },

    async deleteIosDevice(deviceId: string): Promise<void> {
      await getRequiredIosManagementMethod(
        adapters.ios,
        'deleteIosDevice',
      )(deviceId);
    },

    async eraseIosDevice(deviceId: string): Promise<void> {
      await getRequiredIosManagementMethod(
        adapters.ios,
        'eraseIosDevice',
      )(deviceId);
    },

    async renameIosDevice(
      params: MobilePreviewIosRenameDeviceParams,
    ): Promise<void> {
      await getRequiredIosManagementMethod(
        adapters.ios,
        'renameIosDevice',
      )(params);
    },

    start(
      params: MobilePreviewStartParams,
      webContents?: WebContents,
    ): Promise<MobilePreviewSession> {
      if (isShuttingDown) {
        return Promise.reject(new Error('Mobile preview service is shutting down.'));
      }

      const startId = ++nextStartId;
      const deviceKey = getSessionDeviceKey(params);
      const taskGeneration = getTaskGeneration(params.taskId);
      const startController = new AbortController();
      const unregisterPendingStart = registerPendingStart(
        params.taskId,
        startController,
      );
      latestStartIdsByDevice.set(deviceKey, startId);
      const isCurrentStart = () =>
        !isShuttingDown &&
        !terminalTaskIds.has(params.taskId) &&
        getTaskGeneration(params.taskId) === taskGeneration &&
        latestStartIdsByDevice.get(deviceKey) === startId;
      const assertCurrentStart = () => {
        if (isCurrentStart()) return;
        if (terminalTaskIds.has(params.taskId)) {
          throw new Error(`Mobile preview task is completed: ${params.taskId}`);
        }
        throw new Error(`Mobile preview start was superseded: ${params.taskId}`);
      };

      const start = (async () => {
        assertSupportedPlatform(params.platform);
        await validateTaskCanStart(params.taskId);
        assertCurrentStart();
        const existingSession = Array.from(sessions.values()).find(
          (active) =>
            active.session.taskId === params.taskId &&
            active.session.platform === params.platform &&
            active.session.deviceId === params.deviceId,
        );
        if (existingSession) {
          await service.stop(existingSession.session.id);
          assertCurrentStart();
        }

        let activeSession: ActiveSession | null = null;
        const pendingFrames: MobilePreviewFramePayload[] = [];
        const pendingSessionPatches: Array<Partial<MobilePreviewSession>> = [];
        const sendFrame = (frame: MobilePreviewFramePayload) => {
          if (!activeSession || !sessions.has(activeSession.session.id)) return;
          const replayFrame = toReplayFrame(activeSession.session.id, frame);
          cacheFrame(activeSession, replayFrame);
          sendToSession(activeSession, 'mobilePreview:frame', replayFrame.event);
        };
        const { session, stop } = await adapters[params.platform].startStream({
          taskId: params.taskId,
          deviceId: params.deviceId,
          signal: startController.signal,
          fps: params.fps,
          quality: params.quality,
          onFrame: (frame) => {
            if (!activeSession) {
              if (pendingFrames.length < MAX_PENDING_FRAMES_BEFORE_SESSION) {
                pendingFrames.push(frame);
              }
              return;
            }
            sendFrame(frame);
          },
          onSession: (patch) => {
            if (!activeSession) {
              pendingSessionPatches.push(patch);
              return;
            }
            const current = sessions.get(activeSession.session.id);
            if (!current) return;

            const nextSession = { ...current.session, ...patch };
            current.session = nextSession;
            activeSession = current;
            sendToSession(current, 'mobilePreview:session', {
              session: nextSession,
            });
          },
        });

        if (!isCurrentStart()) {
          await stop();
          return { ...session, status: 'stopped' as const };
        }

        const nextSession = pendingSessionPatches.reduce<MobilePreviewSession>(
          (currentSession, patch) => ({ ...currentSession, ...patch }),
          session,
        );
        const nextActiveSession: ActiveSession = {
          session: nextSession,
          stop,
          platform: params.platform,
          deviceId: nextSession.deviceId,
          delivery: webContents ? 'attached' : 'broadcast',
          replay: {
            h264Packets: [],
            h264Overflowed: false,
          },
        };
        activeSession = nextActiveSession;
        sessions.set(session.id, nextActiveSession);
        // Remember the association so the device rail can still attribute this
        // device to a task once the session ends. Never fail a start over it.
        void deviceUsageStore
          .record({
            platform: params.platform,
            deviceId: nextSession.deviceId,
            taskId: nextSession.taskId,
          })
          .catch((error) => {
            logger.error('Failed to record mobile preview device usage', error);
          });
        if (webContents && !isWebContentsDestroyed(webContents)) {
          attachWebContents(nextActiveSession, webContents);
        }
        sendToSession(nextActiveSession, 'mobilePreview:session', {
          session: nextActiveSession.session,
        });
        pendingFrames.splice(0).forEach(sendFrame);

        return nextActiveSession.session;
      })().finally(unregisterPendingStart);

      pendingStarts.add(start);
      const finishStart = () => {
        pendingStarts.delete(start);
      };
      void start.then(
        finishStart,
        finishStart,
      );
      return start;
    },

    async stop(sessionId: string): Promise<void> {
      const activeSession = sessions.get(sessionId);
      if (!activeSession) return;

      sessions.delete(sessionId);
      // The embedded DevTools view outlives the preview pane closing so its
      // console/network history survives; stopping the preview is the point
      // where the debug target is really gone, so tear it down here. Scoped to
      // this session's device: a task can preview several devices at once, and
      // each has its own view.
      disposeReactNativeDevToolsForSession({
        taskId: activeSession.session.taskId,
        platform: activeSession.session.platform,
        deviceId: activeSession.session.deviceId,
      });
      try {
        await activeSession.stop();
      } finally {
        const stoppedSession: MobilePreviewSession = {
          ...activeSession.session,
          status: 'stopped',
        };
        sendToSession(activeSession, 'mobilePreview:session', {
          session: stoppedSession,
        });
        detachWebContents(activeSession);
      }
    },

    stopByTask(taskId: string): Promise<void> {
      terminalTaskIds.add(taskId);
      // Also covers the case where the preview was already stopped but the
      // DevTools view was intentionally kept alive for its history.
      disposeReactNativeDevToolsForTask(taskId);
      invalidateTaskStarts(taskId);
      abortPendingStarts(taskId);
      const activeSessions = Array.from(sessions.values()).filter(
        (activeSession) => activeSession.session.taskId === taskId,
      );
      activeSessions.forEach((activeSession) => {
        detachWebContents(activeSession);
      });
      const stops = activeSessions.map((activeSession) =>
        service.stop(activeSession.session.id),
      );
      const stoppingSessions = Promise.all(stops);
      void stoppingSessions.catch(() => undefined);

      return runTaskOperation(taskId, async () => {
        await stoppingSessions;
      });
    },

    resetTaskAfterReactivation(taskId: string): Promise<void> {
      // Task was never marked terminal: nothing to reactivate, and any
      // currently running preview must be left untouched.
      if (!terminalTaskIds.has(taskId)) return Promise.resolve();
      const resetGeneration = invalidateTaskStarts(taskId);
      return runTaskOperation(taskId, async () => {
        if (getTaskGeneration(taskId) !== resetGeneration) return;
        const hasActiveSession = Array.from(sessions.values()).some(
          (activeSession) => activeSession.session.taskId === taskId,
        );
        if (hasActiveSession) {
          throw new Error(`Cannot reactivate task with active preview: ${taskId}`);
        }
        terminalTaskIds.delete(taskId);
      });
    },

    async sendInput(
      sessionId: string,
      event: MobilePreviewInputEvent,
    ): Promise<void> {
      const activeSession = sessions.get(sessionId);
      if (!activeSession) {
        throw new Error(`Mobile preview session not found: ${sessionId}`);
      }

      await adapters[activeSession.platform].sendInput(
        activeSession.deviceId,
        event,
        activeSession.session.id,
      );
    },

    async openDeeplink(
      params: MobilePreviewOpenDeeplinkParams,
      options?: { signal?: AbortSignal },
    ): Promise<void> {
      assertSupportedPlatform(params.platform);
      options?.signal?.throwIfAborted();
      await adapters[params.platform].openDeeplink(
        params.deviceId,
        params.url,
        options?.signal,
      );
    },

    async openDevMenu(
      params: MobilePreviewOpenDevMenuParams,
    ): Promise<void> {
      assertSupportedPlatform(params.platform);
      try {
        await sendMetroDevMenuCommand(params.metroPort);
        return;
      } catch (error) {
        // Metro may not be reachable (proxied port, app not connected).
        // Android can still trigger the menu straight on the device.
        const openDevMenu = adapters[params.platform].openDevMenu;
        if (!openDevMenu) throw error;
        await openDevMenu(params.deviceId);
      }
    },

    async reloadExpo(params: MobilePreviewReloadExpoParams): Promise<void> {
      await sendMetroReloadCommand(params.metroPort);
    },

    async forwardPort(params: MobilePreviewForwardPortParams): Promise<void> {
      assertSupportedPlatform(params.platform);
      const forwardPort = adapters[params.platform].forwardPort;
      if (!forwardPort) {
        throw new Error(
          'Port forwarding is only supported for Android devices',
        );
      }

      await forwardPort(params);
    },

    async setTextSize(params: MobilePreviewSetTextSizeParams): Promise<void> {
      assertSupportedPlatform(params.platform);
      await adapters[params.platform].setTextSize(params.deviceId, params.size);
    },

    async setColorScheme(
      sessionId: string,
      scheme: MobileColorScheme,
    ): Promise<void> {
      assertSupportedColorScheme(scheme);
      const activeSession = sessions.get(sessionId);
      if (!activeSession) {
        throw new Error(`Mobile preview session not found: ${sessionId}`);
      }

      await adapters[activeSession.platform].setColorScheme(
        activeSession.deviceId,
        scheme,
      );
    },

    async rotate(
      sessionId: string,
      direction: MobileRotationDirection,
    ): Promise<void> {
      assertSupportedRotationDirection(direction);
      const activeSession = sessions.get(sessionId);
      if (!activeSession) {
        throw new Error(`Mobile preview session not found: ${sessionId}`);
      }

      await adapters[activeSession.platform].rotate(
        activeSession.deviceId,
        direction,
      );
    },

    stopAll(): Promise<void> {
      if (stopAllPromise) return stopAllPromise;

      isShuttingDown = true;
      pendingStartControllersByTask.forEach((_, taskId) => {
        abortPendingStarts(taskId);
      });
      stopAllPromise = Promise.resolve().then(async () => {
        const errors: unknown[] = [];
        const disposeResultsPromise = Promise.allSettled(
          Array.from(new Set(Object.values(adapters))).map(async (adapter) =>
            adapter.dispose?.(),
          ),
        );
        let startResults: PromiseSettledResult<MobilePreviewSession>[] = [];
        try {
          startResults = await waitForPendingStarts(Array.from(pendingStarts));
        } catch (error) {
          errors.push(error);
        }
        const stopResults = await Promise.allSettled(
          Array.from(sessions.keys()).map((id) => service.stop(id)),
        );
        const disposeResults = await disposeResultsPromise;

        errors.push(
          ...[...startResults, ...stopResults, ...disposeResults].flatMap(
            (result) =>
              result.status === 'rejected' ? [result.reason] : [],
          ),
        );
        if (errors.length > 0) {
          throw new AggregateError(
            errors,
            'Failed to stop all mobile previews.',
          );
        }
      });
      return stopAllPromise;
    },

    getActiveSession(sessionId: string): MobilePreviewSession | null {
      return sessions.get(sessionId)?.session ?? null;
    },
  };

  if (lifecycle) {
    registerBeforeQuitCleanup({
      cleanup: service.stopAll,
      lifecycle,
      logger,
    });
  }

  return service;
}

export async function validatePersistedMobilePreviewTaskCanStart(
  taskId: string,
): Promise<void> {
  const task = await TaskRepository.findById(taskId);
  if (!task) {
    throw new Error(`Mobile preview task not found: ${taskId}`);
  }
  if (task.userCompleted) {
    throw new Error(`Mobile preview task is completed: ${taskId}`);
  }
}

export const mobilePreviewService = createMobilePreviewService({
  adapters: {
    ios: iosIdbAdapter,
    android: androidAdapter,
  },
  emitter: {
    sendToWebContents: (webContents, channel, payload) => {
      if (webContents.isDestroyed()) return;
      webContents.send(channel, payload);
    },
    sendToAllWindows: (channel, payload) => {
      BrowserWindow.getAllWindows().forEach((window) => {
        if (window.webContents.isDestroyed()) return;
        window.webContents.send(channel, payload);
      });
    },
  },
  lifecycle: {
    onBeforeQuit: (callback) => app.on('before-quit', callback),
  },
  validateTaskCanStart: validatePersistedMobilePreviewTaskCanStart,
  deviceUsageStore: {
    list: () => MobilePreviewDeviceUsageRepository.listAll(),
    record: async (params) => {
      await MobilePreviewDeviceUsageRepository.recordUsage(params);
    },
  },
});
