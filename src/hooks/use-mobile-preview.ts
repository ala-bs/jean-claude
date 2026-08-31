import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  MOBILE_PREVIEW_H264_REPLAY_CHUNK_LIMIT,
  type MobileColorScheme,
  type MobilePlatform,
  type MobilePreviewFrameEvent,
  type MobilePreviewInputEvent,
  type MobilePreviewNativeLogEvent,
  type MobilePreviewNativeLogSession,
  type MobilePreviewNativeLogStartParams,
  type MobilePreviewSession,
  type MobilePreviewStartParams,
  type MobileRotationDirection,
  type ReactNativeDevToolsPanel,
} from '@shared/mobile-simulator-types';
import { api } from '@/lib/api';
import { createStreamListStore } from './utils-stream-list-store';

function logMobilePreviewDebug(..._args: unknown[]) {}

const MAX_PENDING_NATIVE_LOGS = 1000;
const MAX_NATIVE_LOGS = 1000;
const MAX_PENDING_FRAME_EVENTS = 120;
const MAX_QUARANTINED_PREVIEW_SESSIONS = 100;

function quarantinePreviewSession(sessionIds: Set<string>, sessionId: string) {
  sessionIds.add(sessionId);
  if (sessionIds.size <= MAX_QUARANTINED_PREVIEW_SESSIONS) return;
  const oldestSessionId = sessionIds.values().next().value;
  if (oldestSessionId) sessionIds.delete(oldestSessionId);
}

function trimPendingFrameEvents(events: MobilePreviewFrameEvent[]) {
  if (events.length <= MAX_PENDING_FRAME_EVENTS) return;

  const firstDroppableIndex = events.findIndex(
    (event) => event.h264PacketType !== 'configuration',
  );
  events.splice(firstDroppableIndex >= 0 ? firstDroppableIndex : 0, 1);
}

export function useMobilePreviewDevices(
  platform: MobilePlatform | null | undefined,
) {
  return useQuery({
    queryKey: ['mobile-preview-devices', platform],
    queryFn: () => {
      if (!platform) {
        return [];
      }
      return api.mobilePreview.listDevices(platform);
    },
    enabled: !!platform,
  });
}

export const MOBILE_PREVIEW_DEVICE_ASSIGNMENTS_QUERY_KEY = [
  'mobile-preview-device-assignments',
] as const;

/**
 * Device -> task associations across every task.
 *
 * Unlike `useMobilePreviewSession`, this is deliberately not scoped to a single
 * task: the device rail needs to show that a device belongs to some *other*
 * task. Refetched on an interval because sessions can start and stop from any
 * task's pane, not just this one.
 */
export function useMobilePreviewDeviceAssignments({
  enabled = true,
  refetchIntervalMs = 5000,
}: { enabled?: boolean; refetchIntervalMs?: number } = {}) {
  return useQuery({
    queryKey: MOBILE_PREVIEW_DEVICE_ASSIGNMENTS_QUERY_KEY,
    queryFn: () => api.mobilePreview.listDeviceAssignments(),
    enabled,
    refetchInterval: enabled ? refetchIntervalMs : false,
    staleTime: 1000,
  });
}

export function useReactNativeDevTools({
  metroPort,
  panel = 'console',
  enabled = true,
  pollUntilTargetMs,
}: {
  metroPort: number;
  panel?: ReactNativeDevToolsPanel;
  enabled?: boolean;
  /** Keep polling at this interval until at least one target is reported. */
  pollUntilTargetMs?: number;
}) {
  return useQuery({
    queryKey: ['mobile-preview-react-native-devtools', metroPort, panel],
    queryFn: () =>
      api.mobilePreview.resolveReactNativeDevTools({ metroPort, panel }),
    enabled,
    refetchInterval: pollUntilTargetMs
      ? (query) =>
          (query.state.data?.targets?.length ?? 0) > 0
            ? false
            : pollUntilTargetMs
      : false,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useAndroidDeviceManagement(enabled = true) {
  const queryClient = useQueryClient();

  const toolStatus = useQuery({
    queryKey: ['mobile-preview-android-tool-status'],
    queryFn: () => api.mobilePreview.getAndroidToolStatus(),
    enabled,
  });
  const profiles = useQuery({
    queryKey: ['mobile-preview-android-device-profiles'],
    queryFn: () => api.mobilePreview.listAndroidDeviceProfiles(),
    enabled,
  });
  const systemImages = useQuery({
    queryKey: ['mobile-preview-android-system-images'],
    queryFn: () => api.mobilePreview.listAndroidSystemImages(),
    enabled,
  });

  const invalidate = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['mobile-preview-devices', 'android'],
      }),
      queryClient.invalidateQueries({
        queryKey: ['mobile-preview-android-system-images'],
      }),
    ]);
  }, [queryClient]);

  const createDevice = useMutation({
    mutationFn: api.mobilePreview.createAndroidDevice,
    onSuccess: invalidate,
  });
  const deleteDevice = useMutation({
    mutationFn: api.mobilePreview.deleteAndroidDevice,
    onSuccess: invalidate,
  });
  const installSystemImage = useMutation({
    mutationFn: api.mobilePreview.installAndroidSystemImage,
    onSuccess: invalidate,
  });

  return {
    toolStatus,
    profiles,
    systemImages,
    createDevice,
    deleteDevice,
    installSystemImage,
  };
}

