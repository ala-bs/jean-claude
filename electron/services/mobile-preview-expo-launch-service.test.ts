import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMobileDevServerCommandId } from '../../shared/mobile-preview-runtime';
import { runCommand } from './mobile-preview-process';

vi.mock('../database/repositories', () => ({
  ProjectRepository: { findById: vi.fn() },
  TaskRepository: { findById: vi.fn() },
}));
vi.mock('./mobile-preview-service', () => ({
  mobilePreviewService: { openDeeplink: vi.fn() },
}));
vi.mock('./run-command-service', () => ({
  runCommandService: { getRunStatus: vi.fn() },
}));

import {
  createMobilePreviewExpoLaunchService,
  launchUrlNeedsLanRewrite,
  resolveExpoAppSchemes,
  rewriteLaunchUrlToLanAddress,
} from './mobile-preview-expo-launch-service';

describe('mobilePreviewExpoLaunchService', () => {
  const deps = {
    findProjectById: vi.fn(),
    findTaskById: vi.fn(),
    resolveTaskRoot: vi.fn(),
    resolveAppPath: vi.fn(),
    resolveAppSchemes: vi.fn(),
    getRunStatus: vi.fn(),
    fetch: vi.fn<typeof fetch>(),
    openDeeplink: vi.fn(),
    timeoutMs: 50,
    maxResponseBytes: 256,
  };
  const params = {
    requestId: 'request-1',
    taskId: 'task-1',
    projectId: 'project-1',
    appPath: 'apps/mobile',
    platform: 'ios' as const,
    deviceId: 'device-1',
    metroPort: 19001,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    deps.findProjectById.mockResolvedValue({
      id: 'project-1',
      path: '/project',
    });
    deps.findTaskById.mockResolvedValue({
      projectId: 'project-1',
      worktreePath: '/worktree',
    });
    deps.resolveTaskRoot.mockResolvedValue('/canonical/worktree');
    deps.resolveAppPath.mockResolvedValue('/canonical/worktree/apps/mobile');
    deps.resolveAppSchemes.mockResolvedValue(
      new Set([
        'configured-app',
        'exp+mobile',
        'expected-app',
        'first-app',
        'myapp',
        'new-app',
        'old-app',
        'second-app',
      ]),
    );
    deps.getRunStatus.mockReturnValue({
      isRunning: true,
      commands: [
        {
          id: createMobileDevServerCommandId('apps/mobile'),
          name: 'Mobile dev server',
          command: 'npx expo start --port 19001',
          ports: [19001],
          status: 'running',
        },
      ],
    });
  });

  it('requests current Expo endpoint and opens returned URL on exact device', async () => {
    deps.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          url: 'exp://127.0.0.1:19001',
          runtime: 'default',
          appId: '@example/mobile',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const service = createMobilePreviewExpoLaunchService(deps);

    await expect(service.launch(params)).resolves.toEqual({
      url: 'exp://127.0.0.1:19001',
      runtime: 'default',
      appId: '@example/mobile',
    });

    const [requestUrl, requestInit] = deps.fetch.mock.calls[0];
    const url = new URL(String(requestUrl));
    expect(url.origin).toBe('http://127.0.0.1:19001');
    expect(url.pathname).toBe('/_expo/open');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      platform: 'ios',
      runtime: 'default',
    });
    expect(requestInit).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
    expect(deps.openDeeplink).toHaveBeenCalledWith(
      {
        platform: 'ios',
        deviceId: 'device-1',
        url: 'exp://127.0.0.1:19001',
      },
      expect.any(AbortSignal),
    );
  });

  it('cancels an in-flight Expo fetch before any native URL open', async () => {
    let fetchSignal: AbortSignal | undefined;
    deps.fetch.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          fetchSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const service = createMobilePreviewExpoLaunchService(deps);

    const launch = service.launch(params);
    await vi.waitFor(() => expect(fetchSignal).toBeInstanceOf(AbortSignal));
    expect(service.cancel(params.requestId)).toBe(true);

    await expect(launch).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchSignal?.aborted).toBe(true);
    expect(deps.openDeeplink).not.toHaveBeenCalled();
    expect(service.cancel(params.requestId)).toBe(false);
  });

  it('cancels old native open when renderer switches to a different device', async () => {
    const openedUrls: string[] = [];
    deps.fetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: 'old-app://launch' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: 'new-app://launch' }), {
          status: 200,
        }),
      );
    deps.openDeeplink.mockImplementation((openParams, signal) => {
      if (openParams.deviceId === 'device-2') {
        openedUrls.push(openParams.url);
        return Promise.resolve();
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    });
    const service = createMobilePreviewExpoLaunchService(deps);

    const oldLaunch = service.launch(params);
    await vi.waitFor(() => expect(deps.openDeeplink).toHaveBeenCalledOnce());
    expect(service.cancel(params.requestId)).toBe(true);
    const newLaunch = service.launch({
      ...params,
      requestId: 'request-2',
      deviceId: 'device-2',
    });

    await expect(oldLaunch).rejects.toMatchObject({ name: 'AbortError' });
    await expect(newLaunch).resolves.toEqual({ url: 'new-app://launch' });
    expect(openedUrls).toEqual(['new-app://launch']);
  });

  it('terminates an already-running native open process on cancellation', async () => {
    deps.fetch.mockResolvedValue(
      new Response(JSON.stringify({ url: 'exp://127.0.0.1:19001' }), {
        status: 200,
      }),
    );
    deps.openDeeplink.mockImplementation(async (_openParams, signal) => {
      await runCommand(
        process.execPath,
        ['-e', 'setInterval(() => {}, 10_000)'],
        { signal },
      );
    });
    const service = createMobilePreviewExpoLaunchService(deps);

    const launch = service.launch(params);
    await vi.waitFor(() => expect(deps.openDeeplink).toHaveBeenCalledOnce());
    expect(service.cancel(params.requestId)).toBe(true);

    await expect(launch).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('accepts a null appId from current Expo endpoint', async () => {
    deps.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          url: 'exp://127.0.0.1:19001',
          runtime: 'default',
          appId: null,
        }),
        { status: 200 },
      ),
    );

    await expect(
      createMobilePreviewExpoLaunchService(deps).launch(params),
    ).resolves.toEqual({
      url: 'exp://127.0.0.1:19001',
      runtime: 'default',
      appId: null,
    });
  });

  it('accepts matching custom scheme metadata', async () => {
    deps.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          url: 'exp+mobile://expo-development-client',
          scheme: 'exp+mobile',
        }),
        { status: 200 },
      ),
    );

    await expect(
      createMobilePreviewExpoLaunchService(deps).launch(params),
    ).resolves.toEqual({
      url: 'exp+mobile://expo-development-client',
    });
  });

  it.each([
    {
      name: 'Expo Go URL',
      url: 'exp://127.0.0.1:19001',
      scheme: 'configured-app',
    },
    {
      name: 'HTTPS URL',
      url: 'https://expo.dev/@example/mobile',
      scheme: 'configured-app',
    },
    {
      name: 'opaque custom URL',
      url: 'configured-app:launch',
      scheme: 'configured-app',
    },
  ])('accepts $name with returned scheme metadata', async ({ url, scheme }) => {
    deps.fetch.mockResolvedValue(
      new Response(JSON.stringify({ url, scheme }), { status: 200 }),
    );

    await expect(
      createMobilePreviewExpoLaunchService(deps).launch(params),
    ).resolves.toEqual({ url });
  });

  it('rejects custom URL that does not match returned scheme', async () => {
    deps.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          url: 'other-app://expo-development-client',
          scheme: 'expected-app',
        }),
        { status: 200 },
      ),
    );

    await expect(
      createMobilePreviewExpoLaunchService(deps).launch(params),
    ).rejects.toThrow('does not match Expo response scheme');
    expect(deps.openDeeplink).not.toHaveBeenCalled();
  });

  it('rejects response-only custom scheme not present in trusted app config', async () => {
    deps.resolveAppSchemes.mockResolvedValue(new Set());
    deps.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          url: 'response-only://launch',
          scheme: 'response-only',
        }),
        { status: 200 },
      ),
    );

    await expect(
      createMobilePreviewExpoLaunchService(deps).launch(params),
    ).rejects.toThrow('custom URL protocol is not configured by trusted app');
    expect(deps.openDeeplink).not.toHaveBeenCalled();
  });

  it.each([
    'exp://127.0.0.1:19001',
    'exps://expo.dev/@example/mobile',
    'http://127.0.0.1:19001',
    'https://expo.dev/@example/mobile',
  ])('does not resolve dynamic config for standard URL %s', async (url) => {
    deps.resolveAppSchemes.mockRejectedValue(
      new Error(
        'Dynamic Expo config cannot be safely resolved for mobile launch',
      ),
    );
    deps.fetch.mockResolvedValue(
      new Response(JSON.stringify({ url }), { status: 200 }),
    );

    await expect(
      createMobilePreviewExpoLaunchService(deps).launch(params),
    ).resolves.toEqual({ url });
    expect(deps.resolveAppSchemes).not.toHaveBeenCalled();
  });

  it('returns actionable dynamic-config error for custom URL', async () => {
    deps.resolveAppSchemes.mockRejectedValue(
      new Error(
        'Dynamic Expo config cannot be safely resolved for mobile launch',
      ),
    );
    deps.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({ url: 'configured-app://launch' }),
        { status: 200 },
      ),
    );

    await expect(
      createMobilePreviewExpoLaunchService(deps).launch(params),
    ).rejects.toThrow(
      'Dynamic Expo config cannot be safely resolved for mobile launch',
    );
    expect(deps.openDeeplink).not.toHaveBeenCalled();
  });

  it.each([
    ['null', { url: null, runtime: 'default', appId: null }],
    ['missing', { runtime: 'default', appId: null }],
  ])('reports %s launch URL as unsupported configuration', async (_name, body) => {
    deps.fetch.mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 }),
    );

    await expect(
      createMobilePreviewExpoLaunchService(deps).launch(params),
    ).rejects.toThrow(
      'Expo launch URL unavailable; check Expo project configuration',
    );
    expect(deps.openDeeplink).not.toHaveBeenCalled();
  });

  it('uses legacy redirect endpoint when current endpoint is unavailable', async () => {
    deps.fetch
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: 'myapp://expo-development-client' },
        }),
      );
    const service = createMobilePreviewExpoLaunchService(deps);

    await expect(
      service.launch({ ...params, platform: 'android' }),
    ).resolves.toEqual({ url: 'myapp://expo-development-client' });

    expect(deps.fetch).toHaveBeenCalledTimes(2);
    const [legacyUrl, legacyInit] = deps.fetch.mock.calls[1];
    const url = new URL(String(legacyUrl));
    expect(url.origin).toBe('http://127.0.0.1:19001');
    expect(url.pathname).toBe('/_expo/link');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      platform: 'android',
      choice: 'expo-go',
    });
    expect(legacyInit).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(deps.openDeeplink).toHaveBeenCalledWith(
      {
        platform: 'android',
        deviceId: 'device-1',
        url: 'myapp://expo-development-client',
      },
      expect.any(AbortSignal),
    );
  });

  it('asks for the dev-client link when the app depends on expo-dev-client', async () => {
    deps.resolveAppSchemes.mockResolvedValue(new Set(['falbala']));
    deps.fetch.mockResolvedValueOnce(
      new Response(null, {
        status: 307,
        headers: {
          location:
            'exp+falbala://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A19001',
        },
      }),
    );
    const service = createMobilePreviewExpoLaunchService({
      ...deps,
      resolveUsesDevClient: vi.fn().mockResolvedValue(true),
    });

    await expect(service.launch(params)).resolves.toEqual({
      url: 'exp+falbala://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A19001',
    });
    // Dev-client apps skip `/_expo/open` entirely: it has no dev-client hint
    // and would answer with the Expo Go link.
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    const legacyUrl = new URL(String(deps.fetch.mock.calls[0][0]));
    expect(legacyUrl.pathname).toBe('/_expo/link');
    expect(Object.fromEntries(legacyUrl.searchParams)).toEqual({
      platform: 'ios',
      choice: 'expo-dev-client',
    });
  });

  it('trusts the configured app scheme when the app config cannot be read', async () => {
    deps.resolveAppSchemes.mockRejectedValue(
      new Error('Dynamic Expo config cannot be safely resolved'),
    );
    deps.fetch.mockResolvedValueOnce(
      new Response(null, {
        status: 307,
        headers: {
          location: 'exp+falbala://expo-development-client/?url=x',
        },
      }),
    );
    const service = createMobilePreviewExpoLaunchService({
      ...deps,
      resolveUsesDevClient: vi.fn().mockResolvedValue(true),
    });

    await expect(
      service.launch({ ...params, appScheme: 'falbala' }),
    ).resolves.toEqual({
      url: 'exp+falbala://expo-development-client/?url=x',
    });
  });

  it('keeps trusting config-declared schemes alongside the configured one', async () => {
    deps.resolveAppSchemes.mockResolvedValue(new Set(['myapp']));
    deps.fetch.mockResolvedValue(
      new Response(JSON.stringify({ url: 'myapp://launch' }), { status: 200 }),
    );
    const service = createMobilePreviewExpoLaunchService(deps);

    await expect(
      service.launch({ ...params, appScheme: 'other-scheme' }),
    ).resolves.toEqual({ url: 'myapp://launch' });
  });

  it('tries legacy endpoint after current endpoint transport failure', async () => {
    deps.fetch
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: 'https://expo.dev/@example/mobile' },
        }),
      );

    await expect(
      createMobilePreviewExpoLaunchService(deps).launch(params),
    ).resolves.toEqual({ url: 'https://expo.dev/@example/mobile' });
    expect(deps.fetch).toHaveBeenCalledTimes(3);
  });

  it('retries current endpoint when Metro is still starting', async () => {
    deps.fetch
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: 'exp://127.0.0.1:19001' }), {
          status: 200,
        }),
      );

    await expect(
      createMobilePreviewExpoLaunchService(deps).launch(params),
    ).resolves.toEqual({ url: 'exp://127.0.0.1:19001' });
    expect(deps.fetch).toHaveBeenCalledTimes(2);
  });

  it('reports unsupported Expo endpoints separately', async () => {
    deps.fetch
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    await expect(
      createMobilePreviewExpoLaunchService(deps).launch(params),
    ).rejects.toThrow('Expo server does not support device launch');
  });

  it.each([
    'intent://launch',
    'content://com.example.provider/item',
    'prefs://root',
    'app-settings://settings',
    'android-app://com.example.mobile',
    'chrome://settings',
    'shortcuts://run-shortcut?name=Deploy',
    'workflow://run-workflow?name=Deploy',
  ])('rejects legacy OS or internal protocol %s', async (location) => {
    deps.fetch
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        new Response(null, { status: 307, headers: { location } }),
      );

    await expect(
      createMobilePreviewExpoLaunchService(deps).launch(params),
    ).rejects.toThrow('unsafe or unsupported URL protocol');
    expect(deps.openDeeplink).not.toHaveBeenCalled();
  });

  it('bounds requests with a timeout', async () => {
    deps.fetch.mockImplementation((_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          { once: true },
        );
      }),
    );

    await expect(
      createMobilePreviewExpoLaunchService(deps).launch(params),
    ).rejects.toThrow('Expo launch request timed out');
    expect(deps.openDeeplink).not.toHaveBeenCalled();
  });

  it('keeps timeout active while response body is stalled', async () => {
    deps.fetch.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => controller.error(new Error('body stalled')), 100);
          },
        }),
        { status: 200 },
      ),
    );

    await expect(
      createMobilePreviewExpoLaunchService(deps).launch(params),
    ).rejects.toThrow('Expo launch request timed out');
    expect(deps.openDeeplink).not.toHaveBeenCalled();
  });

  it('rejects oversized current endpoint response before parsing', async () => {
    deps.fetch.mockResolvedValue(
      new Response('x'.repeat(257), {
        status: 200,
        headers: { 'content-length': '257' },
      }),
    );

    await expect(
      createMobilePreviewExpoLaunchService(deps).launch(params),
    ).rejects.toThrow('Expo launch response exceeds 256 bytes');
    expect(deps.openDeeplink).not.toHaveBeenCalled();
  });

  it('reports transient HTTP failures clearly', async () => {
    const cancel = vi.fn();
    deps.fetch.mockResolvedValue(
      new Response(new ReadableStream({ cancel }), { status: 503 }),
    );

    await expect(
      createMobilePreviewExpoLaunchService(deps).launch(params),
    ).rejects.toThrow('Expo launch request failed: HTTP 503');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels unused current and legacy redirect response bodies', async () => {
    const currentCancel = vi.fn();
    const legacyCancel = vi.fn();
    deps.fetch
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel: currentCancel }), {
          status: 404,
        }),
      )
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel: legacyCancel }), {
          status: 307,
          headers: { location: 'myapp://launch' },
        }),
      );

    await expect(
      createMobilePreviewExpoLaunchService(deps).launch(params),
    ).resolves.toEqual({ url: 'myapp://launch' });
    expect(currentCancel).toHaveBeenCalledTimes(1);
    expect(legacyCancel).toHaveBeenCalledTimes(1);
  });

  it('rejects legacy custom redirect absent from trusted app config', async () => {
    deps.resolveAppSchemes.mockResolvedValue(new Set());
    deps.fetch
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: 'response-only://launch' },
        }),
      );

    await expect(
      createMobilePreviewExpoLaunchService(deps).launch(params),
    ).rejects.toThrow('custom URL protocol is not configured by trusted app');
    expect(deps.openDeeplink).not.toHaveBeenCalled();
  });

  it.each([
    [
      'invalid JSON',
      new Response('{', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ],
    [
      'dangerous URL',
      new Response(JSON.stringify({ url: 'javascript:alert(1)' }), {
        status: 200,
      }),
    ],
    [
      'invalid metadata',
      new Response(
        JSON.stringify({ url: 'https://expo.dev/app', appId: 42 }),
        { status: 200 },
      ),
    ],
  ])('rejects malformed response: %s', async (_name, response) => {
    deps.fetch.mockResolvedValue(response);

    await expect(
      createMobilePreviewExpoLaunchService(deps).launch(params),
    ).rejects.toThrow('Malformed Expo launch response');
    expect(deps.openDeeplink).not.toHaveBeenCalled();
  });

  it('rejects invalid project scope', async () => {
    deps.findProjectById.mockResolvedValue(undefined);

    await expect(
      createMobilePreviewExpoLaunchService(deps).launch(params),
    ).rejects.toThrow('Project not found');
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('rejects invalid task scope', async () => {
    deps.findTaskById.mockResolvedValue({
      projectId: 'other-project',
      worktreePath: null,
    });

    await expect(
      createMobilePreviewExpoLaunchService(deps).launch(params),
    ).rejects.toThrow('Task not found for project');
    expect(deps.resolveTaskRoot).not.toHaveBeenCalled();
  });

  it('validates app path inside trusted task root', async () => {
    deps.resolveAppPath.mockRejectedValue(
      new Error('App path is outside task scope'),
    );

    await expect(
      createMobilePreviewExpoLaunchService(deps).launch(params),
    ).rejects.toThrow('App path is outside task scope');
    expect(deps.resolveTaskRoot).toHaveBeenCalledWith({
      projectPath: '/project',
      worktreePath: '/worktree',
    });
    expect(deps.resolveAppPath).toHaveBeenCalledWith({
      rootPath: '/canonical/worktree',
      relativePath: 'apps/mobile',
    });
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'inactive command',
      launchParams: params,
      status: {
        isRunning: false,
        commands: [
          {
            id: createMobileDevServerCommandId('apps/mobile'),
            name: null,
            command: 'npx expo start',
            ports: [19001],
            status: 'stopped' as const,
          },
        ],
      },
    },
    {
      name: 'different task',
      launchParams: { ...params, taskId: 'task-2' },
      status: { isRunning: false, commands: [] },
    },
    {
      name: 'different app',
      launchParams: params,
      status: {
        isRunning: true,
        commands: [
          {
            id: createMobileDevServerCommandId('apps/other'),
            name: null,
            command: 'npx expo start',
            ports: [19001],
            status: 'running' as const,
          },
        ],
      },
    },
    {
      name: 'different effective port',
      launchParams: params,
      status: {
        isRunning: true,
        commands: [
          {
            id: createMobileDevServerCommandId('apps/mobile'),
            name: null,
            command: 'npx expo start',
            ports: [19002],
            status: 'running' as const,
          },
        ],
      },
    },
  ])('rejects $name before network access', async ({ launchParams, status }) => {
    deps.findTaskById.mockResolvedValue({
      projectId: 'project-1',
      worktreePath: '/worktree',
    });
    deps.getRunStatus.mockReturnValue(status);
    deps.fetch.mockResolvedValue(
      new Response(JSON.stringify({ url: 'exp://127.0.0.1:19001' }), {
        status: 200,
      }),
    );

    await expect(
      createMobilePreviewExpoLaunchService(deps).launch(launchParams),
    ).rejects.toThrow(
      'Mobile dev server is not running for requested task, app, and port',
    );
    expect(deps.getRunStatus).toHaveBeenCalledWith(launchParams.taskId);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('prevents slower superseded launch from opening same device', async () => {
    let resolveOlder!: (response: Response) => void;
    deps.fetch
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveOlder = resolve;
          }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: 'new-app://launch' }), {
          status: 200,
        }),
      );
    const service = createMobilePreviewExpoLaunchService(deps);

    const older = service.launch(params);
    await vi.waitFor(() => expect(deps.fetch).toHaveBeenCalledTimes(1));
    const newer = service.launch({ ...params, requestId: 'request-2' });
    await expect(newer).resolves.toEqual({ url: 'new-app://launch' });
    resolveOlder(
      new Response(JSON.stringify({ url: 'old-app://launch' }), {
        status: 200,
      }),
    );

    await expect(older).rejects.toThrow('Expo launch request superseded');
    expect(deps.openDeeplink).toHaveBeenCalledTimes(1);
    expect(deps.openDeeplink).toHaveBeenCalledWith(
      {
        platform: 'ios',
        deviceId: 'device-1',
        url: 'new-app://launch',
      },
      expect.any(AbortSignal),
    );
  });

  it('aborts an in-progress native open before opening newer URL on same device', async () => {
    let firstOpenSignal: AbortSignal | undefined;
    deps.fetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: 'old-app://launch' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: 'new-app://launch' }), {
          status: 200,
        }),
      );
    deps.openDeeplink
      .mockImplementationOnce(
        (_params, signal) =>
          new Promise<void>((_resolve, reject) => {
            firstOpenSignal = signal;
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          }),
      )
      .mockResolvedValueOnce(undefined);
    const service = createMobilePreviewExpoLaunchService(deps);

    const first = service.launch(params);
    await vi.waitFor(() => expect(deps.openDeeplink).toHaveBeenCalledTimes(1));
    const second = service.launch({ ...params, requestId: 'request-2' });

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).resolves.toEqual({ url: 'new-app://launch' });
    expect(firstOpenSignal?.aborted).toBe(true);
    expect(deps.openDeeplink).toHaveBeenCalledTimes(2);
    expect(deps.openDeeplink).toHaveBeenLastCalledWith(
      {
        platform: 'ios',
        deviceId: 'device-1',
        url: 'new-app://launch',
      },
      expect.any(AbortSignal),
    );
  });

  it('releases device lock after timed-out native process is terminated', async () => {
    deps.fetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: 'exp://127.0.0.1:19001/old' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: 'exp://127.0.0.1:19001/new' }), {
          status: 200,
        }),
      );
    deps.openDeeplink
      .mockImplementationOnce(async () => {
        await runCommand(
          process.execPath,
          ['-e', 'setInterval(() => {}, 10_000)'],
          { timeoutMs: 50 },
        );
      })
      .mockResolvedValueOnce(undefined);
    const service = createMobilePreviewExpoLaunchService(deps);

    const first = service.launch(params);
    await expect(first).rejects.toThrow('Command timed out');
    const second = service.launch({ ...params, requestId: 'request-2' });
    await expect(second).resolves.toEqual({
      url: 'exp://127.0.0.1:19001/new',
    });
    expect(deps.openDeeplink).toHaveBeenCalledTimes(2);
  });

  it('allows launches for different devices to proceed independently', async () => {
    let resolveFirst!: (response: Response) => void;
    deps.fetch
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: 'second-app://launch' }), {
          status: 200,
        }),
      );
    const service = createMobilePreviewExpoLaunchService(deps);

    const first = service.launch(params);
    await vi.waitFor(() => expect(deps.fetch).toHaveBeenCalledTimes(1));
    const second = service.launch({
      ...params,
      requestId: 'request-2',
      deviceId: 'device-2',
    });
    await expect(second).resolves.toEqual({ url: 'second-app://launch' });
    resolveFirst(
      new Response(JSON.stringify({ url: 'first-app://launch' }), {
        status: 200,
      }),
    );
    await expect(first).resolves.toEqual({ url: 'first-app://launch' });

    expect(deps.openDeeplink).toHaveBeenCalledTimes(2);
    expect(deps.openDeeplink).toHaveBeenCalledWith(
      {
        platform: 'ios',
        deviceId: 'device-1',
        url: 'first-app://launch',
      },
      expect.any(AbortSignal),
    );
    expect(deps.openDeeplink).toHaveBeenCalledWith(
      {
        platform: 'ios',
        deviceId: 'device-2',
        url: 'second-app://launch',
      },
      expect.any(AbortSignal),
    );
  });

  it.each([0, 1.5, 65_536, Number.NaN])(
    'rejects invalid Metro port %s',
    async (metroPort) => {
      await expect(
        createMobilePreviewExpoLaunchService(deps).launch({
          ...params,
          metroPort,
        }),
      ).rejects.toThrow('Invalid Metro port');
      expect(deps.findProjectById).not.toHaveBeenCalled();
      expect(deps.fetch).not.toHaveBeenCalled();
    },
  );
});

