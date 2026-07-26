import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';

import {
  MOBILE_PREVIEW_REPLAY_BYTE_LIMIT,
  type MobileColorScheme,
  type MobilePlatform,
  type MobilePreviewDevice,
  type MobilePreviewInputEvent,
  type MobilePreviewSession,
  type MobileRotationDirection,
} from '../../shared/mobile-simulator-types';
import { createMobileDevServerCommandId } from '../../shared/mobile-preview-runtime';

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
const taskRepository = vi.hoisted(() => ({
  findById: vi.fn(),
  toggleUserCompleted: vi.fn(),
}));
vi.mock('../database/repositories', () => ({
  ProjectRepository: { findById: vi.fn() },
  TaskRepository: taskRepository,
}));
vi.mock('./run-command-service', () => ({
  runCommandService: { getRunStatus: vi.fn() },
}));

import {
  createMobilePreviewService,
  MOBILE_PREVIEW_MAX_H264_REPLAY_PACKETS,
  MOBILE_PREVIEW_PENDING_START_TIMEOUT_MS,
  validatePersistedMobilePreviewTaskCanStart,
} from './mobile-preview-service';
import { createMobilePreviewExpoLaunchService } from './mobile-preview-expo-launch-service';
import { TaskRepository } from '../database/repositories';

const BEFORE_QUIT_REGISTRY = Symbol.for(
  'jean-claude.mobile-preview.before-quit-registry',
);

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });

  return { promise, resolve };
}

function createWebContents() {
  const events = new EventEmitter();
  const send = vi.fn();
  return Object.assign(events, {
    send,
    isDestroyed: vi.fn(() => false),
  }) as unknown as WebContents & {
    send: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
  };
}

type StartStreamParams = {
  taskId: string;
  deviceId: string;
  signal: AbortSignal;
  fps?: number;
  quality?: 'low' | 'balanced' | 'high' | 'very-high';
  onFrame: (
    frame:
      | Buffer
      | {
          data: Buffer;
          h264PacketType: 'configuration' | 'data';
          keyframe?: boolean;
        },
  ) => void;
  onSession: (patch: Partial<MobilePreviewSession>) => void;
};

function createSession(
  id: string,
  overrides: Partial<MobilePreviewSession> = {},
): MobilePreviewSession {
  return {
    id,
    taskId: 'task-1',
    platform: 'ios',
    deviceId: 'device-1',
    status: 'streaming',
    width: null,
    height: null,
    frameFormat: 'mjpeg',
    streamStrategy: 'idb-video-stream',
    inputStatus: 'ready',
    error: null,
    ...overrides,
  };
}

function createAdapter(
  platform: MobilePlatform,
  options: {
    deferStarts?: boolean;
    abortStarts?: boolean;
    deferStops?: boolean;
    rejectStops?: boolean;
    emitFrameBeforeStartReturns?: boolean;
    emitH264FramesBeforeStartReturns?: boolean;
    emitFrameCountBeforeStartReturns?: number;
  } = {},
) {
  const devices: MobilePreviewDevice[] = [
    {
      id: `${platform}-device`,
      name: `${platform} Device`,
      platform,
      state: 'booted',
    },
  ];
  const starts: StartStreamParams[] = [];
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  const sentInputs: Array<{
    deviceId: string;
    event: MobilePreviewInputEvent;
  }> = [];
  const colorSchemes: Array<{
    deviceId: string;
    scheme: MobileColorScheme;
  }> = [];
  const rotations: Array<{
    deviceId: string;
    direction: MobileRotationDirection;
  }> = [];
  const startControls: Array<ReturnType<typeof createDeferred>> = [];
  const stopControls: Array<ReturnType<typeof createDeferred>> = [];
  const dispose = vi.fn(async () => {});

  return {
    devices,
    starts,
    stops,
    sentInputs,
    colorSchemes,
    rotations,
    dispose,
    adapter: {
      dispose,
      listDevices: vi.fn(async () => devices),
      startStream: vi.fn(async (params: StartStreamParams) => {
        starts.push(params);
        const startIndex = starts.length;
        const stop = vi.fn(async () => {
          if (options.deferStops) {
            const control = createDeferred();
            stopControls.push(control);
            await control.promise;
          }
          if (options.rejectStops) {
            throw new Error('stop failed');
          }
        });
        stops.push(stop);
        if (options.deferStarts) {
          const control = createDeferred();
          startControls.push(control);
          await control.promise;
        }
        if (options.abortStarts) {
          await new Promise<never>((_, reject) => {
            params.signal.throwIfAborted();
            params.signal.addEventListener(
              'abort',
              () => reject(params.signal.reason),
              { once: true },
            );
          });
        }
        if (options.emitFrameBeforeStartReturns) {
          params.onFrame(Buffer.from('early-frame'));
        }
        if (options.emitH264FramesBeforeStartReturns) {
          params.onFrame({
            data: Buffer.from('config'),
            h264PacketType: 'configuration',
          });
          params.onFrame({
            data: Buffer.from('data'),
            h264PacketType: 'data',
            keyframe: true,
          });
        }
        for (
          let index = 0;
          index < (options.emitFrameCountBeforeStartReturns ?? 0);
          index += 1
        ) {
          params.onFrame(Buffer.from(`early-frame-${index}`));
        }

        return {
          session: createSession(`${platform}-session-${startIndex}`, {
            taskId: params.taskId,
            platform,
            deviceId: params.deviceId,
          }),
          stop,
        };
      }),
      sendInput: vi.fn(
        async (deviceId: string, event: MobilePreviewInputEvent) => {
          sentInputs.push({ deviceId, event });
        },
      ),
      openDeeplink: vi.fn(async () => {}),
      forwardPort: platform === 'android' ? vi.fn(async () => {}) : undefined,
      setTextSize: vi.fn(async () => {}),
      setColorScheme: vi.fn(
        async (deviceId: string, scheme: MobileColorScheme) => {
          colorSchemes.push({ deviceId, scheme });
        },
      ),
      rotate: vi.fn(
        async (deviceId: string, direction: MobileRotationDirection) => {
          rotations.push({ deviceId, direction });
        },
      ),
    },
    startControls,
    stopControls,
  };
}

function resetBeforeQuitRegistration(): void {
  delete (globalThis as Record<symbol, unknown>)[BEFORE_QUIT_REGISTRY];
}