export function useIosDeviceManagement(enabled = true) {
  const queryClient = useQueryClient();

  const toolStatus = useQuery({
    queryKey: ['mobile-preview-ios-tool-status'],
    queryFn: () => api.mobilePreview.getIosToolStatus(),
    enabled,
  });
  const runtimes = useQuery({
    queryKey: ['mobile-preview-ios-runtimes'],
    queryFn: () => api.mobilePreview.listIosRuntimes(),
    enabled,
  });
  const deviceTypes = useQuery({
    queryKey: ['mobile-preview-ios-device-types'],
    queryFn: () => api.mobilePreview.listIosDeviceTypes(),
    enabled,
  });

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: ['mobile-preview-devices', 'ios'],
    });
  }, [queryClient]);

  const createDevice = useMutation({
    mutationFn: api.mobilePreview.createIosDevice,
    onSuccess: invalidate,
  });
  const deleteDevice = useMutation({
    mutationFn: api.mobilePreview.deleteIosDevice,
    onSuccess: invalidate,
  });
  const eraseDevice = useMutation({
    mutationFn: api.mobilePreview.eraseIosDevice,
    onSuccess: invalidate,
  });
  const renameDevice = useMutation({
    mutationFn: api.mobilePreview.renameIosDevice,
    onSuccess: invalidate,
  });

  return {
    toolStatus,
    runtimes,
    deviceTypes,
    createDevice,
    deleteDevice,
    eraseDevice,
    renameDevice,
  };
}

export function useMobilePreviewNativeLogs(
  params: MobilePreviewNativeLogStartParams | null,
) {
  const [session, setSession] = useState<MobilePreviewNativeLogSession | null>(
    null,
  );
  const [logsStore] = useState(createStreamListStore<MobilePreviewNativeLogEvent>);
  const sessionRef = useRef<MobilePreviewNativeLogSession | null>(null);
  const pendingLogsRef = useRef<MobilePreviewNativeLogEvent[]>([]);
  const flushLogsFrameRef = useRef<number | null>(null);

  const matchesParams = useCallback(
    (nextSession: MobilePreviewNativeLogSession) =>
      !!params &&
      nextSession.platform === params.platform &&
      nextSession.deviceId === params.deviceId,
    [params],
  );

  useEffect(() => {
    sessionRef.current = null;
    queueMicrotask(() => {
      setSession(null);
    });
    logsStore.clear();
    if (!params) return undefined;

    const unsubscribeSession = api.mobilePreview.onNativeLogSession((event) => {
      if (!matchesParams(event.session)) return;
      sessionRef.current = event.session;
      setSession(event.session);
    });
    const unsubscribeLog = api.mobilePreview.onNativeLog((event) => {
      if (event.sessionId !== sessionRef.current?.id) return;
      pendingLogsRef.current.push(event);
      if (pendingLogsRef.current.length > MAX_PENDING_NATIVE_LOGS) {
        pendingLogsRef.current.splice(
          0,
          pendingLogsRef.current.length - MAX_PENDING_NATIVE_LOGS,
        );
      }
      if (flushLogsFrameRef.current !== null) return;

      flushLogsFrameRef.current = requestAnimationFrame(() => {
        flushLogsFrameRef.current = null;
        const nextLogs = pendingLogsRef.current;
        pendingLogsRef.current = [];
        logsStore.append(nextLogs, MAX_NATIVE_LOGS);
      });
    });

    return () => {
      const activeSession = sessionRef.current;
      if (activeSession?.status === 'running') {
        void api.mobilePreview
          .stopNativeLogs(activeSession.id)
          .catch((error: unknown) => {
            console.error('Failed to stop native logs:', error);
          });
      }
      unsubscribeLog();
      unsubscribeSession();
      if (flushLogsFrameRef.current !== null) {
        cancelAnimationFrame(flushLogsFrameRef.current);
        flushLogsFrameRef.current = null;
      }
      pendingLogsRef.current = [];
    };
  }, [logsStore, matchesParams, params]);

  const startMutation = useMutation({
    mutationFn: (startParams: MobilePreviewNativeLogStartParams) =>
      api.mobilePreview.startNativeLogs(startParams),
    onSuccess: (nextSession) => {
      sessionRef.current = nextSession;
      setSession(nextSession);
    },
  });
  const stopMutation = useMutation({
    mutationFn: (sessionId: string) =>
      api.mobilePreview.stopNativeLogs(sessionId),
  });

  return {
    session,
    logsStore,
    start: startMutation.mutateAsync,
    stop: stopMutation.mutateAsync,
    isStarting: startMutation.isPending,
    isStopping: stopMutation.isPending,
    error: startMutation.error ?? stopMutation.error,
  };
}