describe('resolveExpoAppSchemes', () => {
  it.each([
    {
      fileName: 'app.json',
      value: { expo: { scheme: 'app-json', slug: 'mobile-app' } },
      expected: ['app-json', 'exp+mobile-app'],
    },
    {
      fileName: 'app.config.json',
      value: {
        expo: { scheme: ['config-one', 'config-two'], slug: 'config-app' },
      },
      expected: ['config-one', 'config-two', 'exp+config-app'],
    },
    {
      fileName: 'package.json',
      value: { expo: { scheme: 'package-app', slug: 'package-slug' } },
      expected: ['package-app', 'exp+package-slug'],
    },
  ])('reads trusted schemes from $fileName', async ({ fileName, value, expected }) => {
    await mkdir(tmpdir(), { recursive: true });
    const appPath = await mkdtemp(join(tmpdir(), 'jc-expo-schemes-'));
    try {
      await writeFile(join(appPath, fileName), JSON.stringify(value));

      await expect(resolveExpoAppSchemes(appPath)).resolves.toEqual(
        new Set(expected),
      );
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it('rejects dynamic Expo config without executing project code', async () => {
    await mkdir(tmpdir(), { recursive: true });
    const appPath = await mkdtemp(join(tmpdir(), 'jc-expo-schemes-'));
    try {
      await writeFile(
        join(appPath, 'app.config.js'),
        'throw new Error("must not execute");\n',
      );

      await expect(resolveExpoAppSchemes(appPath)).rejects.toThrow(
        'Dynamic Expo config cannot be safely resolved for mobile launch',
      );
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });
});

describe('rewriteLaunchUrlToLanAddress', () => {
  it.each([
    ['exp://127.0.0.1:19001', 'exp://192.168.1.24:19001'],
    ['exp://localhost:19001', 'exp://192.168.1.24:19001'],
    ['exp://LOCALHOST:19001', 'exp://192.168.1.24:19001'],
    ['exp://[::1]:19001', 'exp://192.168.1.24:19001'],
    [
      'exp://127.0.0.1:19001/--/deep/link?foo=bar&baz=1',
      'exp://192.168.1.24:19001/--/deep/link?foo=bar&baz=1',
    ],
    ['exps://127.0.0.1:443/path', 'exps://192.168.1.24:443/path'],
    ['myapp://127.0.0.1:8081/route', 'myapp://192.168.1.24:8081/route'],
  ])('rewrites %s', (input, expected) => {
    expect(
      rewriteLaunchUrlToLanAddress({ url: input, lanAddress: '192.168.1.24' }),
    ).toBe(expected);
  });

  it('rewrites the Metro origin inside a dev-client link query', () => {
    const rewritten = rewriteLaunchUrlToLanAddress({
      url: 'exp+mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A19001',
      lanAddress: '192.168.1.24',
    });
    const parsed = new URL(rewritten);
    expect(parsed.protocol).toBe('exp+mobile:');
    expect(parsed.hostname).toBe('expo-development-client');
    expect(new URL(parsed.searchParams.get('url')!).host).toBe(
      '192.168.1.24:19001',
    );
  });

  it.each([
    'exp://192.168.1.50:19001',
    'exp://metro.local:19001/--/x',
    'exp+mobile://expo-development-client/?url=http%3A%2F%2F10.0.0.4%3A19001',
  ])('leaves routable host %s byte-for-byte unchanged', (url) => {
    expect(
      rewriteLaunchUrlToLanAddress({ url, lanAddress: '192.168.1.24' }),
    ).toBe(url);
  });
});

describe('launchUrlNeedsLanRewrite', () => {
  it.each([
    ['exp://127.0.0.1:19001', true],
    ['exp://localhost:19001', true],
    ['exp://[::1]:19001', true],
    [
      'exp+mobile://expo-development-client/?url=http%3A%2F%2Flocalhost%3A19001',
      true,
    ],
    ['exp://192.168.1.50:19001', false],
    ['not a url', false],
  ] as const)('%s -> %s', (url, expected) => {
    expect(launchUrlNeedsLanRewrite(url)).toBe(expected);
  });
});

describe('physical iOS device deeplink launch', () => {
  const baseDeps = () => ({
    findProjectById: vi.fn().mockResolvedValue({ id: 'project-1', path: '/p' }),
    findTaskById: vi
      .fn()
      .mockResolvedValue({ projectId: 'project-1', worktreePath: '/w' }),
    resolveTaskRoot: vi.fn().mockResolvedValue('/canonical/worktree'),
    resolveAppPath: vi.fn().mockResolvedValue('/canonical/worktree/apps/mobile'),
    resolveAppSchemes: vi.fn().mockResolvedValue(new Set(['exp+mobile'])),
    getRunStatus: vi.fn().mockReturnValue({
      isRunning: true,
      commands: [
        {
          id: createMobileDevServerCommandId('apps/mobile'),
          name: 'Mobile dev server',
          command: 'npx expo start --port 19001',
          ports: [19001],
          status: 'running',
        },
      ],
    }),
    fetch: vi.fn<typeof fetch>(),
    openDeeplink: vi.fn(),
    timeoutMs: 50,
    maxResponseBytes: 4096,
  });

  const launchParams = {
    requestId: 'request-1',
    taskId: 'task-1',
    projectId: 'project-1',
    appPath: 'apps/mobile',
    platform: 'ios' as const,
    deviceId: 'device-1',
    metroPort: 19001,
  };

  function respondWith(deps: ReturnType<typeof baseDeps>, url: string) {
    deps.fetch.mockResolvedValue(
      new Response(JSON.stringify({ url }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }

  /**
   * Faithful stand-in for the real `openDeeplink` wiring: on iOS it ends in
   * `xcrun simctl openurl`, which refuses a CoreDevice id. Tests that inject a
   * bare `vi.fn()` here can "pass" on a code path production can never reach.
   */
  function guardedOpenDeeplink(physicalIds: readonly string[]) {
    return vi.fn(async (params: { platform: string; deviceId: string }) => {
      if (params.platform === 'ios' && physicalIds.includes(params.deviceId)) {
        throw new Error(
          'Opening deeplinks is not supported on physical iOS devices.',
        );
      }
    });
  }

  it('refuses a physical iOS device before doing any Metro work', async () => {
    const deps = baseDeps();
    respondWith(deps, 'exp://127.0.0.1:19001');
    const openDeeplink = guardedOpenDeeplink(['device-1']);
    const service = createMobilePreviewExpoLaunchService({
      ...deps,
      openDeeplink,
      isPhysicalIosDevice: () => true,
    });

    // The message must be the actionable one, not the simulator-only guard:
    // getting the guard's wording here means the early check was removed and we
    // walked the whole launch flow into a dead end again.
    await expect(service.launch(launchParams)).rejects.toThrow(
      /not supported on physical iOS devices yet.*Build & Run/s,
    );
    expect(openDeeplink).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('leaves the simulator launch URL byte-for-byte unchanged', async () => {
    const deps = baseDeps();
    respondWith(deps, 'exp://127.0.0.1:19001');
    const openDeeplink = guardedOpenDeeplink(['physical-1']);
    const service = createMobilePreviewExpoLaunchService({
      ...deps,
      openDeeplink,
      isPhysicalIosDevice: (id) => id === 'physical-1',
    });

    await expect(service.launch(launchParams)).resolves.toEqual({
      url: 'exp://127.0.0.1:19001',
    });
    expect(openDeeplink).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'exp://127.0.0.1:19001' }),
      expect.any(AbortSignal),
    );
  });

  it('never consults the iOS registry for android targets', async () => {
    const deps = baseDeps();
    respondWith(deps, 'exp://127.0.0.1:19001');
    const isPhysicalIosDevice = vi.fn(() => true);
    const service = createMobilePreviewExpoLaunchService({
      ...deps,
      isPhysicalIosDevice,
    });

    await expect(
      service.launch({ ...launchParams, platform: 'android' as const }),
    ).resolves.toEqual({ url: 'exp://127.0.0.1:19001' });
    expect(isPhysicalIosDevice).not.toHaveBeenCalled();
  });
});