function createService(
  options: {
    lifecycle?: {
      onBeforeQuit: (
        callback: (event?: { preventDefault: () => void }) => void,
      ) => void;
    };
    deferIosStarts?: boolean;
    abortIosStarts?: boolean;
    deferIosStops?: boolean;
    rejectIosStops?: boolean;
    emitIosFrameBeforeStartReturns?: boolean;
    emitAndroidH264FramesBeforeStartReturns?: boolean;
    emitAndroidFrameCountBeforeStartReturns?: number;
    logger?: Pick<typeof console, 'error'>;
    validateTaskCanStart?: (taskId: string) => Promise<void>;
  } = {},
) {
  const ios = createAdapter('ios', {
    deferStarts: options.deferIosStarts,
    abortStarts: options.abortIosStarts,
    deferStops: options.deferIosStops,
    rejectStops: options.rejectIosStops,
    emitFrameBeforeStartReturns: options.emitIosFrameBeforeStartReturns,
  });
  const android = createAdapter('android', {
    emitH264FramesBeforeStartReturns:
      options.emitAndroidH264FramesBeforeStartReturns,
    emitFrameCountBeforeStartReturns:
      options.emitAndroidFrameCountBeforeStartReturns,
  });
  const allWindowEvents: Array<{ channel: string; payload: unknown }> = [];
  const validateTaskCanStart =
    options.validateTaskCanStart ?? vi.fn(async () => undefined);
  const service = createMobilePreviewService({
    adapters: {
      ios: ios.adapter,
      android: android.adapter,
    },
    emitter: {
      sendToWebContents: (webContents, channel, payload) => {
        webContents.send(channel, payload);
      },
      sendToAllWindows: (channel, payload) => {
        allWindowEvents.push({ channel, payload });
      },
    },
    lifecycle: options.lifecycle,
    logger: options.logger,
    validateTaskCanStart,
  });

  return { service, ios, android, allWindowEvents, validateTaskCanStart };
}

