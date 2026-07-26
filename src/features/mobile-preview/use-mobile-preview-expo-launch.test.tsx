// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  MobilePreviewExpoLaunchParams,
  MobilePreviewExpoLaunchResult,
} from '@shared/mobile-simulator-types';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useMobilePreviewExpoLaunch } from './use-mobile-preview-expo-launch';

const apiMocks = vi.hoisted(() => ({
  cancelExpoLaunch: vi.fn((_requestId: string) => Promise.resolve(true)),
  launchExpo: vi.fn(
    (_params: MobilePreviewExpoLaunchParams) =>
      new Promise<MobilePreviewExpoLaunchResult>(() => {}),
  ),
}));

vi.mock('@/lib/api', () => ({
  api: { mobilePreview: apiMocks },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ deviceId }: { deviceId: string }) {
  useMobilePreviewExpoLaunch({
    isRunningRuntime: true,
    isLoadingDevices: false,
    selectedDevice: { id: deviceId, platform: 'ios', state: 'booted' },
    isExpoApp: true,
    taskId: 'task-1',
    projectId: 'project-1',
    appPath: 'apps/mobile',
    metroPort: 19001,
    retryGeneration: 0,
    isSelectedDeviceReady: false,
  });
  return null;
}

describe('useMobilePreviewExpoLaunch', () => {
  afterEach(() => {
    apiMocks.cancelExpoLaunch.mockClear();
    apiMocks.launchExpo.mockClear();
    document.body.innerHTML = '';
  });

  it('cancels the active launch when the workspace closes', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<Harness deviceId="device-1" />));
    const requestId = apiMocks.launchExpo.mock.calls[0]![0].requestId;

    await act(async () => root.unmount());

    expect(apiMocks.cancelExpoLaunch).toHaveBeenCalledWith(requestId);
  });

  it('cancels the old launch before starting one for a different device', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<Harness deviceId="device-1" />));
    const firstRequest = apiMocks.launchExpo.mock.calls[0]![0];

    await act(async () => root.render(<Harness deviceId="device-2" />));
    const secondRequest = apiMocks.launchExpo.mock.calls[1]![0];

    expect(apiMocks.cancelExpoLaunch).toHaveBeenCalledWith(
      firstRequest.requestId,
    );
    expect(firstRequest.deviceId).toBe('device-1');
    expect(secondRequest.deviceId).toBe('device-2');
    expect(secondRequest.requestId).not.toBe(firstRequest.requestId);

    await act(async () => root.unmount());
  });
});
