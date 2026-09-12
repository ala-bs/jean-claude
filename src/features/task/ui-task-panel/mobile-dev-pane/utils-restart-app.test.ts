import { describe, expect, it, vi } from 'vitest';

import { restartAppOnDevice } from './utils-restart-app';

function makeApi() {
  return {
    restartIosApp: vi.fn(async () => ({
      bundleId: 'com.example.app',
      restartedAt: '',
    })),
    restartAndroidApp: vi.fn(async () => ({
      packageName: 'com.example.android',
      restartedAt: '',
    })),
    launchExpo: vi.fn(async (params: { requestId: string }) => {
      void params;
      return { url: 'exp://127.0.0.1:8082' };
    }),
  };
}

const COMMON = {
  projectId: 'project-1',
  taskId: 'task-1',
  appPath: 'apps/mobile',
  androidProjectPath: 'apps/mobile/android',
  reattach: null,
};

describe('restartAppOnDevice', () => {
  it('restarts an iOS app through the iOS IPC with appPath', () => {
    const api = makeApi();

    return restartAppOnDevice({
      api,
      device: { id: 'sim-1', platform: 'ios' },
      ...COMMON,
    }).then((result) => {
      expect(api.restartIosApp).toHaveBeenCalledWith({
        projectId: 'project-1',
        taskId: 'task-1',
        appPath: 'apps/mobile',
        deviceId: 'sim-1',
      });
      expect(api.restartAndroidApp).not.toHaveBeenCalled();
      expect(result.label).toBe('com.example.app');
    });
  });

  it('restarts an Android app through the Android IPC with androidProjectPath', () => {
    // The Android IPC takes the NATIVE project dir, not the JS app path.
    const api = makeApi();

    return restartAppOnDevice({
      api,
      device: { id: 'Pixel_8', platform: 'android' },
      ...COMMON,
    }).then((result) => {
      expect(api.restartAndroidApp).toHaveBeenCalledWith({
        projectId: 'project-1',
        taskId: 'task-1',
        androidProjectPath: 'apps/mobile/android',
        deviceId: 'Pixel_8',
      });
      expect(api.restartIosApp).not.toHaveBeenCalled();
      expect(result.label).toBe('com.example.android');
    });
  });

  it('propagates failures to the caller', async () => {
    const api = makeApi();
    api.restartAndroidApp = vi.fn(async () => {
      throw new Error('device offline');
    });

    await expect(
      restartAppOnDevice({
        api,
        device: { id: 'Pixel_8', platform: 'android' },
        ...COMMON,
      }),
    ).rejects.toThrow('device offline');
  });

  it('re-deeplinks the restarted app at the live Metro port', async () => {
    // The whole point of the re-attach: a relaunched dev client otherwise
    // reconnects to the port it remembered, not the port Metro actually took.
    const api = makeApi();

    const result = await restartAppOnDevice({
      api,
      device: { id: 'sim-1', platform: 'ios' },
      ...COMMON,
      reattach: { metroPort: 8082, appScheme: 'myapp' },
    });

    expect(api.launchExpo).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        projectId: 'project-1',
        appPath: 'apps/mobile',
        platform: 'ios',
        deviceId: 'sim-1',
        metroPort: 8082,
        appScheme: 'myapp',
      }),
    );
    expect(result.reattachedPort).toBe(8082);
    expect(result.reattachError).toBeNull();
  });

  it('uses a fresh requestId per invocation', async () => {
    // A reused id lets the first launch's teardown clear the second launch's
    // claim, which then fails with "request superseded".
    const api = makeApi();
    const reattach = { metroPort: 8082, appScheme: null };
    const device = { id: 'sim-1', platform: 'ios' } as const;

    await restartAppOnDevice({ api, device, ...COMMON, reattach });
    await restartAppOnDevice({ api, device, ...COMMON, reattach });

    const ids = api.launchExpo.mock.calls.map(([params]) => params.requestId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('skips the deeplink when there is nothing to attach to', async () => {
    const api = makeApi();

    const result = await restartAppOnDevice({
      api,
      device: { id: 'sim-1', platform: 'ios' },
      ...COMMON,
      reattach: null,
    });

    expect(api.launchExpo).not.toHaveBeenCalled();
    expect(result.reattachedPort).toBeNull();
  });

  it('reports a failed re-attach without failing the restart', async () => {
    // The native app really did restart; surfacing this as "restart failed"
    // would send the user looking in the wrong place.
    const api = makeApi();
    api.launchExpo = vi.fn(async () => {
      throw new Error('Mobile dev server is not running');
    });

    const result = await restartAppOnDevice({
      api,
      device: { id: 'sim-1', platform: 'ios' },
      ...COMMON,
      reattach: { metroPort: 8082, appScheme: null },
    });

    expect(result.label).toBe('com.example.app');
    expect(result.reattachedPort).toBeNull();
    expect((result.reattachError as Error).message).toContain(
      'Mobile dev server is not running',
    );
  });
});