describe('mobile preview service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskRepository.findById.mockReset();
    taskRepository.toggleUserCompleted.mockReset();
    resetBeforeQuitRegistration();
  });

  it('launches Expo URL through selected platform adapter and exact device', async () => {
    const { service, ios, android } = createService();
    const launcher = createMobilePreviewExpoLaunchService({
      findProjectById: vi.fn(async () => ({
        id: 'project-1',
        path: '/project',
      })),
      findTaskById: vi.fn(async () => ({
        projectId: 'project-1',
        worktreePath: '/worktree',
      })),
      resolveTaskRoot: vi.fn(async () => '/canonical/worktree'),
      resolveAppPath: vi.fn(async () => '/canonical/worktree/apps/mobile'),
      resolveAppSchemes: vi.fn(async () => new Set<string>()),
      getRunStatus: vi.fn(() => ({
        isRunning: true,
        commands: [
          {
            id: createMobileDevServerCommandId('apps/mobile'),
            name: 'Mobile dev server',
            command: 'npx expo start --port 19001',
            ports: [19001],
            status: 'running' as const,
          },
        ],
      })),
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ url: 'exp://127.0.0.1:19001' }), {
          status: 200,
        }),
      ),
      openDeeplink: (params, signal) =>
        service.openDeeplink(params, { signal }),
    });

    await launcher.launch({
      requestId: 'request-1',
      taskId: 'task-1',
      projectId: 'project-1',
      appPath: 'apps/mobile',
      platform: 'android',
      deviceId: 'selected-android-device',
      metroPort: 19001,
    });

    expect(android.adapter.openDeeplink).toHaveBeenCalledWith(
      'selected-android-device',
      'exp://127.0.0.1:19001',
      expect.any(AbortSignal),
    );
    expect(ios.adapter.openDeeplink).not.toHaveBeenCalled();
  });

  it('keeps existing session for same task when starting another device', async () => {
    const { service, ios } = createService();

    const firstSession = await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });
    await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-2',
    });

    expect(ios.stops[0]).not.toHaveBeenCalled();
    expect(ios.adapter.startStream).toHaveBeenCalledTimes(2);
    expect(service.getActiveSession(firstSession.id)).toEqual(firstSession);
    expect(service.getActiveSession('ios-session-2')?.deviceId).toBe(
      'device-2',
    );
  });

  it('replaces existing session for same task and device', async () => {
    const { service, ios } = createService();

    const firstSession = await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });
    await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });

    expect(ios.stops[0]).toHaveBeenCalledTimes(1);
    expect(service.getActiveSession(firstSession.id)).toBeNull();
    expect(service.getActiveSession('ios-session-2')?.deviceId).toBe(
      'device-1',
    );
  });

  it('lists active sessions and filters by task while excluding stopped sessions', async () => {
    const { service, ios } = createService();
    const firstSession = await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });
    const secondSession = await service.start({
      taskId: 'task-2',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-2',
    });

    expect(service.listSessions({ taskId: 'task-1' })).toEqual([firstSession]);
    expect(service.listSessions({ taskId: 'task-2' })).toEqual([secondSession]);

    ios.starts[0].onSession({ status: 'stopped' });

    expect(service.listSessions({ taskId: 'task-2' })).toEqual([secondSession]);
    expect(service.listSessions({ taskId: 'task-1' })).toEqual([]);
  });

  it('stops every active session owned by a task', async () => {
    const { service, ios } = createService();
    const firstSession = await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });
    const secondSession = await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-2',
    });
    const otherSession = await service.start({
      taskId: 'task-2',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-3',
    });

    await service.stopByTask('task-1');

    expect(ios.stops[0]).toHaveBeenCalledTimes(1);
    expect(ios.stops[1]).toHaveBeenCalledTimes(1);
    expect(ios.stops[2]).not.toHaveBeenCalled();
    expect(service.getActiveSession(firstSession.id)).toBeNull();
    expect(service.getActiveSession(secondSession.id)).toBeNull();
    expect(service.getActiveSession(otherSession.id)).toEqual(otherSession);
  });

  it('returns terminal cleanup promptly while a task stream is stuck starting', async () => {
    const { service, ios } = createService({ deferIosStarts: true });
    const start = service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });
    await vi.waitFor(() => expect(ios.startControls).toHaveLength(1));

    const cleanup = service.stopByTask('task-1');
    await expect(
      Promise.race([
        cleanup.then(() => 'stopped'),
        sleep(100).then(() => 'timed-out'),
      ]),
    ).resolves.toBe('stopped');

    ios.startControls[0].resolve();
    const session = await start;

    expect(session.status).toBe('stopped');
    expect(ios.stops[0]).toHaveBeenCalledTimes(1);
    expect(service.getActiveSession(session.id)).toBeNull();
  });

  it('rejects a start when its task does not exist', async () => {
    taskRepository.findById.mockResolvedValue(undefined);
    const { service, ios } = createService({
      validateTaskCanStart: validatePersistedMobilePreviewTaskCanStart,
    });

    await expect(
      service.start({
        taskId: 'missing-task',
        projectPath: '/project',
        platform: 'ios',
        deviceId: 'device-1',
      }),
    ).rejects.toThrow('Mobile preview task not found: missing-task');
    expect(taskRepository.findById).toHaveBeenCalledWith('missing-task');
    expect(ios.adapter.startStream).not.toHaveBeenCalled();
  });

  it('rejects a persisted completed task without an in-memory tombstone', async () => {
    taskRepository.findById.mockResolvedValue({
      id: 'task-1',
      status: 'waiting',
      userCompleted: true,
    });
    const { service, ios } = createService({
      validateTaskCanStart: validatePersistedMobilePreviewTaskCanStart,
    });

    await expect(
      service.start({
        taskId: 'task-1',
        projectPath: '/project',
        platform: 'ios',
        deviceId: 'device-1',
      }),
    ).rejects.toThrow('Mobile preview task is completed: task-1');
    expect(ios.adapter.startStream).not.toHaveBeenCalled();
  });

  it('allows persisted completed status after explicit completion toggle is reopened', async () => {
    let persistedTask = {
      id: 'task-1',
      status: 'completed',
      userCompleted: false,
    };
    taskRepository.findById.mockImplementation(async () => persistedTask);
    taskRepository.toggleUserCompleted.mockImplementation(async () => {
      persistedTask = {
        ...persistedTask,
        userCompleted: !persistedTask.userCompleted,
      };
      return persistedTask;
    });
    const { service } = createService({
      validateTaskCanStart: validatePersistedMobilePreviewTaskCanStart,
    });

    await service.stopByTask('task-1');
    await TaskRepository.toggleUserCompleted('task-1');
    await expect(
      validatePersistedMobilePreviewTaskCanStart('task-1'),
    ).rejects.toThrow('Mobile preview task is completed: task-1');

    await TaskRepository.toggleUserCompleted('task-1');
    await service.resetTaskAfterReactivation('task-1');

    expect(persistedTask).toMatchObject({
      status: 'completed',
      userCompleted: false,
    });
    await expect(
      service.start({
        taskId: 'task-1',
        projectPath: '/project',
        platform: 'ios',
        deviceId: 'device-1',
      }),
    ).resolves.toMatchObject({ taskId: 'task-1' });
  });

  it('aborts a pending adapter startup during terminal cleanup', async () => {
    const { service, ios } = createService({ abortIosStarts: true });
    const start = service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });
    await vi.waitFor(() => expect(ios.starts).toHaveLength(1));

    await expect(service.stopByTask('task-1')).resolves.toBeUndefined();
    await expect(start).rejects.toMatchObject({ name: 'AbortError' });
    expect(ios.starts[0].signal.aborted).toBe(true);
  });

  it('rejects delayed validation after terminal cleanup advances generation', async () => {
    const validation = createDeferred();
    const { service, ios } = createService({
      validateTaskCanStart: vi.fn(async () => validation.promise),
    });
    const start = service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });

    await service.stopByTask('task-1');
    validation.resolve();

    await expect(start).rejects.toThrow('Mobile preview task is completed: task-1');
    expect(ios.adapter.startStream).not.toHaveBeenCalled();
  });

  it('rejects starts queued after task completion', async () => {
    const { service, ios } = createService();

    await service.stopByTask('task-1');

    await expect(
      service.start({
        taskId: 'task-1',
        projectPath: '/project',
        platform: 'ios',
        deviceId: 'device-1',
      }),
    ).rejects.toThrow('Mobile preview task is completed: task-1');
    expect(ios.adapter.startStream).not.toHaveBeenCalled();
  });

  it('allows starts only after deliberate task reactivation reset', async () => {
    const { service } = createService();
    await service.stopByTask('task-1');

    await service.resetTaskAfterReactivation('task-1');

    await expect(
      service.start({
        taskId: 'task-1',
        projectPath: '/project',
        platform: 'ios',
        deviceId: 'device-1',
      }),
    ).resolves.toMatchObject({ taskId: 'task-1' });
  });

  it('keeps a later terminal stop when reactivation is queued behind cleanup', async () => {
    const { service, ios } = createService({ deferIosStops: true });
    await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });

    const firstCleanup = service.stopByTask('task-1');
    const reactivation = service.resetTaskAfterReactivation('task-1');
    const finalCleanup = service.stopByTask('task-1');
    ios.stopControls[0].resolve();
    await Promise.all([firstCleanup, reactivation, finalCleanup]);

    await expect(
      service.start({
        taskId: 'task-1',
        projectPath: '/project',
        platform: 'ios',
        deviceId: 'device-1',
      }),
    ).rejects.toThrow('Mobile preview task is completed: task-1');
  });

  it('does not tombstone a task after normal explicit session stop', async () => {
    const { service } = createService();
    const session = await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });
    await service.stop(session.id);

    await expect(
      service.start({
        taskId: 'task-1',
        projectPath: '/project',
        platform: 'ios',
        deviceId: 'device-1',
      }),
    ).resolves.toMatchObject({ taskId: 'task-1' });
  });

  it('stop calls cleanup once and emits stopped session', async () => {
    const { service, ios, allWindowEvents } = createService();
    const session = await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });

    await Promise.all([service.stop(session.id), service.stop(session.id)]);

    expect(ios.stops[0]).toHaveBeenCalledTimes(1);
    expect(service.getActiveSession(session.id)).toBeNull();
    expect(allWindowEvents.at(-1)).toEqual({
      channel: 'mobilePreview:session',
      payload: { session: { ...session, status: 'stopped' } },
    });
  });

  it('passes requested frame rate to adapter', async () => {
    const { service, ios } = createService();

    await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
      fps: 60,
    });

    expect(ios.starts[0].fps).toBe(60);
  });

  it('passes requested quality to adapter', async () => {
    const { service, ios } = createService();

    await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
      quality: 'high',
    });

    expect(ios.starts[0].quality).toBe('high');
  });

  it('emits stopped session when adapter stop fails', async () => {
    const { service, ios, allWindowEvents } = createService({
      rejectIosStops: true,
    });
    const session = await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });

    await expect(service.stop(session.id)).rejects.toThrow('stop failed');

    expect(ios.stops[0]).toHaveBeenCalledTimes(1);
    expect(service.getActiveSession(session.id)).toBeNull();
    expect(allWindowEvents.at(-1)).toEqual({
      channel: 'mobilePreview:session',
      payload: { session: { ...session, status: 'stopped' } },
    });
  });

  it('frame callback emits base64 event to provided webContents', async () => {
    const { service, ios } = createService();
    const sender = createWebContents();
    const send = sender.send;
    const webContents = { send };
    const session = await service.start(
      {
        taskId: 'task-1',
        projectPath: '/project',
        platform: 'ios',
        deviceId: 'device-1',
      },
      webContents as unknown as WebContents,
    );

    ios.starts[0].onFrame(Buffer.from('frame'));

    expect(send).toHaveBeenLastCalledWith('mobilePreview:frame', {
      sessionId: session.id,
      frameBase64: Buffer.from('frame').toString('base64'),
    });
  });

  it('frame callback preserves h264 packet metadata', async () => {
    const { service, android } = createService();
    const sender = createWebContents();
    const send = sender.send;
    const session = await service.start(
      {
        taskId: 'task-1',
        projectPath: '/project',
        platform: 'android',
        deviceId: 'device-1',
      },
      { send } as unknown as WebContents,
    );

    android.starts[0].onFrame({
      data: Buffer.from('frame'),
      h264PacketType: 'data',
      keyframe: true,
    });

    expect(send).toHaveBeenLastCalledWith('mobilePreview:frame', {
      sessionId: session.id,
      frameBase64: Buffer.from('frame').toString('base64'),
      h264PacketType: 'data',
      keyframe: true,
    });
  });

  it('attaches a replacement sender and replays session plus latest image frame', async () => {
    const { service, ios } = createService();
    const first = createWebContents();
    const second = createWebContents();
    const session = await service.start(
      {
        taskId: 'task-1',
        projectPath: '/project',
        platform: 'ios',
        deviceId: 'device-1',
      },
      first,
    );
    ios.starts[0].onFrame(Buffer.from('old-frame'));
    ios.starts[0].onFrame(Buffer.from('latest-frame'));
    first.send.mockClear();
    first.isDestroyed.mockReturnValue(true);
    first.emit('destroyed');

    await service.attachSession(
      { taskId: 'task-1', sessionId: session.id },
      second,
    );

    expect(second.send.mock.calls).toEqual([
      ['mobilePreview:session', { session }],
      [
        'mobilePreview:frame',
        {
          sessionId: session.id,
          frameBase64: Buffer.from('latest-frame').toString('base64'),
        },
      ],
    ]);

    ios.starts[0].onFrame(Buffer.from('future-frame'));
    expect(first.send).not.toHaveBeenCalled();
    expect(second.send).toHaveBeenLastCalledWith('mobilePreview:frame', {
      sessionId: session.id,
      frameBase64: Buffer.from('future-frame').toString('base64'),
    });
  });

  it('rejects attach when task scope does not own session', async () => {
    const { service } = createService();
    const session = await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });

    await expect(
      service.attachSession(
        { taskId: 'task-2', sessionId: session.id },
        createWebContents(),
      ),
    ).rejects.toThrow(`Mobile preview session not found: ${session.id}`);
  });

  it('prevents a second live renderer from stealing a session', async () => {
    const { service } = createService();
    const first = createWebContents();
    const second = createWebContents();
    const session = await service.start(
      {
        taskId: 'task-1',
        projectPath: '/project',
        platform: 'ios',
        deviceId: 'device-1',
      },
      first,
    );

    await expect(
      service.attachSession(
        { taskId: 'task-1', sessionId: session.id },
        second,
      ),
    ).rejects.toThrow('attached to another renderer');
    await expect(
      service.attachSession(
        { taskId: 'task-1', sessionId: session.id },
        first,
      ),
    ).resolves.toEqual(session);
  });

  it('replaces destroyed sender and removes lifecycle listeners', async () => {
    const { service, ios } = createService();
    const first = createWebContents();
    const second = createWebContents();
    const session = await service.start(
      {
        taskId: 'task-1',
        projectPath: '/project',
        platform: 'ios',
        deviceId: 'device-1',
      },
      first,
    );
    expect(first.listenerCount('destroyed')).toBe(1);
    expect(first.listenerCount('render-process-gone')).toBe(1);

    first.isDestroyed.mockReturnValue(true);
    first.emit('render-process-gone');
    expect(first.listenerCount('destroyed')).toBe(0);
    expect(first.listenerCount('render-process-gone')).toBe(0);
    expect(service.getActiveSession(session.id)).toEqual(session);

    await service.attachSession(
      { taskId: 'task-1', sessionId: session.id },
      second,
    );
    ios.starts[0].onFrame(Buffer.from('future'));
    expect(second.send).toHaveBeenLastCalledWith(
      'mobilePreview:frame',
      expect.objectContaining({ sessionId: session.id }),
    );

    await service.stop(session.id);
    expect(second.listenerCount('destroyed')).toBe(0);
    expect(second.listenerCount('render-process-gone')).toBe(0);
  });

  it('caches detached session events without broadcasting until explicit attach', async () => {
    const { service, ios, allWindowEvents } = createService();
    const first = createWebContents();
    const second = createWebContents();
    const session = await service.start(
      {
        taskId: 'task-1',
        projectPath: '/project',
        platform: 'ios',
        deviceId: 'device-1',
      },
      first,
    );
    first.isDestroyed.mockReturnValue(true);
    first.emit('destroyed');

    ios.starts[0].onFrame(Buffer.from('detached-frame'));
    ios.starts[0].onSession({ width: 390 });

    expect(allWindowEvents).toEqual([]);
    await service.attachSession(
      { taskId: 'task-1', sessionId: session.id },
      second,
    );
    expect(second.send).toHaveBeenCalledWith('mobilePreview:frame', {
      sessionId: session.id,
      frameBase64: Buffer.from('detached-frame').toString('base64'),
    });
  });

  it('explicitly detaches an owned live session, caches frames, and replays before resuming', async () => {
    const { service, android, allWindowEvents } = createService();
    const sender = createWebContents();
    const session = await service.start(
      {
        taskId: 'task-1',
        projectPath: '/project',
        platform: 'android',
        deviceId: 'device-1',
      },
      sender,
    );
    android.starts[0].onSession({ frameFormat: 'h264' });
    sender.send.mockClear();

    await service.detachSession(
      { taskId: 'task-1', sessionId: session.id },
      sender,
    );
    android.starts[0].onFrame({
      data: Buffer.from('config'),
      h264PacketType: 'configuration',
    });
    android.starts[0].onFrame({
      data: Buffer.from('keyframe'),
      h264PacketType: 'data',
      keyframe: true,
    });

    expect(service.getActiveSession(session.id)).toMatchObject({
      id: session.id,
      status: 'streaming',
    });
    expect(sender.send).not.toHaveBeenCalled();
    expect(allWindowEvents).toEqual([]);

    await service.attachSession(
      { taskId: 'task-1', sessionId: session.id },
      sender,
    );
    const replayFrames = sender.send.mock.calls.filter(
      ([channel]) => channel === 'mobilePreview:frame',
    );
    expect(replayFrames).toHaveLength(2);
    expect(replayFrames.map(([, payload]) =>
      Buffer.from((payload as { frameBase64: string }).frameBase64, 'base64').toString(),
    )).toEqual(['config', 'keyframe']);

    android.starts[0].onFrame({
      data: Buffer.from('future'),
      h264PacketType: 'data',
    });
    expect(sender.send).toHaveBeenLastCalledWith(
      'mobilePreview:frame',
      expect.objectContaining({
        sessionId: session.id,
        frameBase64: Buffer.from('future').toString('base64'),
      }),
    );
  });

  it('does not let another renderer detach an owned session', async () => {
    const { service } = createService();
    const owner = createWebContents();
    const other = createWebContents();
    const session = await service.start(
      {
        taskId: 'task-1',
        projectPath: '/project',
        platform: 'ios',
        deviceId: 'device-1',
      },
      owner,
    );

    await expect(
      service.detachSession(
        { taskId: 'task-1', sessionId: session.id },
        other,
      ),
    ).rejects.toThrow('attached to another renderer');
    await expect(
      service.detachSession(
        { taskId: 'task-2', sessionId: session.id },
        owner,
      ),
    ).rejects.toThrow(`Mobile preview session not found: ${session.id}`);
  });

  it('tracks multiple sessions with one lifecycle listener pair per sender', async () => {
    const { service } = createService();
    const sender = createWebContents();
    const first = await service.start(
      {
        taskId: 'task-1',
        projectPath: '/project',
        platform: 'ios',
        deviceId: 'device-1',
      },
      sender,
    );
    const second = await service.start(
      {
        taskId: 'task-1',
        projectPath: '/project',
        platform: 'ios',
        deviceId: 'device-2',
      },
      sender,
    );

    expect(sender.listenerCount('destroyed')).toBe(1);
    expect(sender.listenerCount('render-process-gone')).toBe(1);

    await service.stop(first.id);
    expect(sender.listenerCount('destroyed')).toBe(1);
    expect(sender.listenerCount('render-process-gone')).toBe(1);

    await service.stop(second.id);
    expect(sender.listenerCount('destroyed')).toBe(0);
    expect(sender.listenerCount('render-process-gone')).toBe(0);
  });

  it('replays only latest raw full frame', async () => {
    const { service, ios } = createService();
    const session = await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });
    ios.starts[0].onSession({ frameFormat: 'raw-rgba' });
    ios.starts[0].onFrame(Buffer.from('raw-old'));
    ios.starts[0].onFrame(Buffer.from('raw-latest'));
    const sender = createWebContents();
    const send = sender.send;

    await service.attachSession(
      { taskId: 'task-1', sessionId: session.id },
      sender,
    );

    const frameEvents = send.mock.calls.filter(
      ([channel]) => channel === 'mobilePreview:frame',
    );
    expect(frameEvents).toEqual([
      [
        'mobilePreview:frame',
        {
          sessionId: session.id,
          frameBase64: Buffer.from('raw-latest').toString('base64'),
        },
      ],
    ]);
  });

  it('replays H264 configuration, keyframe, and bounded following packets', async () => {
    const { service, android } = createService();
    const session = await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'android',
      deviceId: 'device-1',
    });
    android.starts[0].onSession({ frameFormat: 'h264' });
    android.starts[0].onFrame({
      data: Buffer.from('config-old'),
      h264PacketType: 'configuration',
    });
    android.starts[0].onFrame({
      data: Buffer.from('config-latest'),
      h264PacketType: 'configuration',
    });
    android.starts[0].onFrame({
      data: Buffer.from('keyframe'),
      h264PacketType: 'data',
      keyframe: true,
    });
    for (
      let index = 1;
      index < MOBILE_PREVIEW_MAX_H264_REPLAY_PACKETS;
      index += 1
    ) {
      android.starts[0].onFrame({
        data: Buffer.from(`packet-${index}`),
        h264PacketType: 'data',
      });
    }
    const sender = createWebContents();
    const send = sender.send;

    await service.attachSession(
      { taskId: 'task-1', sessionId: session.id },
      sender,
    );

    const frames = send.mock.calls
      .filter(([channel]) => channel === 'mobilePreview:frame')
      .map(([, payload]) => payload as { frameBase64: string; keyframe?: boolean });
    expect(frames).toHaveLength(MOBILE_PREVIEW_MAX_H264_REPLAY_PACKETS + 1);
    expect(Buffer.from(frames[0].frameBase64, 'base64').toString()).toBe(
      'config-latest',
    );
    expect(Buffer.from(frames[1].frameBase64, 'base64').toString()).toBe(
      'keyframe',
    );
    expect(frames[1].keyframe).toBe(true);
    expect(
      Buffer.from(frames.at(-1)!.frameBase64, 'base64').toString(),
    ).toBe(`packet-${MOBILE_PREVIEW_MAX_H264_REPLAY_PACKETS - 1}`);

    android.starts[0].onFrame({
      data: Buffer.from('overflow'),
      h264PacketType: 'data',
    });
    send.mockClear();
    await service.attachSession(
      { taskId: 'task-1', sessionId: session.id },
      sender,
    );
    expect(
      send.mock.calls.filter(
        ([channel]) => channel === 'mobilePreview:frame',
      ),
    ).toHaveLength(2);
  });

  it('invalidates H264 keyframe replay when configuration changes', async () => {
    const { service, android } = createService();
    const session = await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'android',
      deviceId: 'device-1',
    });
    android.starts[0].onSession({ frameFormat: 'h264' });
    android.starts[0].onFrame({
      data: Buffer.from('config-1'),
      h264PacketType: 'configuration',
    });
    android.starts[0].onFrame({
      data: Buffer.from('keyframe-1'),
      h264PacketType: 'data',
      keyframe: true,
    });
    android.starts[0].onFrame({
      data: Buffer.from('delta-1'),
      h264PacketType: 'data',
    });
    android.starts[0].onFrame({
      data: Buffer.from('config-2'),
      h264PacketType: 'configuration',
    });
    android.starts[0].onFrame({
      data: Buffer.from('delta-after-config'),
      h264PacketType: 'data',
    });
    const send = vi.fn();

    await service.attachSession(
      { taskId: 'task-1', sessionId: session.id },
      { send, isDestroyed: () => false } as unknown as WebContents,
    );

    const frames = send.mock.calls
      .filter(([channel]) => channel === 'mobilePreview:frame')
      .map(([, payload]) => payload as { frameBase64: string });
    expect(frames).toHaveLength(1);
    expect(Buffer.from(frames[0].frameBase64, 'base64').toString()).toBe(
      'config-2',
    );
  });

  it('drops oversized image frames from replay cache', async () => {
    const { service, ios } = createService();
    const session = await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });
    ios.starts[0].onFrame(
      Buffer.alloc(Math.floor((MOBILE_PREVIEW_REPLAY_BYTE_LIMIT * 3) / 4) + 1),
    );
    const sender = createWebContents();

    await service.attachSession(
      { taskId: 'task-1', sessionId: session.id },
      sender,
    );

    expect(
      sender.send.mock.calls.filter(([channel]) => channel === 'mobilePreview:frame'),
    ).toHaveLength(0);
  });

  it('keeps H264 configuration but evicts bootstrap exceeding byte budget', async () => {
    const { service, android } = createService();
    const session = await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'android',
      deviceId: 'device-1',
    });
    android.starts[0].onSession({ frameFormat: 'h264' });
    android.starts[0].onFrame({
      data: Buffer.from('config'),
      h264PacketType: 'configuration',
    });
    android.starts[0].onFrame({
      data: Buffer.alloc(MOBILE_PREVIEW_REPLAY_BYTE_LIMIT),
      h264PacketType: 'data',
      keyframe: true,
    });
    const sender = createWebContents();

    await service.attachSession(
      { taskId: 'task-1', sessionId: session.id },
      sender,
    );

    const frames = sender.send.mock.calls.filter(
      ([channel]) => channel === 'mobilePreview:frame',
    );
    expect(frames).toHaveLength(1);
    expect(
      Buffer.from((frames[0][1] as { frameBase64: string }).frameBase64, 'base64').toString(),
    ).toBe('config');
  });

  it('does not retain oversized H264 configuration', async () => {
    const { service, android } = createService();
    const session = await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'android',
      deviceId: 'device-1',
    });
    android.starts[0].onSession({ frameFormat: 'h264' });
    android.starts[0].onFrame({
      data: Buffer.alloc(MOBILE_PREVIEW_REPLAY_BYTE_LIMIT + 1),
      h264PacketType: 'configuration',
    });
    const sender = createWebContents();

    await service.attachSession(
      { taskId: 'task-1', sessionId: session.id },
      sender,
    );

    expect(
      sender.send.mock.calls.filter(([channel]) => channel === 'mobilePreview:frame'),
    ).toHaveLength(0);
  });

  it('evicts H264 deltas while preserving configuration and keyframe', async () => {
    const { service, android } = createService();
    const session = await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'android',
      deviceId: 'device-1',
    });
    android.starts[0].onSession({ frameFormat: 'h264' });
    android.starts[0].onFrame({
      data: Buffer.from('config'),
      h264PacketType: 'configuration',
    });
    android.starts[0].onFrame({
      data: Buffer.from('keyframe'),
      h264PacketType: 'data',
      keyframe: true,
    });
    android.starts[0].onFrame({
      data: Buffer.alloc(MOBILE_PREVIEW_REPLAY_BYTE_LIMIT),
      h264PacketType: 'data',
    });
    const sender = createWebContents();

    await service.attachSession(
      { taskId: 'task-1', sessionId: session.id },
      sender,
    );

    const frames = sender.send.mock.calls
      .filter(([channel]) => channel === 'mobilePreview:frame')
      .map(([, payload]) =>
        Buffer.from(
          (payload as { frameBase64: string }).frameBase64,
          'base64',
        ).toString(),
      );
    expect(frames).toEqual(['config', 'keyframe']);
  });

  it('ignores replay and future events when attached sender is destroyed', async () => {
    const { service, ios } = createService();
    const liveSend = vi.fn();
    const session = await service.start(
      {
        taskId: 'task-1',
        projectPath: '/project',
        platform: 'ios',
        deviceId: 'device-1',
      },
      { send: liveSend, isDestroyed: () => false } as unknown as WebContents,
    );
    ios.starts[0].onFrame(Buffer.from('frame'));
    liveSend.mockClear();
    const send = vi.fn(() => {
      throw new Error('destroyed sender used');
    });
    const destroyedSender = {
      send,
      isDestroyed: () => true,
    } as unknown as WebContents;

    await expect(
      service.attachSession(
        { taskId: 'task-1', sessionId: session.id },
        destroyedSender,
      ),
    ).resolves.toEqual(session);
    expect(() => ios.starts[0].onFrame(Buffer.from('future'))).not.toThrow();
    expect(() => ios.starts[0].onSession({ width: 390 })).not.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(liveSend).toHaveBeenCalledTimes(2);
  });

  it('buffers a frame emitted before session registration', async () => {
    const { service } = createService({ emitIosFrameBeforeStartReturns: true });
    const send = vi.fn();
    const session = await service.start(
      {
        taskId: 'task-1',
        projectPath: '/project',
        platform: 'ios',
        deviceId: 'device-1',
      },
      { send } as unknown as WebContents,
    );

    expect(send).toHaveBeenCalledWith('mobilePreview:frame', {
      sessionId: session.id,
      frameBase64: Buffer.from('early-frame').toString('base64'),
    });
  });

  it('buffers all h264 packets emitted before session registration', async () => {
    const { service } = createService({
      emitAndroidH264FramesBeforeStartReturns: true,
    });
    const send = vi.fn();
    const session = await service.start(
      {
        taskId: 'task-1',
        projectPath: '/project',
        platform: 'android',
        deviceId: 'device-1',
      },
      { send } as unknown as WebContents,
    );

    expect(send).toHaveBeenCalledWith('mobilePreview:frame', {
      sessionId: session.id,
      frameBase64: Buffer.from('config').toString('base64'),
      h264PacketType: 'configuration',
      keyframe: undefined,
    });
    expect(send).toHaveBeenCalledWith('mobilePreview:frame', {
      sessionId: session.id,
      frameBase64: Buffer.from('data').toString('base64'),
      h264PacketType: 'data',
      keyframe: true,
    });
  });

  it('caps frames emitted before session registration', async () => {
    const { service } = createService({
      emitAndroidFrameCountBeforeStartReturns: 12,
    });
    const send = vi.fn();

    await service.start(
      {
        taskId: 'task-1',
        projectPath: '/project',
        platform: 'android',
        deviceId: 'device-1',
      },
      { send } as unknown as WebContents,
    );

    const frameEvents = send.mock.calls.filter(
      ([channel]) => channel === 'mobilePreview:frame',
    );
    expect(frameEvents).toHaveLength(8);
    expect(frameEvents.at(-1)?.[1]).toMatchObject({
      frameBase64: Buffer.from('early-frame-7').toString('base64'),
    });
  });

  it('session patch callback merges patch and emits session event', async () => {
    const { service, ios } = createService();
    const send = vi.fn();
    const session = await service.start(
      {
        taskId: 'task-1',
        projectPath: '/project',
        platform: 'ios',
        deviceId: 'device-1',
      },
      { send } as unknown as WebContents,
    );

    ios.starts[0].onSession({ width: 390, height: 844, error: 'warmup' });

    const patchedSession = {
      ...session,
      width: 390,
      height: 844,
      error: 'warmup',
    };
    expect(service.getActiveSession(session.id)).toEqual(patchedSession);
    expect(send).toHaveBeenLastCalledWith('mobilePreview:session', {
      session: patchedSession,
    });
  });

  it('sendInput delegates to adapter for stored platform and device', async () => {
    const { service, android } = createService();
    const session = await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'android',
      deviceId: 'android-device-1',
    });
    const event: MobilePreviewInputEvent = { type: 'tap', x: 10, y: 20 };

    await service.sendInput(session.id, event);

    expect(android.sentInputs).toEqual([
      { deviceId: 'android-device-1', event },
    ]);
  });

  it('setColorScheme delegates to adapter for stored platform and device', async () => {
    const { service, ios } = createService();
    const session = await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'ios-device-1',
    });

    await service.setColorScheme(session.id, 'dark');

    expect(ios.colorSchemes).toEqual([
      { deviceId: 'ios-device-1', scheme: 'dark' },
    ]);
  });

  it('rotate delegates to adapter for stored platform and device', async () => {
    const { service, android } = createService();
    const session = await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'android',
      deviceId: 'android-device-1',
    });

    await service.rotate(session.id, 'right');

    expect(android.rotations).toEqual([
      { deviceId: 'android-device-1', direction: 'right' },
    ]);
  });

  it('listDevices delegates by platform', async () => {
    const { service, ios, android } = createService();

    await expect(service.listDevices('ios')).resolves.toBe(ios.devices);
    await expect(service.listDevices('android')).resolves.toBe(android.devices);

    expect(ios.adapter.listDevices).toHaveBeenCalledTimes(1);
    expect(android.adapter.listDevices).toHaveBeenCalledTimes(1);
  });

  it('listDevices throws clear error for unsupported platform', async () => {
    const { service, ios, android } = createService();

    await expect(
      service.listDevices('windows' as MobilePlatform),
    ).rejects.toThrow('Unsupported mobile preview platform: windows');

    expect(ios.adapter.listDevices).not.toHaveBeenCalled();
    expect(android.adapter.listDevices).not.toHaveBeenCalled();
  });

  it('start throws clear error for unsupported platform', async () => {
    const { service, ios, android } = createService();

    await expect(
      service.start({
        taskId: 'task-1',
        projectPath: '/project',
        platform: 'windows' as MobilePlatform,
        deviceId: 'device-1',
      }),
    ).rejects.toThrow('Unsupported mobile preview platform: windows');

    expect(ios.adapter.startStream).not.toHaveBeenCalled();
    expect(android.adapter.startStream).not.toHaveBeenCalled();
  });

  it('starts same-task devices concurrently without holding the task lock', async () => {
    const { service, ios } = createService({ deferIosStarts: true });

    const firstStart = service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });
    await vi.waitFor(() => expect(ios.startControls).toHaveLength(1));
    const secondStart = service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-2',
    });

    await vi.waitFor(() => expect(ios.startControls).toHaveLength(2));
    ios.startControls[0].resolve();
    const firstSession = await firstStart;
    ios.startControls[1].resolve();
    const secondSession = await secondStart;

    expect(firstSession.status).not.toBe('stopped');
    expect(ios.stops[0]).not.toHaveBeenCalled();
    expect(ios.stops[1]).not.toHaveBeenCalled();
    expect(service.getActiveSession(firstSession.id)).toEqual(firstSession);
    expect(service.getActiveSession(secondSession.id)).toEqual(secondSession);
  });

  it('self-stops a late same-device start superseded during adapter startup', async () => {
    const { service, ios } = createService({ deferIosStarts: true });

    const firstStart = service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });
    await vi.waitFor(() => expect(ios.startControls).toHaveLength(1));
    const secondStart = service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });

    await vi.waitFor(() => expect(ios.startControls).toHaveLength(2));
    ios.startControls[1].resolve();
    const secondSession = await secondStart;
    ios.startControls[0].resolve();
    const firstSession = await firstStart;

    expect(firstSession.status).toBe('stopped');
    expect(ios.stops[0]).toHaveBeenCalledTimes(1);
    expect(service.getActiveSession(firstSession.id)).toBeNull();
    expect(service.getActiveSession(secondSession.id)).toEqual(secondSession);
  });

  it('before-quit cleanup stops active sessions', async () => {
    let beforeQuit: ((event?: { preventDefault: () => void }) => void) | null =
      null;
    const preventDefault = vi.fn();
    const { service, ios } = createService({
      lifecycle: {
        onBeforeQuit: (callback) => {
          beforeQuit = callback;
        },
      },
    });
    const session = await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });

    expect(beforeQuit).toBeTypeOf('function');
    (beforeQuit as unknown as (event?: { preventDefault: () => void }) => void)(
      {
        preventDefault,
      },
    );
    await sleep(0);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(ios.stops[0]).toHaveBeenCalledTimes(1);
    expect(service.getActiveSession(session.id)).toBeNull();
  });

  it('stopAll awaits and stops a stream whose start is pending', async () => {
    const { service, ios } = createService({ deferIosStarts: true });
    const start = service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });
    await vi.waitFor(() => expect(ios.startControls).toHaveLength(1));
    let cleanupFinished = false;

    const cleanup = service.stopAll().then(() => {
      cleanupFinished = true;
    });
    await sleep(0);

    expect(cleanupFinished).toBe(false);
    expect(ios.dispose).toHaveBeenCalledTimes(1);
    await expect(
      service.start({
        taskId: 'task-2',
        projectPath: '/project',
        platform: 'ios',
        deviceId: 'device-2',
      }),
    ).rejects.toThrow('Mobile preview service is shutting down.');
    expect(ios.adapter.startStream).toHaveBeenCalledTimes(1);

    ios.startControls[0].resolve();
    const session = await start;
    await cleanup;

    expect(session.status).toBe('stopped');
    expect(ios.stops[0]).toHaveBeenCalledTimes(1);
    expect(service.getActiveSession(session.id)).toBeNull();
    expect(ios.dispose).toHaveBeenCalledTimes(1);
  });

  it('stopAll begins adapter disposal while a stream start is pending', async () => {
    const { service, ios, android } = createService({ deferIosStarts: true });
    const start = service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });
    await vi.waitFor(() => expect(ios.startControls).toHaveLength(1));

    const cleanup = service.stopAll();
    await sleep(0);

    expect(ios.dispose).toHaveBeenCalledTimes(1);
    expect(android.dispose).toHaveBeenCalledTimes(1);

    ios.startControls[0].resolve();
    await start;
    await cleanup;
  });

  it('stopAll is single-flight across concurrent and repeated calls', async () => {
    const { service, ios, android } = createService();

    const firstCleanup = service.stopAll();
    const concurrentCleanup = service.stopAll();

    expect(concurrentCleanup).toBe(firstCleanup);
    await firstCleanup;
    expect(service.stopAll()).toBe(firstCleanup);
    expect(ios.dispose).toHaveBeenCalledTimes(1);
    expect(android.dispose).toHaveBeenCalledTimes(1);
  });

  it('stopAll times out pending starts and late streams still stop', async () => {
    vi.useFakeTimers();
    const { service, ios } = createService({ deferIosStarts: true });
    const start = service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });
    await Promise.resolve();
    expect(ios.startControls).toHaveLength(1);
    const cleanup = service.stopAll();
    let cleanupError: unknown;
    let cleanupSettled = false;
    void cleanup.then(
      () => {
        cleanupSettled = true;
      },
      (error: unknown) => {
        cleanupError = error;
        cleanupSettled = true;
      },
    );

    try {
      await vi.advanceTimersByTimeAsync(
        MOBILE_PREVIEW_PENDING_START_TIMEOUT_MS,
      );

      expect(cleanupSettled).toBe(true);
      expect(cleanupError).toBeInstanceOf(AggregateError);
      expect((cleanupError as AggregateError).errors).toEqual([
        expect.objectContaining({
          message: 'Timed out waiting for mobile preview streams to start.',
        }),
      ]);

      ios.startControls[0].resolve();
      const session = await start;

      expect(session.status).toBe('stopped');
      expect(ios.stops[0]).toHaveBeenCalledTimes(1);
      expect(service.getActiveSession(session.id)).toBeNull();
    } finally {
      ios.startControls[0]?.resolve();
      await start;
      await cleanup.catch(() => {});
      vi.useRealTimers();
    }
  });

  it('stopAll disposes every adapter when a session stop rejects', async () => {
    const { service, ios, android } = createService({ rejectIosStops: true });
    await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });

    const cleanupError = await service.stopAll().catch((error: unknown) => error);

    expect(cleanupError).toBeInstanceOf(AggregateError);
    expect((cleanupError as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'stop failed' }),
    ]);
    expect(ios.stops[0]).toHaveBeenCalledTimes(1);
    expect(ios.dispose).toHaveBeenCalledTimes(1);
    expect(android.dispose).toHaveBeenCalledTimes(1);
  });

  it('before-quit cleanup ignores repeated quit events after cleanup', async () => {
    let beforeQuit: ((event?: { preventDefault: () => void }) => void) | null =
      null;
    const preventDefault = vi.fn();
    const { service, ios } = createService({
      lifecycle: {
        onBeforeQuit: (callback) => {
          beforeQuit = callback;
        },
      },
    });
    await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });

    expect(beforeQuit).toBeTypeOf('function');
    (beforeQuit as unknown as (event?: { preventDefault: () => void }) => void)(
      {
        preventDefault,
      },
    );
    await sleep(0);
    (beforeQuit as unknown as (event?: { preventDefault: () => void }) => void)(
      {
        preventDefault,
      },
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(ios.stops[0]).toHaveBeenCalledTimes(1);
  });

  it('before-quit cleanup catches async stop rejection', async () => {
    let beforeQuit: ((event?: { preventDefault: () => void }) => void) | null =
      null;
    const logger = { error: vi.fn() };
    const preventDefault = vi.fn();
    const { service, ios } = createService({
      lifecycle: {
        onBeforeQuit: (callback) => {
          beforeQuit = callback;
        },
      },
      logger,
      rejectIosStops: true,
    });
    const session = await service.start({
      taskId: 'task-1',
      projectPath: '/project',
      platform: 'ios',
      deviceId: 'device-1',
    });

    expect(beforeQuit).toBeTypeOf('function');
    (beforeQuit as unknown as (event?: { preventDefault: () => void }) => void)(
      {
        preventDefault,
      },
    );
    await sleep(0);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(ios.stops[0]).toHaveBeenCalledTimes(1);
    expect(service.getActiveSession(session.id)).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to stop mobile preview sessions before quit:',
      expect.any(Error),
    );
  });

  it('avoids duplicate before-quit listener registration across setup calls', () => {
    const onBeforeQuit = vi.fn();

    createService({ lifecycle: { onBeforeQuit } });
    createService({ lifecycle: { onBeforeQuit } });

    expect(onBeforeQuit).toHaveBeenCalledTimes(1);
  });
});