function createObjectUrlFromBase64(frameBase64: string, mimeType: string) {
  if (typeof URL === 'undefined' || typeof Blob === 'undefined') {
    return `data:${mimeType};base64,${frameBase64}`;
  }

  const binary = atob(frameBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

export type MobilePreviewH264Chunk = Pick<
  MobilePreviewFrameEvent,
  'frameBase64' | 'h264PacketType' | 'keyframe'
>;

const MAX_PENDING_H264_CHUNKS = MOBILE_PREVIEW_H264_REPLAY_CHUNK_LIMIT;

function getSessionDeviceKey(params: {
  platform: MobilePlatform;
  deviceId: string;
}) {
  return `${params.platform}:${params.deviceId}`;
}

export function useMobilePreviewSession(
  taskId: string,
  selectedDevice?: { platform: MobilePlatform; deviceId: string } | null,
  options: { retainSessions?: boolean } = {},
) {
  const retainSessions = options.retainSessions ?? false;
  const [session, setSessionState] = useState<MobilePreviewSession | null>(
    null,
  );
  const sessionsByDeviceRef = useRef(new Map<string, MobilePreviewSession>());
  const [activeSessionDeviceKeys, setActiveSessionDeviceKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());
  // Image frames stream at up to 60fps. They are pushed to subscribers through a
  // ref-based emitter so a new frame never re-renders the pane; only the
  // "first frame received" transition is React state.
  const [hasImageFrame, setHasImageFrame] = useState(false);
  const imageFrameCountRef = useRef(0);
  const imageFrameListenersRef = useRef(
    new Set<(nextFrameUrl: string | null) => void>(),
  );
  const [lastError, setLastError] = useState<Error | null>(null);
  const [isHydratingRetainedSessions, setIsHydratingRetainedSessions] =
    useState(retainSessions);
  const sessionRef = useRef<MobilePreviewSession | null>(null);
  const frameUrlRef = useRef<string | null>(null);
  const h264ChunkListenersRef = useRef(
    new Set<(chunk: MobilePreviewH264Chunk) => void>(),
  );
  const latestH264ConfigurationRef = useRef<MobilePreviewH264Chunk | null>(
    null,
  );
  const latestH264ConfigurationBySessionRef = useRef(
    new Map<string, MobilePreviewH264Chunk>(),
  );
  const pendingH264ChunksRef = useRef<MobilePreviewH264Chunk[]>([]);
  const pendingH264ChunksBySessionRef = useRef(
    new Map<string, MobilePreviewH264Chunk[]>(),
  );
  const pendingFrameEventsRef = useRef<MobilePreviewFrameEvent[]>([]);
  const flushFramesFrameRef = useRef<number | null>(null);
  const h264ChunkCountRef = useRef(0);
  const startGenerationRef = useRef(0);
  const pendingStartTaskIdRef = useRef<string | null>(null);
  const pendingStartDeviceKeyRef = useRef<string | null>(null);
  const cancelledStartOwnersByDeviceRef = useRef(new Map<string, number>());
  const quarantinedSessionIdsRef = useRef(new Set<string>());
  const unknownFrameEventsRef = useRef<MobilePreviewFrameEvent[]>([]);
  const unknownFrameGenerationRef = useRef<number | null>(null);
  const replayUnknownFramesRef = useRef<(sessionId: string) => void>(() => undefined);
  const isMountedRef = useRef(true);
  const selectedDeviceRef = useRef(selectedDevice);
  const attachedSessionTaskIdsRef = useRef(new Map<string, string>());

  useEffect(() => {
    selectedDeviceRef.current = selectedDevice;
  }, [selectedDevice]);

  const emitImageFrame = useCallback((nextFrameUrl: string | null) => {
    imageFrameListenersRef.current.forEach((listener) => {
      listener(nextFrameUrl);
    });
  }, []);

  const subscribeImageFrames = useCallback(
    (listener: (nextFrameUrl: string | null) => void) => {
      imageFrameListenersRef.current.add(listener);
      listener(frameUrlRef.current);
      return () => {
        imageFrameListenersRef.current.delete(listener);
      };
    },
    [],
  );

  const resetImageFrames = useCallback(() => {
    imageFrameCountRef.current = 0;
    setHasImageFrame(false);
    emitImageFrame(null);
  }, [emitImageFrame]);

  const revokeFrameUrl = useCallback(() => {
    if (frameUrlRef.current?.startsWith('blob:')) {
      URL.revokeObjectURL(frameUrlRef.current);
    }
    frameUrlRef.current = null;
  }, []);

  const syncActiveSessionDeviceKeys = useCallback(() => {
    const nextKeys = new Set(
      Array.from(sessionsByDeviceRef.current.entries())
        .filter(([, activeSession]) => activeSession.status !== 'stopped')
        .map(([deviceKey]) => deviceKey),
    );
    setActiveSessionDeviceKeys((currentKeys) => {
      if (
        currentKeys.size === nextKeys.size &&
        Array.from(currentKeys).every((key) => nextKeys.has(key))
      ) {
        return currentKeys;
      }
      return nextKeys;
    });
  }, []);

  const detachRetainedSession = useCallback(
    (sessionTaskId: string, sessionId: string) => {
      if (attachedSessionTaskIdsRef.current.get(sessionId) !== sessionTaskId) {
        return;
      }
      attachedSessionTaskIdsRef.current.delete(sessionId);
      void api.mobilePreview
        .detachSession({ taskId: sessionTaskId, sessionId })
        .catch((error: unknown) => {
          console.error('Failed to detach retained mobile preview session:', error);
        });
    },
    [],
  );

  const setSession = useCallback(
    (nextSession: MobilePreviewSession | null) => {
      const previousSessionId = sessionRef.current?.id;
      if (nextSession && nextSession.taskId === taskId) {
        const key = getSessionDeviceKey(nextSession);
        if (nextSession.status === 'stopped') {
          sessionsByDeviceRef.current.delete(key);
        } else {
          sessionsByDeviceRef.current.set(key, nextSession);
        }
        syncActiveSessionDeviceKeys();
      }
      sessionRef.current = nextSession;
      setSessionState(nextSession);

      if (previousSessionId && previousSessionId !== nextSession?.id) {
        revokeFrameUrl();
        resetImageFrames();
      }
    },
    [resetImageFrames, revokeFrameUrl, syncActiveSessionDeviceKeys, taskId],
  );

  const shouldAcceptSession = useCallback(
    (nextSession: MobilePreviewSession) => {
      if (nextSession.taskId !== taskId) {
        return false;
      }

      if (quarantinedSessionIdsRef.current.has(nextSession.id)) {
        return false;
      }

      if (pendingStartTaskIdRef.current !== null) {
        return false;
      }

      const currentSession = sessionRef.current;
      if (currentSession) {
        return currentSession.id === nextSession.id;
      }

      if (
        cancelledStartOwnersByDeviceRef.current.has(
          getSessionDeviceKey(nextSession),
        )
      ) {
        return false;
      }

      const currentSelectedDevice = selectedDeviceRef.current;
      if (
        currentSelectedDevice &&
        nextSession.platform === currentSelectedDevice.platform &&
        nextSession.deviceId === currentSelectedDevice.deviceId
      ) {
        return true;
      }

      return false;
    },
    [taskId],
  );

  useEffect(() => {
    isMountedRef.current = true;
    const h264ChunkListeners = h264ChunkListenersRef.current;
    const sessionsByDevice = sessionsByDeviceRef.current;
    const latestConfigurationsBySession = latestH264ConfigurationBySessionRef.current;
    const pendingChunksBySession = pendingH264ChunksBySessionRef.current;
    const cancelledStartOwnersByDevice = cancelledStartOwnersByDeviceRef.current;
    const quarantinedSessionIds = quarantinedSessionIdsRef.current;
    const attachedSessionTaskIds = attachedSessionTaskIdsRef.current;
    const getCurrentSession = () => sessionRef.current;

    const unsubscribeSession = api.mobilePreview.onSession((event) => {
      if (!shouldAcceptSession(event.session)) {
        if (event.session.taskId === taskId) {
          const key = getSessionDeviceKey(event.session);
          if (quarantinedSessionIdsRef.current.has(event.session.id)) {
            return;
          }
          if (pendingStartTaskIdRef.current !== null) {
            if (event.session.status === 'stopped') {
              sessionsByDeviceRef.current.delete(key);
            }
            return;
          }
          if (cancelledStartOwnersByDeviceRef.current.has(key)) {
            return;
          }
          const currentSession = sessionRef.current;
          if (
            currentSession &&
            getSessionDeviceKey(currentSession) === key &&
            currentSession.id !== event.session.id
          ) {
            return;
          }
          if (event.session.status === 'stopped') {
            sessionsByDeviceRef.current.delete(key);
          } else {
            sessionsByDeviceRef.current.set(key, event.session);
          }
          syncActiveSessionDeviceKeys();
        }
        return;
      }

      setSession(event.session);
    });

    const flushFrameEvents = () => {
      flushFramesFrameRef.current = null;
      const frameEvents = pendingFrameEventsRef.current;
      pendingFrameEventsRef.current = [];

      frameEvents.forEach((event) => {
        const currentSession = sessionRef.current;
        const frameSession =
          currentSession?.id === event.sessionId
            ? currentSession
            : Array.from(sessionsByDevice.values()).find(
                (nextSession) => nextSession.id === event.sessionId,
              );
        if (!frameSession) {
          return;
        }

        const chunk = {
          frameBase64: event.frameBase64,
          h264PacketType: event.h264PacketType,
          keyframe: event.keyframe,
        } satisfies MobilePreviewH264Chunk;

        if (chunk.h264PacketType === 'configuration') {
          latestH264ConfigurationBySessionRef.current.set(event.sessionId, chunk);
        }

        if (event.sessionId !== currentSession?.id) {
          if (
            frameSession.frameFormat === 'h264' ||
            frameSession.frameFormat === 'raw-rgba'
          ) {
            const pending =
              pendingH264ChunksBySessionRef.current.get(event.sessionId) ?? [];
            if (pending.length < MAX_PENDING_H264_CHUNKS) {
              pending.push(chunk);
              pendingH264ChunksBySessionRef.current.set(event.sessionId, pending);
            }
          }
          return;
        }

        if (
          currentSession.frameFormat === 'h264' ||
          currentSession.frameFormat === 'raw-rgba'
        ) {
          h264ChunkCountRef.current += 1;
          if (chunk.h264PacketType === 'configuration') {
            latestH264ConfigurationRef.current = chunk;
          }
          if (
            h264ChunkCountRef.current === 1 ||
            h264ChunkCountRef.current % 30 === 0
          ) {
            logMobilePreviewDebug(
              'jc:mobile-preview:renderer raw ipc chunk sessionId=%s chunks=%d base64Length=%d listeners=%d format=%s packetType=%s',
              event.sessionId,
              h264ChunkCountRef.current,
              event.frameBase64.length,
              h264ChunkListenersRef.current.size,
              currentSession.frameFormat,
              event.h264PacketType ?? 'raw',
            );
          }
          if (h264ChunkListenersRef.current.size === 0) {
            if (pendingH264ChunksRef.current.length < MAX_PENDING_H264_CHUNKS) {
              pendingH264ChunksRef.current.push(chunk);
            }
          } else {
            h264ChunkListenersRef.current.forEach((listener) => {
              listener(chunk);
            });
          }
          revokeFrameUrl();
          emitImageFrame(null);
          // Mirrors the old setFrameUrl(null): consumers gated on "an image
          // frame exists" (e.g. the screenshot button) must not stay enabled
          // once the session switched to a video codec.
          setHasImageFrame(false);
          return;
        }

        const nextFrameUrl = createObjectUrlFromBase64(
          event.frameBase64,
          currentSession.frameFormat === 'png' ? 'image/png' : 'image/jpeg',
        );
        revokeFrameUrl();
        frameUrlRef.current = nextFrameUrl;
        imageFrameCountRef.current += 1;
        emitImageFrame(nextFrameUrl);
        setHasImageFrame(true);
      });
    };

    const scheduleFrameFlush = () => {
      if (flushFramesFrameRef.current !== null) return;
      flushFramesFrameRef.current = requestAnimationFrame(flushFrameEvents);
    };

    replayUnknownFramesRef.current = (sessionId) => {
      const bufferedFrames = unknownFrameEventsRef.current;
      unknownFrameEventsRef.current = [];
      unknownFrameGenerationRef.current = null;
      bufferedFrames
        .filter(
          (event) =>
            event.sessionId === sessionId &&
            !quarantinedSessionIdsRef.current.has(event.sessionId),
        )
        .forEach((event) => {
          pendingFrameEventsRef.current.push(event);
          trimPendingFrameEvents(pendingFrameEventsRef.current);
        });
      if (pendingFrameEventsRef.current.length > 0) scheduleFrameFlush();
    };

    const unsubscribeFrame = api.mobilePreview.onFrame((event) => {
      if (quarantinedSessionIdsRef.current.has(event.sessionId)) return;
      const currentSession = sessionRef.current;
      const isKnownSession =
        currentSession?.id === event.sessionId ||
        Array.from(sessionsByDevice.values()).some(
          (nextSession) => nextSession.id === event.sessionId,
        );
      if (!isKnownSession) {
        if (
          pendingStartTaskIdRef.current !== null &&
          unknownFrameGenerationRef.current === startGenerationRef.current
        ) {
          unknownFrameEventsRef.current.push(event);
          trimPendingFrameEvents(unknownFrameEventsRef.current);
        }
        return;
      }
      pendingFrameEventsRef.current.push(event);
      trimPendingFrameEvents(pendingFrameEventsRef.current);
      scheduleFrameFlush();
    });

    return () => {
      isMountedRef.current = false;
      startGenerationRef.current += 1;
      pendingStartTaskIdRef.current = null;
      pendingStartDeviceKeyRef.current = null;
      if (!retainSessions) {
        cancelledStartOwnersByDevice.clear();
      }
      quarantinedSessionIds.clear();
      unknownFrameEventsRef.current = [];
      unknownFrameGenerationRef.current = null;
      replayUnknownFramesRef.current = () => undefined;
      const activeSessions = new Map(
        Array.from(sessionsByDevice.values()).map((activeSession) => [
          activeSession.id,
          activeSession,
        ]),
      );
      const currentSession = getCurrentSession();
      if (currentSession) {
        activeSessions.set(currentSession.id, currentSession);
      }
      if (!retainSessions) {
        activeSessions.forEach((activeSession) => {
          if (activeSession.status === 'stopped') return;
          void api.mobilePreview.stop(activeSession.id).catch((error: unknown) => {
            console.error(
              'Failed to stop mobile preview session on unmount:',
              error,
            );
          });
        });
      } else {
        Array.from(attachedSessionTaskIds).forEach(
          ([sessionId, sessionTaskId]) => {
            if (sessionTaskId === taskId) {
              detachRetainedSession(sessionTaskId, sessionId);
            }
          },
        );
      }
      unsubscribeFrame();
      unsubscribeSession();
      if (flushFramesFrameRef.current !== null) {
        cancelAnimationFrame(flushFramesFrameRef.current);
        flushFramesFrameRef.current = null;
      }
      pendingFrameEventsRef.current = [];
      revokeFrameUrl();
      h264ChunkListeners.clear();
      latestH264ConfigurationRef.current = null;
      pendingH264ChunksRef.current = [];
      latestConfigurationsBySession.clear();
      pendingChunksBySession.clear();
      sessionsByDevice.clear();
    };
  }, [
    detachRetainedSession,
    emitImageFrame,
    retainSessions,
    revokeFrameUrl,
    setSession,
    shouldAcceptSession,
    syncActiveSessionDeviceKeys,
    taskId,
  ]);

  useEffect(() => {
    const activeSession = sessionRef.current;
    const activeSessions = new Map(
      Array.from(sessionsByDeviceRef.current.values()).map((nextSession) => [
        nextSession.id,
        nextSession,
      ]),
    );
    if (activeSession) {
      activeSessions.set(activeSession.id, activeSession);
    }
    const pendingDeviceKey = pendingStartDeviceKeyRef.current;
    if (
      retainSessions &&
      pendingStartTaskIdRef.current !== null &&
      pendingDeviceKey
    ) {
      cancelledStartOwnersByDeviceRef.current.set(
        pendingDeviceKey,
        startGenerationRef.current,
      );
      sessionsByDeviceRef.current.delete(pendingDeviceKey);
    }
    startGenerationRef.current += 1;
    pendingStartTaskIdRef.current = null;
    pendingStartDeviceKeyRef.current = null;
    if (!retainSessions) {
      cancelledStartOwnersByDeviceRef.current.clear();
    }
    unknownFrameEventsRef.current = [];
    unknownFrameGenerationRef.current = null;
    revokeFrameUrl();
    h264ChunkListenersRef.current.clear();
    latestH264ConfigurationRef.current = null;
    pendingH264ChunksRef.current = [];
    latestH264ConfigurationBySessionRef.current.clear();
    pendingH264ChunksBySessionRef.current.clear();
    pendingFrameEventsRef.current = [];
    if (flushFramesFrameRef.current !== null) {
      cancelAnimationFrame(flushFramesFrameRef.current);
      flushFramesFrameRef.current = null;
    }
    h264ChunkCountRef.current = 0;

    queueMicrotask(() => {
      if (!isMountedRef.current) return;
      setSession(null);
      resetImageFrames();
    });

    if (!retainSessions) {
      activeSessions.forEach((nextSession) => {
        if (nextSession.status === 'stopped') return;
        void api.mobilePreview.stop(nextSession.id).catch((error: unknown) => {
          console.error(
            'Failed to stop mobile preview session after task change:',
            error,
          );
        });
      });
    }
  }, [resetImageFrames, retainSessions, taskId, revokeFrameUrl, setSession]);

  useEffect(() => {
    const selectionGeneration = startGenerationRef.current;
    queueMicrotask(() => {
      if (!isMountedRef.current) return;
      if (startGenerationRef.current !== selectionGeneration) return;
      if (!selectedDevice) {
        setSession(null);
        return;
      }

      const selectedSession = sessionsByDeviceRef.current.get(
        getSessionDeviceKey(selectedDevice),
      );
      if (selectedSession) {
        latestH264ConfigurationRef.current =
          latestH264ConfigurationBySessionRef.current.get(selectedSession.id) ??
          null;
        pendingH264ChunksRef.current =
          pendingH264ChunksBySessionRef.current.get(selectedSession.id) ?? [];
        pendingH264ChunksBySessionRef.current.delete(selectedSession.id);
      }
      setSession(
        selectedSession && selectedSession.status !== 'stopped'
          ? selectedSession
          : null,
      );
    });
  }, [selectedDevice, setSession]);

  const selectedPlatform = selectedDevice?.platform;
  const selectedDeviceId = selectedDevice?.deviceId;
  useEffect(() => {
    if (!retainSessions) {
      queueMicrotask(() => setIsHydratingRetainedSessions(false));
      return undefined;
    }

    let cancelled = false;
    let attachedSessionId: string | null = null;
    queueMicrotask(() => {
      if (!cancelled) setIsHydratingRetainedSessions(true);
    });
    const pendingDeviceKey = pendingStartDeviceKeyRef.current;
    if (pendingStartTaskIdRef.current !== null && pendingDeviceKey) {
      cancelledStartOwnersByDeviceRef.current.set(
        pendingDeviceKey,
        startGenerationRef.current,
      );
      sessionsByDeviceRef.current.delete(pendingDeviceKey);
      pendingStartTaskIdRef.current = null;
      pendingStartDeviceKeyRef.current = null;
      unknownFrameEventsRef.current = [];
      unknownFrameGenerationRef.current = null;
    }
    const hydrationGeneration = startGenerationRef.current + 1;
    startGenerationRef.current = hydrationGeneration;
    const isCurrentHydration = () =>
      !cancelled &&
      isMountedRef.current &&
      startGenerationRef.current === hydrationGeneration &&
      selectedDeviceRef.current?.platform === selectedPlatform &&
      selectedDeviceRef.current?.deviceId === selectedDeviceId;
    const hydrate = async () => {
      try {
        const listedSessions = await api.mobilePreview.listSessions({ taskId });
        if (!isCurrentHydration()) return;

        const activeSessions = listedSessions.filter(
          (listedSession) =>
            listedSession.taskId === taskId &&
            listedSession.status !== 'stopped',
        );
        if (!isCurrentHydration()) return;
        sessionsByDeviceRef.current.clear();
        activeSessions.forEach((activeSession) => {
          if (!isCurrentHydration()) return;
          sessionsByDeviceRef.current.set(
            getSessionDeviceKey(activeSession),
            activeSession,
          );
        });
        syncActiveSessionDeviceKeys();

        const selectedSession = activeSessions.find(
          (activeSession) =>
            activeSession.platform === selectedPlatform &&
            activeSession.deviceId === selectedDeviceId,
        );
        if (!selectedSession) {
          if (!isCurrentHydration()) return;
          setSession(null);
          return;
        }

        // Hydrate before attach so synchronous replay events have a known owner.
        if (!isCurrentHydration()) return;
        setSession(selectedSession);
        if (!isCurrentHydration()) return;
        const attachedSession = await api.mobilePreview.attachSession({
          taskId,
          sessionId: selectedSession.id,
        });
        attachedSessionId = attachedSession.id;
        attachedSessionTaskIdsRef.current.set(attachedSession.id, taskId);
        if (
          !isCurrentHydration() ||
          attachedSession.taskId !== taskId ||
          attachedSession.platform !== selectedPlatform ||
          attachedSession.deviceId !== selectedDeviceId ||
          attachedSession.status === 'stopped'
        ) {
          detachRetainedSession(taskId, attachedSession.id);
          return;
        }
        if (!isCurrentHydration()) return;
        setSession(attachedSession);
        if (!isCurrentHydration()) return;
        setLastError(null);
      } catch (error) {
        if (isCurrentHydration()) {
          setSession(null);
          if (!isCurrentHydration()) return;
          setLastError(toError(error));
        }
      } finally {
        if (isCurrentHydration()) setIsHydratingRetainedSessions(false);
      }
    };

    void hydrate();
    return () => {
      cancelled = true;
      const currentSession = sessionRef.current;
      if (
        currentSession?.taskId === taskId &&
        currentSession.platform === selectedPlatform &&
        currentSession.deviceId === selectedDeviceId
      ) {
        detachRetainedSession(taskId, currentSession.id);
      }
      if (attachedSessionId) {
        detachRetainedSession(taskId, attachedSessionId);
      }
    };
  }, [
    retainSessions,
    selectedDeviceId,
    selectedPlatform,
    detachRetainedSession,
    setSession,
    syncActiveSessionDeviceKeys,
    taskId,
  ]);

  const startMutation = useMutation({
    mutationFn: (params: Omit<MobilePreviewStartParams, 'taskId'>) =>
      api.mobilePreview.start({ ...params, taskId }),
  });

  const stopMutation = useMutation({
    mutationFn: (sessionId: string) => api.mobilePreview.stop(sessionId),
  });

  const sendInputMutation = useMutation({
    mutationFn: ({
      sessionId,
      event,
    }: {
      sessionId: string;
      event: MobilePreviewInputEvent;
    }) => api.mobilePreview.sendInput(sessionId, event),
  });

  const setColorSchemeMutation = useMutation({
    mutationFn: ({
      sessionId,
      scheme,
    }: {
      sessionId: string;
      scheme: MobileColorScheme;
    }) => api.mobilePreview.setColorScheme(sessionId, scheme),
  });

  const rotateMutation = useMutation({
    mutationFn: ({
      sessionId,
      direction,
    }: {
      sessionId: string;
      direction: MobileRotationDirection;
    }) => api.mobilePreview.rotate(sessionId, direction),
  });

  const { mutateAsync: startPreview } = startMutation;
  const { mutateAsync: stopPreview } = stopMutation;
  const { mutateAsync: sendPreviewInput } = sendInputMutation;
  const { mutateAsync: setPreviewColorScheme } = setColorSchemeMutation;
  const { mutateAsync: rotatePreview } = rotateMutation;

  const cancelStart = useCallback(() => {
    const pendingDeviceKey = pendingStartDeviceKeyRef.current;
    if (pendingDeviceKey) {
      cancelledStartOwnersByDeviceRef.current.set(
        pendingDeviceKey,
        startGenerationRef.current,
      );
      sessionsByDeviceRef.current.delete(pendingDeviceKey);
    }
    unknownFrameEventsRef.current = [];
    unknownFrameGenerationRef.current = null;
    startGenerationRef.current += 1;
    pendingStartTaskIdRef.current = null;
    pendingStartDeviceKeyRef.current = null;
  }, []);

  const start = useCallback(
    async (params: Omit<MobilePreviewStartParams, 'taskId'>) => {
      const startGeneration = startGenerationRef.current + 1;
      startGenerationRef.current = startGeneration;
      const startingTaskId = taskId;
      const startingDeviceKey = getSessionDeviceKey(params);
      pendingStartTaskIdRef.current = startingTaskId;
      pendingStartDeviceKeyRef.current = startingDeviceKey;
      unknownFrameEventsRef.current = [];
      unknownFrameGenerationRef.current = startGeneration;
      latestH264ConfigurationRef.current = null;
      pendingH264ChunksRef.current = [];
      // Only the fps counter resets here: the last frame stays on screen while
      // the new session spins up, as it did before frames moved out of state.
      imageFrameCountRef.current = 0;

      try {
        const nextSession = await startPreview(params);
        if (retainSessions) {
          attachedSessionTaskIdsRef.current.set(nextSession.id, startingTaskId);
        }
        const shouldUseSession =
          isMountedRef.current &&
          startGenerationRef.current === startGeneration &&
          nextSession.taskId === startingTaskId &&
          selectedDeviceRef.current?.platform === nextSession.platform &&
          selectedDeviceRef.current?.deviceId === nextSession.deviceId &&
          !quarantinedSessionIdsRef.current.has(nextSession.id) &&
          nextSession.status !== 'stopped';

        if (shouldUseSession) {
          pendingStartTaskIdRef.current = null;
          pendingStartDeviceKeyRef.current = null;
          if (
            cancelledStartOwnersByDeviceRef.current.get(startingDeviceKey) ===
            startGeneration
          ) {
            cancelledStartOwnersByDeviceRef.current.delete(startingDeviceKey);
          }
          setSession(nextSession);
          replayUnknownFramesRef.current(nextSession.id);
          setLastError(null);
        } else {
          if (
            startGenerationRef.current === startGeneration &&
            pendingStartTaskIdRef.current === startingTaskId
          ) {
            pendingStartTaskIdRef.current = null;
            pendingStartDeviceKeyRef.current = null;
          }
          quarantinePreviewSession(
            quarantinedSessionIdsRef.current,
            nextSession.id,
          );
          const wasExplicitlyCancelled =
            cancelledStartOwnersByDeviceRef.current.get(startingDeviceKey) ===
            startGeneration;
          if (!retainSessions || wasExplicitlyCancelled) {
            try {
              await api.mobilePreview.stop(nextSession.id);
              if (
                sessionsByDeviceRef.current.get(startingDeviceKey)?.id ===
                nextSession.id
              ) {
                sessionsByDeviceRef.current.delete(startingDeviceKey);
              }
            } catch (stopError) {
              if (isMountedRef.current && nextSession.taskId === startingTaskId) {
                setLastError(toError(stopError));
              }
            }
          } else {
            detachRetainedSession(startingTaskId, nextSession.id);
          }
          if (wasExplicitlyCancelled) {
            cancelledStartOwnersByDeviceRef.current.delete(startingDeviceKey);
          }
        }
        return nextSession;
      } catch (error) {
        if (
          startGenerationRef.current === startGeneration &&
          pendingStartTaskIdRef.current === startingTaskId
        ) {
          pendingStartTaskIdRef.current = null;
          pendingStartDeviceKeyRef.current = null;
        }
        if (
          startGenerationRef.current === startGeneration &&
          isMountedRef.current
        ) {
          setLastError(toError(error));
        }
        if (
          cancelledStartOwnersByDeviceRef.current.get(startingDeviceKey) ===
          startGeneration
        ) {
          cancelledStartOwnersByDeviceRef.current.delete(startingDeviceKey);
        }
        throw error;
      }
    },
    [
      detachRetainedSession,
      retainSessions,
      setSession,
      startPreview,
      taskId,
    ],
  );

  const stop = useCallback(async () => {
    cancelStart();
    latestH264ConfigurationRef.current = null;
    pendingH264ChunksRef.current = [];
    pendingFrameEventsRef.current = [];
    if (flushFramesFrameRef.current !== null) {
      cancelAnimationFrame(flushFramesFrameRef.current);
      flushFramesFrameRef.current = null;
    }
    const sessionId = sessionRef.current?.id;
    if (!sessionId) {
      return;
    }

    try {
      await stopPreview(sessionId);
      attachedSessionTaskIdsRef.current.delete(sessionId);
      setLastError(null);
    } catch (error) {
      setLastError(toError(error));
      throw error;
    }
  }, [cancelStart, stopPreview]);

  const sendInput = useCallback(
    async (event: MobilePreviewInputEvent) => {
      const sessionId = sessionRef.current?.id;
      if (!sessionId) {
        throw new Error('No active mobile preview session');
      }

      try {
        await sendPreviewInput({ sessionId, event });
        setLastError(null);
      } catch (error) {
        setLastError(toError(error));
        throw error;
      }
    },
    [sendPreviewInput],
  );

  const setColorScheme = useCallback(
    async (scheme: MobileColorScheme) => {
      const sessionId = sessionRef.current?.id;
      if (!sessionId) {
        throw new Error('No active mobile preview session');
      }

      try {
        await setPreviewColorScheme({ sessionId, scheme });
        setLastError(null);
      } catch (error) {
        setLastError(toError(error));
        throw error;
      }
    },
    [setPreviewColorScheme],
  );

  const rotate = useCallback(
    async (direction: MobileRotationDirection) => {
      const sessionId = sessionRef.current?.id;
      if (!sessionId) {
        throw new Error('No active mobile preview session');
      }

      try {
        await rotatePreview({ sessionId, direction });
        setLastError(null);
      } catch (error) {
        setLastError(toError(error));
        throw error;
      }
    },
    [rotatePreview],
  );

  const subscribeH264Chunks = useCallback(
    (listener: (chunk: MobilePreviewH264Chunk) => void) => {
      h264ChunkListenersRef.current.add(listener);
      const latestConfiguration = latestH264ConfigurationRef.current;
      const pendingChunks = pendingH264ChunksRef.current.splice(0);
      if (latestConfiguration && pendingChunks.at(0) !== latestConfiguration) {
        listener(latestConfiguration);
      }
      pendingChunks.forEach(listener);
      return () => {
        h264ChunkListenersRef.current.delete(listener);
      };
    },
    [],
  );

  return {
    session,
    activeSessionDeviceKeys,
    hasImageFrame,
    imageFrameCountRef,
    subscribeImageFrames,
    subscribeH264Chunks,
    start,
    cancelStart,
    stop,
    sendInput,
    setColorScheme,
    rotate,
    isStarting: startMutation.isPending,
    isStopping: stopMutation.isPending,
    isSendingInput: sendInputMutation.isPending,
    isSettingColorScheme: setColorSchemeMutation.isPending,
    isRotating: rotateMutation.isPending,
    isHydratingRetainedSessions,
    error: lastError,
    startError: startMutation.error,
    stopError: stopMutation.error,
    sendInputError: sendInputMutation.error,
    setColorSchemeError: setColorSchemeMutation.error,
    rotateError: rotateMutation.error,
  };
}
