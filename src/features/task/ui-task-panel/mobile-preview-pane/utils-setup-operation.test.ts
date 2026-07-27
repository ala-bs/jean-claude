import { describe, expect, it, vi } from 'vitest';

import {
  applyPreviewDeviceSwitch,
  cancelPendingWorkspaceSetup,
  createIosBuildLaunchCoordinator,
  createPreviewSetupOperationCoordinator,
  getDeferredSetupAction,
  getDependencyInstallDeferredAction,
  getIosAppStatusRequestKey,
  getIosAppStatusRequestState,
  getIosBuildAttemptDecision,
  getMobileAppSetupDecision,
  getMobileBuildCommandId,
  shouldStopPreviousIosBuild,
} from './utils-setup-operation';

describe('preview setup operation coordinator', () => {
  it('stops an iOS build after start resolves when cancelled during start', async () => {
    const coordinator = createIosBuildLaunchCoordinator();
    let resolveStart!: () => void;
    const start = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const stop = vi.fn().mockResolvedValue(undefined);

    const launch = coordinator.launch({ commandId: 'ios-build-a', start, stop });
    coordinator.cancel('ios-build-a');
    resolveStart();
    await launch;

    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith('ios-build-a');
  });

  it('leaves a normally started iOS build running', async () => {
    const coordinator = createIosBuildLaunchCoordinator();
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);

    await coordinator.launch({ commandId: 'ios-build-a', start, stop });

    expect(start).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
  });

  it('uses durable per-device iOS IDs across A/B/A while preserving Android IDs', () => {
    expect(
      getMobileBuildCommandId({
        appPath: 'apps/mobile',
        platform: 'android',
      }),
    ).toBe('mobile-build:apps%2Fmobile:android');
    const firstA = getMobileBuildCommandId({
      appPath: 'apps/mobile',
      platform: 'ios',
      deviceId: 'simulator-a',
    });
    const deviceB = getMobileBuildCommandId({
      appPath: 'apps/mobile',
      platform: 'ios',
      deviceId: 'simulator-b',
    });
    const secondA = getMobileBuildCommandId({
      appPath: 'apps/mobile',
      platform: 'ios',
      deviceId: 'simulator-a',
    });

    expect(firstA).toBe('mobile-build:apps%2Fmobile:ios:simulator-a');
    expect(deviceB).toBe('mobile-build:apps%2Fmobile:ios:simulator-b');
    expect(secondA).toBe(firstA);
  });

  it('uses persisted per-device completion as durable loop guard', () => {
    expect(
      getIosBuildAttemptDecision({
        needsBuild: true,
        buildStatus: 'loading',
      }),
    ).toEqual({ shouldAutoBuild: false, buildVerificationFailed: false });
    expect(
      getIosBuildAttemptDecision({
        needsBuild: true,
        buildStatus: 'completed',
      }),
    ).toEqual({ shouldAutoBuild: false, buildVerificationFailed: true });
    expect(
      getIosBuildAttemptDecision({
        needsBuild: true,
        buildStatus: 'idle',
      }),
    ).toEqual({ shouldAutoBuild: true, buildVerificationFailed: false });
  });

  it('stops a detached previous iOS build when switching devices', () => {
    expect(
      shouldStopPreviousIosBuild({
        previousCommandId: 'ios-build-a',
        currentCommandId: 'ios-build-b',
        previousStatus: 'running',
        previousStarting: false,
      }),
    ).toBe(true);
    expect(
      shouldStopPreviousIosBuild({
        previousCommandId: 'ios-build-a',
        currentCommandId: 'ios-build-b',
        previousStatus: undefined,
        previousStarting: true,
      }),
    ).toBe(true);
    expect(
      shouldStopPreviousIosBuild({
        previousCommandId: 'ios-build-a',
        currentCommandId: 'ios-build-a',
        previousStatus: 'running',
        previousStarting: false,
      }),
    ).toBe(false);
  });

  it('requires iOS Expo prebuild when native project is missing', () => {
    expect(
      getMobileAppSetupDecision({
        platform: 'ios',
        isExpoApp: true,
        nativeProjectExists: false,
        appInstalled: null,
        appIdentityResolved: false,
        buildStatus: 'idle',
      }),
    ).toEqual({
      needsPrebuild: true,
      appReady: false,
      needsBuild: false,
      shouldAutoBuild: false,
      buildVerificationFailed: false,
    });
  });

  it('skips prebuild for an identified iOS Expo app without a native project', () => {
    expect(
      getMobileAppSetupDecision({
        platform: 'ios',
        isExpoApp: true,
        nativeProjectExists: false,
        appInstalled: true,
        appIdentityResolved: true,
        buildStatus: 'idle',
      }),
    ).toMatchObject({ needsPrebuild: false, appReady: true, needsBuild: false });
  });

  it('builds an identified missing iOS Expo app without prebuilding', () => {
    expect(
      getMobileAppSetupDecision({
        platform: 'ios',
        isExpoApp: true,
        nativeProjectExists: false,
        appInstalled: false,
        appIdentityResolved: true,
        buildStatus: 'idle',
      }),
    ).toMatchObject({
      needsPrebuild: false,
      appReady: false,
      needsBuild: true,
      shouldAutoBuild: true,
    });
  });

  it('does not build after iOS prebuild when the app remains installed', () => {
    expect(
      getMobileAppSetupDecision({
        platform: 'ios',
        isExpoApp: true,
        nativeProjectExists: true,
        appInstalled: true,
        appIdentityResolved: true,
        buildStatus: 'idle',
      }),
    ).toMatchObject({ needsPrebuild: false, appReady: true, needsBuild: false });
  });

  it.each([
    { appInstalled: false, appIdentityResolved: true },
    { appInstalled: null, appIdentityResolved: false },
  ])('requires an iOS build for a missing or unresolved app', (appState) => {
    expect(
      getMobileAppSetupDecision({
        platform: 'ios',
        isExpoApp: true,
        nativeProjectExists: true,
        buildStatus: 'idle',
        ...appState,
      }),
    ).toEqual({
      needsPrebuild: false,
      appReady: false,
      needsBuild: true,
      shouldAutoBuild: true,
      buildVerificationFailed: false,
    });
  });

  it('treats iOS app as ready only when bundle identity and install resolve', () => {
    expect(
      getMobileAppSetupDecision({
        platform: 'ios',
        isExpoApp: false,
        nativeProjectExists: true,
        appInstalled: true,
        appIdentityResolved: true,
        buildStatus: 'idle',
      }),
    ).toEqual({
      needsPrebuild: false,
      appReady: true,
      needsBuild: false,
      shouldAutoBuild: false,
      buildVerificationFailed: false,
    });
  });

  it('builds a blocked non-Expo iOS app even without a native project', () => {
    expect(
      getMobileAppSetupDecision({
        platform: 'ios',
        isExpoApp: false,
        nativeProjectExists: false,
        appInstalled: null,
        appIdentityResolved: false,
        buildStatus: 'idle',
      }),
    ).toMatchObject({
      needsPrebuild: false,
      appReady: false,
      needsBuild: true,
      shouldAutoBuild: true,
    });
  });

  it('blocks iOS setup without building when status request fails', () => {
    expect(
      getMobileAppSetupDecision({
        platform: 'ios',
        isExpoApp: false,
        nativeProjectExists: null,
        appInstalled: null,
        appIdentityResolved: false,
        buildStatus: 'idle',
        statusCheckFailed: true,
      }),
    ).toMatchObject({
      appReady: false,
      needsPrebuild: false,
      needsBuild: false,
      shouldAutoBuild: false,
    });
  });

  it('does not auto-loop after a completed iOS build remains unresolved', () => {
    expect(
      getMobileAppSetupDecision({
        platform: 'ios',
        isExpoApp: false,
        nativeProjectExists: false,
        appInstalled: null,
        appIdentityResolved: false,
        buildStatus: 'completed',
      }),
    ).toMatchObject({
      needsBuild: true,
      shouldAutoBuild: false,
      buildVerificationFailed: true,
    });
  });

  it.each(['running', 'errored'] as const)(
    'does not start another automatic iOS build after a %s attempt',
    (buildStatus) => {
      expect(
        getMobileAppSetupDecision({
          platform: 'ios',
          isExpoApp: false,
          nativeProjectExists: false,
          appInstalled: null,
          appIdentityResolved: false,
          buildStatus,
        }),
      ).toMatchObject({ needsBuild: true, shouldAutoBuild: false });
    },
  );

  it('preserves Android Expo prebuild behavior when native project is missing', () => {
    expect(
      getMobileAppSetupDecision({
        platform: 'android',
        isExpoApp: true,
        nativeProjectExists: false,
        appInstalled: true,
        appIdentityResolved: true,
        buildStatus: 'idle',
      }),
    ).toMatchObject({ needsPrebuild: true });
  });

  it('keeps Android unresolved package identity from forcing a build', () => {
    expect(
      getMobileAppSetupDecision({
        platform: 'android',
        isExpoApp: true,
        nativeProjectExists: true,
        appInstalled: null,
        appIdentityResolved: false,
        buildStatus: 'idle',
      }),
    ).toEqual({
      needsPrebuild: false,
      appReady: false,
      needsBuild: false,
      shouldAutoBuild: false,
      buildVerificationFailed: false,
    });
  });

  it('hides stale iOS status until current app/device request resolves', () => {
    const staleStatus = { bundleId: 'com.example.old' };
    expect(
      getIosAppStatusRequestState({
        requestKey: 'ios:new-app:device-2',
        resolved: {
          requestKey: 'ios:old-app:device-1',
          value: staleStatus,
          error: null,
        },
      }),
    ).toEqual({ value: null, error: null, isLoading: true });

    expect(
      getIosAppStatusRequestState({
        requestKey: 'ios:new-app:device-2',
        resolved: {
          requestKey: 'ios:new-app:device-2',
          value: null,
          error: 'Status unavailable',
        },
      }),
    ).toEqual({ value: null, error: 'Status unavailable', isLoading: false });
  });

  it('changes iOS status request key when trusted mobile settings change', () => {
    const base = {
      projectId: 'project-1',
      taskId: 'task-1',
      appPath: 'apps/mobile',
      deviceId: 'device-1',
      buildStatus: 'stopped',
      prebuildStatus: 'stopped',
      refreshNonce: 0,
      iosBundleId: 'com.example.one',
      packageManager: 'pnpm' as const,
    };

    expect(getIosAppStatusRequestKey(base)).not.toBe(
      getIosAppStatusRequestKey({
        ...base,
        iosBundleId: 'com.example.two',
      }),
    );
    expect(getIosAppStatusRequestKey(base)).not.toBe(
      getIosAppStatusRequestKey({ ...base, packageManager: 'npm' }),
    );
  });

  it('runs centralized cleanup before selecting a newly created device', () => {
    const calls: string[] = [];

    applyPreviewDeviceSwitch({
      platform: 'ios',
      deviceId: 'created-device',
      cancelPending: () => calls.push('cancel'),
      setPlatform: (platform) => calls.push(`platform:${platform}`),
      setDeviceId: (deviceId) => calls.push(`device:${deviceId}`),
    });

    expect(calls).toEqual([
      'cancel',
      'platform:ios',
      'device:created-device',
    ]);
  });

  it('Stop All cancels active setup/start and clears deferred prebuild resume', () => {
    const coordinator = createPreviewSetupOperationCoordinator();
    const operation = coordinator.begin('ios:device-1')!;
    const cancelStart = vi.fn();
    const setResumeSetupAfterPrebuild = vi.fn();

    cancelPendingWorkspaceSetup({
      cancelSetupOperation: coordinator.cancel,
      cancelStart,
      setResumeSetupAfterPrebuild,
    });

    expect(coordinator.isCurrent(operation)).toBe(false);
    expect(cancelStart).toHaveBeenCalledOnce();
    expect(setResumeSetupAfterPrebuild).toHaveBeenCalledWith(false);
  });

  it('does not resume cancelled deferred setup when prebuild later completes', () => {
    expect(
      getDeferredSetupAction({
        resumeRequested: false,
        prebuildStatus: 'completed',
        prebuildDone: true,
      }),
    ).toBe('none');
    expect(
      getDeferredSetupAction({
        resumeRequested: true,
        prebuildStatus: 'completed',
        prebuildDone: true,
      }),
    ).toBe('resume');
  });

  it('waits for dependency install completion before resuming setup', () => {
    expect(
      getDependencyInstallDeferredAction({
        resumeRequested: true,
        status: undefined,
      }),
    ).toBe('none');
    expect(
      getDependencyInstallDeferredAction({
        resumeRequested: true,
        status: 'running',
      }),
    ).toBe('none');
    expect(
      getDependencyInstallDeferredAction({
        resumeRequested: true,
        status: 'completed',
      }),
    ).toBe('resume');
    expect(
      getDependencyInstallDeferredAction({
        resumeRequested: false,
        status: 'completed',
      }),
    ).toBe('none');
  });

  it('resumes deferred setup only after command completion and refreshed project status', () => {
    expect(
      getDeferredSetupAction({
        resumeRequested: true,
        prebuildStatus: 'running',
        prebuildDone: true,
      }),
    ).toBe('none');
    expect(
      getDeferredSetupAction({
        resumeRequested: true,
        prebuildStatus: 'completed',
        prebuildDone: false,
      }),
    ).toBe('none');
    expect(
      getDeferredSetupAction({
        resumeRequested: true,
        prebuildStatus: 'completed',
        prebuildDone: true,
      }),
    ).toBe('resume');
  });

  it('is single-flight and matches rendered frames to exact session', async () => {
    const coordinator = createPreviewSetupOperationCoordinator();
    const operation = coordinator.begin('ios:device-1');

    expect(operation).not.toBeNull();
    expect(coordinator.begin('ios:device-1')).toBeNull();
    expect(coordinator.bindSession(operation!, 'session-1')).toBe(true);

    const wait = coordinator.waitForFrame(operation!, 'session-1', 15_000);
    coordinator.markFrameRendered('session-stale', 'image');
    expect(await Promise.race([wait, Promise.resolve('pending')])).toBe('pending');

    coordinator.markFrameRendered('session-1', 'h264');
    await expect(wait).resolves.toBe('frame');
  });

  it.each(['image', 'raw-rgba', 'h264'] as const)(
    'observes an already-visible %s frame rendered before setup begins',
    async (source) => {
      const coordinator = createPreviewSetupOperationCoordinator();
      coordinator.markFrameRendered('session-1', source);
      const operation = coordinator.begin('ios:device-1')!;
      coordinator.bindSession(operation, 'session-1');

      await expect(
        coordinator.waitForFrame(operation, 'session-1', 15_000),
      ).resolves.toBe('frame');
    },
  );

  it('cancels waits on device or bound session changes', async () => {
    const coordinator = createPreviewSetupOperationCoordinator();
    const deviceOperation = coordinator.begin('ios:device-1')!;
    coordinator.bindSession(deviceOperation, 'session-1');
    const deviceWait = coordinator.waitForFrame(
      deviceOperation,
      'session-1',
      15_000,
    );

    coordinator.reconcile('ios:device-2', null);
    await expect(deviceWait).resolves.toBe('cancelled');

    const sessionOperation = coordinator.begin('ios:device-2')!;
    coordinator.bindSession(sessionOperation, 'session-2');
    const sessionWait = coordinator.waitForFrame(
      sessionOperation,
      'session-2',
      15_000,
    );
    coordinator.reconcile('ios:device-2', 'session-3');
    await expect(sessionWait).resolves.toBe('cancelled');
  });

  it('cancels an unbound operation on device switch and a bound wait on stop', async () => {
    const coordinator = createPreviewSetupOperationCoordinator();
    const startingOperation = coordinator.begin('ios:device-1')!;

    coordinator.reconcile('ios:device-2', null);
    expect(coordinator.isCurrent(startingOperation)).toBe(false);

    const streamingOperation = coordinator.begin('ios:device-2')!;
    coordinator.bindSession(streamingOperation, 'session-2');
    const wait = coordinator.waitForFrame(
      streamingOperation,
      'session-2',
      15_000,
    );
    coordinator.reconcile('ios:device-2', null);

    await expect(wait).resolves.toBe('cancelled');
  });

  it('times out only current operation and blocks stale continuation', async () => {
    vi.useFakeTimers();
    const coordinator = createPreviewSetupOperationCoordinator();
    const operation = coordinator.begin('ios:device-1')!;
    coordinator.bindSession(operation, 'session-1');
    const wait = coordinator.waitForFrame(operation, 'session-1', 15_000);

    await vi.advanceTimersByTimeAsync(15_000);
    await expect(wait).resolves.toBe('timeout');
    expect(coordinator.isCurrent(operation)).toBe(true);

    coordinator.cancel();
    expect(coordinator.isCurrent(operation)).toBe(false);
    vi.useRealTimers();
  });
});
