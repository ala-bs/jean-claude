// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { api } from '@/lib/api';

import type {
  MobilePreviewFrameEvent,
  MobilePreviewSession,
  MobilePreviewSessionEvent,
} from '@shared/mobile-simulator-types';
import { MOBILE_PREVIEW_H264_REPLAY_CHUNK_LIMIT } from '@shared/mobile-simulator-types';

import { useMobilePreviewSession } from './use-mobile-preview';

describe('useMobilePreviewSession pending start cancellation', () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.spyOn(api.mobilePreview, 'onSession').mockReturnValue(() => undefined);
    vi.spyOn(api.mobilePreview, 'onFrame').mockReturnValue(() => undefined);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not activate a pending start that resolves after cancellation', async () => {
    let sessionListener: ((event: MobilePreviewSessionEvent) => void) | undefined;
    vi.mocked(api.mobilePreview.onSession).mockImplementation((listener) => {
      sessionListener = listener;
      return () => undefined;
    });
    let resolveStart!: (session: MobilePreviewSession) => void;
    const startRequest = new Promise<MobilePreviewSession>((resolve) => {
      resolveStart = resolve;
    });
    vi.spyOn(api.mobilePreview, 'start').mockReturnValue(startRequest);
    const stop = vi.spyOn(api.mobilePreview, 'stop').mockResolvedValue();
    let preview: ReturnType<typeof useMobilePreviewSession> | undefined;

    function Harness() {
      preview = useMobilePreviewSession('task-1', {
        platform: 'ios',
        deviceId: 'device-1',
      });
      return null;
    }

    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(Harness),
        ),
      );
    });

    let pendingStart!: ReturnType<
      NonNullable<typeof preview>['start']
    >;
    act(() => {
      pendingStart = preview!.start({
        projectPath: '/project',
        platform: 'ios',
        deviceId: 'device-1',
      });
      preview!.cancelStart();
    });
    const startedSession = {
      id: 'session-1',
      taskId: 'task-1',
      platform: 'ios',
      deviceId: 'device-1',
      status: 'streaming',
      width: 390,
      height: 844,
      frameFormat: 'h264',
      streamStrategy: 'idb-h264-stream',
      inputStatus: 'ready',
      error: null,
    } satisfies MobilePreviewSession;

    act(() => sessionListener?.({ session: startedSession }));
    expect(preview!.session).toBeNull();
    await act(async () => {
      resolveStart(startedSession);
      await pendingStart;
    });

    expect(preview!.session).toBeNull();
    expect(stop).toHaveBeenCalledWith('session-1');

    act(() => sessionListener?.({ session: startedSession }));
    expect(preview!.session).toBeNull();
  });

  it('does not activate an old-device start after switching devices', async () => {
    let sessionListener: ((event: MobilePreviewSessionEvent) => void) | undefined;
    vi.mocked(api.mobilePreview.onSession).mockImplementation((listener) => {
      sessionListener = listener;
      return () => undefined;
    });
    let resolveStart!: (session: MobilePreviewSession) => void;
    vi.spyOn(api.mobilePreview, 'start').mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    const stop = vi.spyOn(api.mobilePreview, 'stop').mockResolvedValue();
    let selectedDevice = { platform: 'ios' as const, deviceId: 'device-1' };
    let preview: ReturnType<typeof useMobilePreviewSession> | undefined;

    function Harness() {
      preview = useMobilePreviewSession('task-1', selectedDevice);
      return null;
    }

    const queryClient = new QueryClient();
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness),
        ),
      );
    });
    let pendingStart!: ReturnType<NonNullable<typeof preview>['start']>;
    act(() => {
      pendingStart = preview!.start({
        projectPath: '/project',
        platform: 'ios',
        deviceId: 'device-1',
      });
      preview!.cancelStart();
      selectedDevice = { platform: 'ios', deviceId: 'device-2' };
      root?.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness),
        ),
      );
    });
    const oldSession = createSession('session-old', 'device-1');

    act(() => sessionListener?.({ session: oldSession }));
    expect(preview!.session).toBeNull();
    await act(async () => {
      resolveStart(oldSession);
      await pendingStart;
    });

    expect(preview!.session).toBeNull();
    expect(stop).toHaveBeenCalledWith('session-old');
  });

  it('rejects stale same-device events across cancel and restart', async () => {
    let sessionListener: ((event: MobilePreviewSessionEvent) => void) | undefined;
    vi.mocked(api.mobilePreview.onSession).mockImplementation((listener) => {
      sessionListener = listener;
      return () => undefined;
    });
    let resolveFirst!: (session: MobilePreviewSession) => void;
    let resolveSecond!: (session: MobilePreviewSession) => void;
    vi.spyOn(api.mobilePreview, 'start')
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
      );
    const stop = vi.spyOn(api.mobilePreview, 'stop').mockResolvedValue();
    let preview: ReturnType<typeof useMobilePreviewSession> | undefined;

    function Harness() {
      preview = useMobilePreviewSession('task-1', {
        platform: 'ios',
        deviceId: 'device-1',
      });
      return null;
    }

    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(Harness),
        ),
      );
      await Promise.resolve();
    });
    let firstStart!: ReturnType<NonNullable<typeof preview>['start']>;
    let secondStart!: ReturnType<NonNullable<typeof preview>['start']>;
    await act(async () => {
      firstStart = preview!.start({
        projectPath: '/project',
        platform: 'ios',
        deviceId: 'device-1',
      });
      preview!.cancelStart();
      secondStart = preview!.start({
        projectPath: '/project',
        platform: 'ios',
        deviceId: 'device-1',
      });
      await Promise.resolve();
    });

    const staleSession = createSession('session-stale', 'device-1');
    const currentSession = createSession('session-current', 'device-1');
    act(() => sessionListener?.({ session: staleSession }));
    expect(preview!.session).toBeNull();

    await act(async () => {
      resolveFirst(staleSession);
      await firstStart;
    });
    expect(stop).toHaveBeenCalledWith('session-stale');
    act(() => sessionListener?.({ session: staleSession }));
    expect(preview!.session).toBeNull();

    await act(async () => {
      resolveSecond(currentSession);
      await secondStart;
    });
    expect(preview!.session?.id).toBe('session-current');

    act(() => sessionListener?.({ session: staleSession }));
    expect(preview!.session?.id).toBe('session-current');

    const currentUpdate = { ...currentSession, inputStatus: 'ready' as const };
    act(() => sessionListener?.({ session: currentUpdate }));
    expect(preview!.session).toEqual(currentUpdate);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(preview!.session?.id).toBe('session-current');
  });

  it('keeps newer same-device cancellation when older start resolves first', async () => {
    let sessionListener: ((event: MobilePreviewSessionEvent) => void) | undefined;
    vi.mocked(api.mobilePreview.onSession).mockImplementation((listener) => {
      sessionListener = listener;
      return () => undefined;
    });
    let resolveFirst!: (session: MobilePreviewSession) => void;
    let resolveSecond!: (session: MobilePreviewSession) => void;
    vi.spyOn(api.mobilePreview, 'start')
      .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (resolveSecond = resolve)));
    vi.spyOn(api.mobilePreview, 'stop').mockResolvedValue();
    let preview: ReturnType<typeof useMobilePreviewSession> | undefined;

    function Harness() {
      preview = useMobilePreviewSession('task-1', {
        platform: 'ios',
        deviceId: 'device-1',
      });
      return null;
    }

    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(Harness),
        ),
      );
    });
    let firstStart!: ReturnType<NonNullable<typeof preview>['start']>;
    let secondStart!: ReturnType<NonNullable<typeof preview>['start']>;
    await act(async () => {
      firstStart = preview!.start(startParams);
      preview!.cancelStart();
      secondStart = preview!.start(startParams);
      preview!.cancelStart();
      await Promise.resolve();
    });

    await act(async () => {
      resolveFirst(createSession('session-first', 'device-1'));
      await firstStart;
    });
    act(() =>
      sessionListener?.({
        session: createSession('session-second', 'device-1'),
      }),
    );
    expect(preview!.session).toBeNull();

    await act(async () => {
      resolveSecond(createSession('session-second', 'device-1'));
      await secondStart;
    });
    expect(preview!.session).toBeNull();
  });

  it('replays ordered H264 frames buffered before exact start response', async () => {
    let sessionListener: ((event: MobilePreviewSessionEvent) => void) | undefined;
    let frameListener: ((event: MobilePreviewFrameEvent) => void) | undefined;
    vi.mocked(api.mobilePreview.onSession).mockImplementation((listener) => {
      sessionListener = listener;
      return () => undefined;
    });
    vi.mocked(api.mobilePreview.onFrame).mockImplementation((listener) => {
      frameListener = listener;
      return () => undefined;
    });
    let resolveStart!: (session: MobilePreviewSession) => void;
    vi.spyOn(api.mobilePreview, 'start').mockReturnValue(
      new Promise((resolve) => (resolveStart = resolve)),
    );
    vi.spyOn(api.mobilePreview, 'stop').mockResolvedValue();
    const animationFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    let preview: ReturnType<typeof useMobilePreviewSession> | undefined;

    function Harness() {
      preview = useMobilePreviewSession('task-1', {
        platform: 'ios',
        deviceId: 'device-1',
      });
      return null;
    }

    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(Harness),
        ),
      );
    });
    const chunks: Array<{ h264PacketType?: string; frameBase64: string }> = [];
    const unsubscribe = preview!.subscribeH264Chunks((chunk) => chunks.push(chunk));
    let pendingStart!: ReturnType<NonNullable<typeof preview>['start']>;
    act(() => {
      pendingStart = preview!.start(startParams);
      const earlySession = createSession('session-early', 'device-1');
      sessionListener?.({ session: earlySession });
      frameListener?.({
        sessionId: earlySession.id,
        frameBase64: 'config',
        h264PacketType: 'configuration',
      });
      frameListener?.({
        sessionId: earlySession.id,
        frameBase64: 'keyframe',
        h264PacketType: 'data',
        keyframe: true,
      });
    });
    expect(chunks).toEqual([]);

    await act(async () => {
      resolveStart(createSession('session-early', 'device-1'));
      await pendingStart;
      animationFrames.splice(0).forEach((callback) => callback(0));
    });

    expect(chunks).toEqual([
      { frameBase64: 'config', h264PacketType: 'configuration', keyframe: undefined },
      { frameBase64: 'keyframe', h264PacketType: 'data', keyframe: true },
    ]);
    unsubscribe();
  });

  it('retains sessions across task changes and unmount', async () => {
    const retainedSession = createSession('session-retained', 'device-1');
    vi.spyOn(api.mobilePreview, 'listSessions').mockImplementation(
      async ({ taskId }) => (taskId === 'task-1' ? [retainedSession] : []),
    );
    vi.spyOn(api.mobilePreview, 'attachSession').mockResolvedValue(
      retainedSession,
    );
    const stop = vi.spyOn(api.mobilePreview, 'stop').mockResolvedValue();
    const detach = vi
      .spyOn(api.mobilePreview, 'detachSession')
      .mockResolvedValue();
    let taskId = 'task-1';

    function Harness() {
      useMobilePreviewSession(
        taskId,
        { platform: 'ios', deviceId: 'device-1' },
        { retainSessions: true },
      );
      return null;
    }

    const queryClient = new QueryClient();
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness),
        ),
      );
      await Promise.resolve();
    });

    taskId = 'task-2';
    await act(async () => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness),
        ),
      );
      await Promise.resolve();
    });
    act(() => root?.unmount());
    root = null;

    expect(stop).not.toHaveBeenCalled();
    expect(detach).toHaveBeenCalledWith({
      taskId: 'task-1',
      sessionId: retainedSession.id,
    });
  });

  it('detaches old selected retained session before attaching the new selection', async () => {
    const firstSession = createSession('session-first', 'device-1');
    const secondSession = createSession('session-second', 'device-2');
    vi.spyOn(api.mobilePreview, 'listSessions').mockResolvedValue([
      firstSession,
      secondSession,
    ]);
    const attach = vi
      .spyOn(api.mobilePreview, 'attachSession')
      .mockImplementation(async ({ sessionId }) =>
        sessionId === firstSession.id ? firstSession : secondSession,
      );
    const detach = vi
      .spyOn(api.mobilePreview, 'detachSession')
      .mockResolvedValue();
    vi.spyOn(api.mobilePreview, 'stop').mockResolvedValue();
    let selectedDevice = { platform: 'ios' as const, deviceId: 'device-1' };

    function Harness() {
      useMobilePreviewSession('task-1', selectedDevice, {
        retainSessions: true,
      });
      return null;
    }

    const queryClient = new QueryClient();
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness),
        ),
      );
      await Promise.resolve();
    });

    selectedDevice = { platform: 'ios', deviceId: 'device-2' };
    await act(async () => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness),
        ),
      );
      await Promise.resolve();
    });

    expect(attach).toHaveBeenCalledWith({
      taskId: 'task-1',
      sessionId: firstSession.id,
    });
    expect(detach).toHaveBeenCalledWith({
      taskId: 'task-1',
      sessionId: firstSession.id,
    });
    expect(attach).toHaveBeenCalledWith({
      taskId: 'task-1',
      sessionId: secondSession.id,
    });
  });

  it('detaches a newly started retained session on selected-device switch', async () => {
    vi.spyOn(api.mobilePreview, 'listSessions').mockResolvedValue([]);
    vi.spyOn(api.mobilePreview, 'attachSession').mockRejectedValue(
      new Error('unexpected attach'),
    );
    const startedSession = createSession('session-started', 'device-1');
    vi.spyOn(api.mobilePreview, 'start').mockResolvedValue(startedSession);
    const detach = vi
      .spyOn(api.mobilePreview, 'detachSession')
      .mockResolvedValue();
    vi.spyOn(api.mobilePreview, 'stop').mockResolvedValue();
    let selectedDevice = { platform: 'ios' as const, deviceId: 'device-1' };
    let preview: ReturnType<typeof useMobilePreviewSession> | undefined;

    function Harness() {
      preview = useMobilePreviewSession('task-1', selectedDevice, {
        retainSessions: true,
      });
      return null;
    }

    const queryClient = new QueryClient();
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness),
        ),
      );
      await Promise.resolve();
    });
    await act(async () => {
      await preview!.start(startParams);
    });

    selectedDevice = { platform: 'ios', deviceId: 'device-2' };
    await act(async () => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness),
        ),
      );
      await Promise.resolve();
    });

    expect(detach).toHaveBeenCalledWith({
      taskId: 'task-1',
      sessionId: startedSession.id,
    });
  });

  it('stops a retained session whose pending start resolves after explicit stop', async () => {
    let resolveStart!: (session: MobilePreviewSession) => void;
    const startRequest = new Promise<MobilePreviewSession>((resolve) => {
      resolveStart = resolve;
    });
    vi.spyOn(api.mobilePreview, 'listSessions').mockResolvedValue([]);
    vi.spyOn(api.mobilePreview, 'attachSession').mockImplementation(() =>
      Promise.reject(new Error('unexpected attach')),
    );
    vi.spyOn(api.mobilePreview, 'start').mockReturnValue(startRequest);
    const stop = vi.spyOn(api.mobilePreview, 'stop').mockResolvedValue();
    const selectedDevice = { platform: 'ios' as const, deviceId: 'device-1' };
    let preview: ReturnType<typeof useMobilePreviewSession> | undefined;

    function Harness() {
      preview = useMobilePreviewSession('task-1', selectedDevice, {
        retainSessions: true,
      });
      return null;
    }

    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(Harness),
        ),
      );
      await Promise.resolve();
    });

    let pendingStart!: ReturnType<NonNullable<typeof preview>['start']>;
    await act(async () => {
      pendingStart = preview!.start(startParams);
      await preview!.stop();
    });
    const startedSession = createSession('session-late', 'device-1');
    await act(async () => {
      resolveStart(startedSession);
      await pendingStart;
    });

    expect(preview!.session).toBeNull();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(startedSession.id);
  });

  it('ignores delayed hydration after a newer retained start', async () => {
    let resolveList!: (sessions: MobilePreviewSession[]) => void;
    vi.spyOn(api.mobilePreview, 'listSessions').mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );
    const attach = vi.spyOn(api.mobilePreview, 'attachSession');
    const startedSession = createSession('session-new', 'device-1');
    vi.spyOn(api.mobilePreview, 'start').mockResolvedValue(startedSession);
    vi.spyOn(api.mobilePreview, 'stop').mockResolvedValue();
    const selectedDevice = { platform: 'ios' as const, deviceId: 'device-1' };
    let preview: ReturnType<typeof useMobilePreviewSession> | undefined;

    function Harness() {
      preview = useMobilePreviewSession('task-1', selectedDevice, {
        retainSessions: true,
      });
      return null;
    }

    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(Harness),
        ),
      );
    });
    await act(async () => {
      await preview!.start(startParams);
      resolveList([createSession('session-old', 'device-1')]);
      await Promise.resolve();
    });

    expect(preview!.session).toEqual(startedSession);
    expect(attach).not.toHaveBeenCalled();
  });

  it('ignores delayed hydration after a newer retained stop', async () => {
    let resolveList!: (sessions: MobilePreviewSession[]) => void;
    vi.spyOn(api.mobilePreview, 'listSessions').mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );
    const attach = vi.spyOn(api.mobilePreview, 'attachSession');
    vi.spyOn(api.mobilePreview, 'stop').mockResolvedValue();
    const selectedDevice = { platform: 'ios' as const, deviceId: 'device-1' };
    let preview: ReturnType<typeof useMobilePreviewSession> | undefined;

    function Harness() {
      preview = useMobilePreviewSession('task-1', selectedDevice, {
        retainSessions: true,
      });
      return null;
    }

    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(Harness),
        ),
      );
    });
    await act(async () => {
      await preview!.stop();
      resolveList([createSession('session-old', 'device-1')]);
      await Promise.resolve();
    });

    expect(preview!.session).toBeNull();
    expect(attach).not.toHaveBeenCalled();
  });

  it('cancels a pending retained start when newer hydration takes ownership', async () => {
    vi.spyOn(api.mobilePreview, 'listSessions').mockResolvedValue([]);
    let sessionListener: ((event: MobilePreviewSessionEvent) => void) | undefined;
    vi.mocked(api.mobilePreview.onSession).mockImplementation((listener) => {
      sessionListener = listener;
      return () => undefined;
    });
    let resolveStart!: (session: MobilePreviewSession) => void;
    vi.spyOn(api.mobilePreview, 'start').mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    const stop = vi.spyOn(api.mobilePreview, 'stop').mockResolvedValue();
    let selectedDevice = { platform: 'ios' as const, deviceId: 'device-1' };
    let preview: ReturnType<typeof useMobilePreviewSession> | undefined;

    function Harness() {
      preview = useMobilePreviewSession('task-1', selectedDevice, {
        retainSessions: true,
      });
      return null;
    }

    const queryClient = new QueryClient();
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness),
        ),
      );
      await Promise.resolve();
    });

    let pendingStart!: ReturnType<NonNullable<typeof preview>['start']>;
    act(() => {
      pendingStart = preview!.start(startParams);
    });
    selectedDevice = { platform: 'ios', deviceId: 'device-2' };
    await act(async () => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness),
        ),
      );
      await Promise.resolve();
    });

    const staleSession = createSession('session-stale', 'device-1');
    await act(async () => {
      resolveStart(staleSession);
      await pendingStart;
    });
    const futureSession = createSession('session-future', 'device-2');
    act(() => sessionListener?.({ session: futureSession }));

    expect(stop).toHaveBeenCalledWith(staleSession.id);
    expect(preview!.session).toEqual(futureSession);
  });

  it('hydrates and attaches selected retained session before accepting replay', async () => {
    let frameListener: ((event: MobilePreviewFrameEvent) => void) | undefined;
    vi.mocked(api.mobilePreview.onFrame).mockImplementation((listener) => {
      frameListener = listener;
      return () => undefined;
    });
    const retainedSession = {
      ...createSession('session-retained', 'device-1'),
      frameFormat: 'mjpeg' as const,
    };
    let resolveList!: (sessions: MobilePreviewSession[]) => void;
    const listRequest = new Promise<MobilePreviewSession[]>((resolve) => {
      resolveList = resolve;
    });
    vi.spyOn(api.mobilePreview, 'listSessions').mockReturnValue(listRequest);
    let resolveAttach!: (session: MobilePreviewSession) => void;
    const attachRequest = new Promise<MobilePreviewSession>((resolve) => {
      resolveAttach = resolve;
    });
    const attach = vi
      .spyOn(api.mobilePreview, 'attachSession')
      .mockReturnValue(attachRequest);
    const animationFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const selectedDevice = { platform: 'ios' as const, deviceId: 'device-1' };
    let preview: ReturnType<typeof useMobilePreviewSession> | undefined;

    function Harness() {
      preview = useMobilePreviewSession(
        'task-1',
        selectedDevice,
        { retainSessions: true },
      );
      return null;
    }

    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(Harness),
        ),
      );
      await Promise.resolve();
    });
    await act(async () => {
      resolveList([retainedSession]);
      await listRequest;
      await Promise.resolve();
      resolveAttach(retainedSession);
      await attachRequest;
      await Promise.resolve();
    });
    act(() => {
      frameListener?.({
        sessionId: retainedSession.id,
        frameBase64: btoa('frame'),
      });
      animationFrames.splice(0).forEach((callback) => callback(0));
    });

    expect(attach).toHaveBeenCalledWith({
      taskId: 'task-1',
      sessionId: retainedSession.id,
    });
    expect(preview!.session).toEqual(retainedSession);
    expect(preview!.activeSessionDeviceKeys).toEqual(new Set(['ios:device-1']));
    expect(preview!.imageFrameCount).toBe(1);
  });

  it('accepts full attach H264 bootstrap at shared queue boundary', async () => {
    let frameListener: ((event: MobilePreviewFrameEvent) => void) | undefined;
    vi.mocked(api.mobilePreview.onFrame).mockImplementation((listener) => {
      frameListener = listener;
      return () => undefined;
    });
    const session = createSession('session-boundary', 'device-1');
    let resolveList!: (sessions: MobilePreviewSession[]) => void;
    const listRequest = new Promise<MobilePreviewSession[]>((resolve) => {
      resolveList = resolve;
    });
    vi.spyOn(api.mobilePreview, 'listSessions').mockReturnValue(listRequest);
    vi.spyOn(api.mobilePreview, 'attachSession').mockImplementation(async () => {
      frameListener?.({
        sessionId: session.id,
        frameBase64: 'config',
        h264PacketType: 'configuration',
      });
      frameListener?.({
        sessionId: session.id,
        frameBase64: 'keyframe',
        h264PacketType: 'data',
        keyframe: true,
      });
      for (
        let index = 2;
        index < MOBILE_PREVIEW_H264_REPLAY_CHUNK_LIMIT;
        index += 1
      ) {
        frameListener?.({
          sessionId: session.id,
          frameBase64: `delta-${index}`,
          h264PacketType: 'data',
        });
      }
      return session;
    });
    const animationFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const selectedDevice = { platform: 'ios' as const, deviceId: 'device-1' };
    let preview: ReturnType<typeof useMobilePreviewSession> | undefined;

    function Harness() {
      preview = useMobilePreviewSession('task-1', selectedDevice, {
        retainSessions: true,
      });
      return null;
    }

    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(Harness),
        ),
      );
    });
    const chunks: string[] = [];
    preview!.subscribeH264Chunks((chunk) => chunks.push(chunk.frameBase64));
    await act(async () => {
      resolveList([session]);
      await listRequest;
      await Promise.resolve();
      animationFrames.splice(0).forEach((callback) => callback(0));
    });

    expect(chunks).toHaveLength(MOBILE_PREVIEW_H264_REPLAY_CHUNK_LIMIT);
    expect(chunks.slice(0, 2)).toEqual(['config', 'keyframe']);
  });

  it('ignores stale retained list and attach responses after task change', async () => {
    let resolveFirstList!: (sessions: MobilePreviewSession[]) => void;
    const firstList = new Promise<MobilePreviewSession[]>((resolve) => {
      resolveFirstList = resolve;
    });
    const task1Session = createSessionForTask(
      'session-task-1',
      'task-1',
      'device-1',
    );
    const task2Session = createSessionForTask(
      'session-task-2',
      'task-2',
      'device-1',
    );
    vi.spyOn(api.mobilePreview, 'listSessions').mockImplementation(
      ({ taskId }) =>
        taskId === 'task-1' ? firstList : Promise.resolve([task2Session]),
    );
    const attach = vi
      .spyOn(api.mobilePreview, 'attachSession')
      .mockImplementation(async ({ sessionId }) =>
        sessionId === task1Session.id ? task1Session : task2Session,
      );
    let taskId = 'task-1';
    let preview: ReturnType<typeof useMobilePreviewSession> | undefined;

    function Harness() {
      preview = useMobilePreviewSession(
        taskId,
        { platform: 'ios', deviceId: 'device-1' },
        { retainSessions: true },
      );
      return null;
    }

    const queryClient = new QueryClient();
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness),
        ),
      );
    });
    taskId = 'task-2';
    await act(async () => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness),
        ),
      );
      await Promise.resolve();
    });

    await act(async () => {
      resolveFirstList([task1Session]);
      await firstList;
    });

    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith({
      taskId: 'task-2',
      sessionId: task2Session.id,
    });
    expect(preview!.session).toEqual(task2Session);
  });
});

const startParams = {
  projectPath: '/project',
  platform: 'ios' as const,
  deviceId: 'device-1',
};

function createSession(id: string, deviceId: string): MobilePreviewSession {
  return createSessionForTask(id, 'task-1', deviceId);
}

function createSessionForTask(
  id: string,
  taskId: string,
  deviceId: string,
): MobilePreviewSession {
  return {
    id,
    taskId,
    platform: 'ios',
    deviceId,
    status: 'streaming',
    width: 390,
    height: 844,
    frameFormat: 'h264',
    streamStrategy: 'idb-h264-stream',
    inputStatus: 'starting',
    error: null,
  };
}
