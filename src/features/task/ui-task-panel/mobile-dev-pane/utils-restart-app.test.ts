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
  };
}

const COMMON = {
  projectId: 'project-1',
  taskId: 'task-1',
  appPath: 'apps/mobile',
  androidProjectPath: 'apps/mobile/android',
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
});
