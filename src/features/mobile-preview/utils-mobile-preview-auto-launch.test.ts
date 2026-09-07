import { describe, expect, it } from 'vitest';

import {
  canAutoStartMobilePreviewDevice,
  getMobilePreviewAutoLaunchDecision,
} from './utils-mobile-preview-auto-launch';

const baseInput = {
  isRunningRuntime: true,
  isLoadingDevices: false,
  selectedDevice: {
    id: 'device-1',
    platform: 'ios' as const,
    state: 'booted' as const,
    kind: 'simulator' as const,
  },
  isExpoApp: true,
  taskId: 'task-1',
  projectId: 'project-1',
  appPath: 'apps/mobile',
  metroPort: 8091,
  completedOwnerKey: null,
  isSelectedDeviceReady: false,
};

describe('mobile preview auto-launch policy', () => {
  it('stays idle for a stopped runtime', () => {
    expect(
      getMobilePreviewAutoLaunchDecision({
        ...baseInput,
        isRunningRuntime: false,
      }),
    ).toEqual({ status: 'idle' });
  });

  it('waits for explicit device selection', () => {
    expect(
      getMobilePreviewAutoLaunchDecision({
        ...baseInput,
        selectedDevice: null,
      }),
    ).toEqual({
      status: 'waiting',
      message: 'Select a device to attach this runtime',
    });
  });

  it('stays idle on a physical iPhone instead of surfacing the deeplink guard', () => {
    expect(
      getMobilePreviewAutoLaunchDecision({
        ...baseInput,
        selectedDevice: {
          ...baseInput.selectedDevice,
          kind: 'physical' as const,
        },
      }),
    ).toEqual({ status: 'idle', keepCompletedLaunch: true });
  });

  it('still auto-launches on physical Android hardware', () => {
    expect(
      getMobilePreviewAutoLaunchDecision({
        ...baseInput,
        selectedDevice: {
          ...baseInput.selectedDevice,
          platform: 'android' as const,
          kind: 'physical' as const,
        },
      }).status,
    ).toBe('launching');
  });

  it('keeps vanilla React Native stream available without auto reassignment', () => {
    expect(
      getMobilePreviewAutoLaunchDecision({
        ...baseInput,
        isExpoApp: false,
      }),
    ).toEqual({
      status: 'unsupported',
      message:
        'Automatic Metro reassignment is unavailable for vanilla React Native. Device stream remains available.',
    });
  });

  it('returns exact Expo launch ownership and params', () => {
    const decision = getMobilePreviewAutoLaunchDecision(baseInput);

    expect(decision).toMatchObject({
      status: 'launching',
      message: 'Launching Expo on :8091',
      params: {
        taskId: 'task-1',
        projectId: 'project-1',
        appPath: 'apps/mobile',
        platform: 'ios',
        deviceId: 'device-1',
        metroPort: 8091,
      },
    });
  });

  it.each(['ios', 'android'] as const)(
    'allows automatic stream startup for selected shutdown %s device',
    (platform) => {
      expect(
        canAutoStartMobilePreviewDevice({
          id: `${platform}-device`,
          platform,
          state: 'shutdown',
        }),
      ).toBe(true);
    },
  );

  it.each(['ios', 'android'] as const)(
    'never auto-starts a physical %s device',
    (platform) => {
      expect(
        canAutoStartMobilePreviewDevice({
          id: `${platform}-handset`,
          platform,
          state: 'booted',
          kind: 'physical',
        }),
      ).toBe(false);
    },
  );

  it('keeps auto-start for devices explicitly marked as simulators', () => {
    expect(
      canAutoStartMobilePreviewDevice({
        id: 'sim-1',
        platform: 'ios',
        state: 'shutdown',
        kind: 'simulator',
      }),
    ).toBe(true);
  });

  it('rejects unknown-state and missing devices', () => {
    expect(
      canAutoStartMobilePreviewDevice({
        id: 'sim-1',
        platform: 'ios',
        state: 'unknown',
      }),
    ).toBe(false);
    expect(canAutoStartMobilePreviewDevice(null)).toBe(false);
    expect(canAutoStartMobilePreviewDevice(undefined)).toBe(false);
  });

  it.each(['ios', 'android'] as const)(
    'launches Expo for ready %s session despite stale shutdown inventory',
    (platform) => {
      expect(
        getMobilePreviewAutoLaunchDecision({
          ...baseInput,
          selectedDevice: {
            id: `${platform}-device`,
            platform,
            state: 'shutdown',
          },
          isSelectedDeviceReady: true,
        }),
      ).toMatchObject({
        status: 'launching',
        params: { platform, deviceId: `${platform}-device` },
      });
    },
  );

  it('retries failed ownership but suppresses completed ownership', () => {
    const firstDecision = getMobilePreviewAutoLaunchDecision(baseInput);
    expect(firstDecision.status).toBe('launching');
    if (firstDecision.status !== 'launching') return;

    // Errors do not mark ownership complete, so Retry evaluates to launch again.
    expect(getMobilePreviewAutoLaunchDecision(baseInput).status).toBe(
      'launching',
    );
    expect(
      getMobilePreviewAutoLaunchDecision({
        ...baseInput,
        completedOwnerKey: firstDecision.ownerKey,
      }),
    ).toEqual({ status: 'ready', message: 'Expo app attached' });
  });
});
