import { describe, expect, it, vi } from 'vitest';

import { verifyDeeplinkOnDevice } from './utils-verify-deeplink';

const base = {
  projectId: 'project-1',
  taskId: 'task-1',
  appPath: 'apps/mobile',
  androidProjectPath: 'apps/mobile/android',
};

describe('verifyDeeplinkOnDevice', () => {
  it('checks Android package installation with Android-specific params', async () => {
    const getAndroidAppStatus = vi.fn().mockResolvedValue({
      appInstalled: true,
      packageName: 'com.example.android',
    });
    const getIosAppStatus = vi.fn();

    await expect(
      verifyDeeplinkOnDevice({
        ...base,
        api: { getAndroidAppStatus, getIosAppStatus },
        device: { id: 'emulator-1', platform: 'android' },
      }),
    ).resolves.toEqual({
      appInstalled: true,
      packageName: 'com.example.android',
      platform: 'android',
      appId: 'com.example.android',
    });
    expect(getAndroidAppStatus).toHaveBeenCalledWith({
      projectId: 'project-1',
      taskId: 'task-1',
      androidProjectPath: 'apps/mobile/android',
      deviceId: 'emulator-1',
    });
    expect(getIosAppStatus).not.toHaveBeenCalled();
  });

  it('checks iOS bundle installation with iOS-specific params', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' });
    const getAndroidAppStatus = vi.fn();
    const getIosAppStatus = vi.fn().mockResolvedValue({
      appInstalled: true,
      bundleId: 'com.example.ios',
      nativeProjectExists: true,
    });

    await expect(
      verifyDeeplinkOnDevice({
        ...base,
        api: { getAndroidAppStatus, getIosAppStatus },
        device: { id: 'simulator-1', platform: 'ios' },
      }),
    ).resolves.toEqual({
      appInstalled: true,
      bundleId: 'com.example.ios',
      nativeProjectExists: true,
      platform: 'ios',
      appId: 'com.example.ios',
    });
    expect(getIosAppStatus).toHaveBeenCalledWith({
      projectId: 'project-1',
      taskId: 'task-1',
      appPath: 'apps/mobile',
      deviceId: 'simulator-1',
      requestId: 'request-1',
    });
    expect(getAndroidAppStatus).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
