import { describe, expect, it, vi } from 'vitest';

import type { MobilePreviewSession } from '@shared/mobile-simulator-types';

import {
  type PreviewIosBuildCoordinator,
  type PreviewPort,
  type PreviewSetupCoordinator,
  runWorkspaceSetup,
  type RunWorkspaceSetupFacts,
} from './utils-run-workspace-setup';

type PortCall = { name: string; args: unknown[] };

function createRecordingPort(
  overrides: Partial<PreviewPort> = {},
): { port: PreviewPort; calls: PortCall[]; names: () => string[] } {
  const calls: PortCall[] = [];
  const record =
    <T>(name: string, result: T) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      return result;
    };

  const session: MobilePreviewSession = {
    id: 'session-1',
    taskId: 'task-1',
    platform: 'android',
    deviceId: 'device-1',
    status: 'streaming',
    width: null,
    height: null,
    frameFormat: 'mjpeg',
    streamStrategy: 'idb-h264-stream',
    inputStatus: 'ready',
    error: null,
  };

  const port = {
    startAdHocCommand: record('startAdHocCommand', Promise.resolve(undefined)),
    stopCommand: record('stopCommand', Promise.resolve(undefined)),
    startPreviewSession: record(
      'startPreviewSession',
      Promise.resolve(session),
    ),
    startNetworkProxy: record('startNetworkProxy', Promise.resolve(undefined)),
    stopNetworkProxy: record('stopNetworkProxy', Promise.resolve(undefined)),
    installCertificate: record('installCertificate', Promise.resolve(undefined)),
    prepareAndroidAppTrust: record(
      'prepareAndroidAppTrust',
      Promise.resolve({
        appPath: 'apps/mobile',
        nativeFiles: [],
        message: 'ok',
        changed: true,
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ),
    setInputNotice: record('setInputNotice', undefined),
    showActionNotice: record('showActionNotice', undefined),
    setResumeSetupAfterDependenciesInstall: record(
      'setResumeSetupAfterDependenciesInstall',
      undefined,
    ),
    setResumeSetupAfterPrebuild: record(
      'setResumeSetupAfterPrebuild',
      undefined,
    ),
    setActiveConsoleCommandId: record('setActiveConsoleCommandId', undefined),
    setLaunchedIosBuildCommandIds: record(
      'setLaunchedIosBuildCommandIds',
      undefined,
    ),
    setEnableNetworkMitm: record('setEnableNetworkMitm', undefined),
    setAndroidCertGuidanceVisible: record(
      'setAndroidCertGuidanceVisible',
      undefined,
    ),
    setAndroidAppStatus: record('setAndroidAppStatus', undefined),
    ensureMetroReverse: record('ensureMetroReverse', Promise.resolve({
      reversed: true,
      alreadyPresent: false,
    })),
    ...overrides,
  } as unknown as PreviewPort;

  return { port, calls, names: () => calls.map((call) => call.name) };
}

function createFakeCoordinator(
  overrides: Partial<PreviewSetupCoordinator> = {},
) {
  const operation = { id: 1, deviceKey: 'android:device-1' } as const;
  return {
    operation,
    coordinator: {
      begin: vi.fn(() => operation),
      bindSession: vi.fn(() => true),
      isCurrent: vi.fn(() => true),
      waitForFrame: vi.fn(async () => 'frame'),
      markFrameRendered: vi.fn(),
      reconcile: vi.fn(),
      complete: vi.fn(),
      cancel: vi.fn(),
      ...overrides,
    } as unknown as PreviewSetupCoordinator,
  };
}

function createFakeIosBuildCoordinator() {
  const launched: string[] = [];
  const coordinator = {
    launch: vi.fn(async ({ commandId, start }: {
      commandId: string;
      start: () => Promise<unknown>;
      stop: (commandId: string) => Promise<unknown>;
    }) => {
      launched.push(commandId);
      await start();
    }),
    cancel: vi.fn(),
    cancelAll: vi.fn(),
  } as unknown as PreviewIosBuildCoordinator;
  return { iosBuildCoordinator: coordinator, launched };
}

const baseFacts: RunWorkspaceSetupFacts = {
  platform: 'android',
  deviceId: 'device-1',
  autoStartProxy: true,
  needsAppSelection: false,
  deviceReady: true,

  androidProjectPath: 'apps/mobile/android',
  androidProjectExists: true,
  inferredAndroidProjectPath: 'apps/mobile/android',

  dependenciesInstallStatusValue: 'completed',
  dependenciesInstallCommandId: 'deps-id',
  dependenciesInstallCommand: 'pnpm install',
  prebuildCommandId: 'prebuild-id',
  prebuildCommand: 'expo prebuild',
  devServerCommandId: 'dev-id',
  devServerCommand: 'expo start',
  devServerRunning: true,
  devServerStarting: false,
  configuredDevServerPort: 8081,
  buildCommandId: 'build-id',
  buildCommand: 'gradlew installDebug',
  buildRunning: false,
  buildStarting: false,
  selectedDeviceIsPhysical: false,

  androidAppMissing: false,
  androidTrustConfigured: true,

  hasActiveSession: true,
  session: { id: 'session-1', platform: 'android', deviceId: 'device-1' },
  effectiveProjectPath: '/repo',
  fps: 30,
  quality: 'balanced',
  projectId: 'project-1',
  taskId: 'task-1',

  proxyStatus: 'ready',
  networkStatus: 'running',
  networkSession: { id: 'proxy-1', enableMitm: true },
  networkProxyParams: {
    projectPath: '/repo',
    appPath: 'apps/mobile',
    platform: 'android',
    deviceId: 'device-1',
    autoConfigureDevice: true,
  },
  networkCertificateInstalled: true,
};

const baseOptions = {
  shouldAutoBuildIos: false,
  shouldPrebuildAndroid: false,
  shouldPrebuildIos: false,
};

async function run({
  facts,
  port,
  coordinator,
  iosBuildCoordinator,
  options,
}: {
  facts?: Partial<RunWorkspaceSetupFacts>;
  port: PreviewPort;
  coordinator: PreviewSetupCoordinator;
  iosBuildCoordinator?: PreviewIosBuildCoordinator;
  options?: Partial<typeof baseOptions>;
}) {
  return runWorkspaceSetup({
    facts: { ...baseFacts, ...facts },
    port,
    coordinator,
    iosBuildCoordinator:
      iosBuildCoordinator ?? createFakeIosBuildCoordinator().iosBuildCoordinator,
    options: { ...baseOptions, ...options },
  });
}

describe('runWorkspaceSetup stop reasons', () => {
  it('reports the gate that ended each pass', async () => {
    const cases: Array<[Partial<RunWorkspaceSetupFacts>, string]> = [
      [{ needsAppSelection: true }, 'needs-app-selection'],
      [{ deviceReady: false }, 'device-not-ready'],
      // An unrun deps command reads as `undefined`, not 'completed', so the
      // very first Start of a session is consumed by the dependency install.
      [{ dependenciesInstallStatusValue: undefined }, 'dependencies-install-pending'],
      [{ dependenciesInstallStatusValue: 'running' }, 'dependencies-install-pending'],
      [{ dependenciesInstallStatusValue: 'errored' }, 'dependencies-install-errored'],
    ];

    for (const [facts, expected] of cases) {
      const { port } = createRecordingPort();
      const { coordinator } = createFakeCoordinator();
      await expect(run({ facts, port, coordinator })).resolves.toBe(expected);
    }
  });

  it('reaches the end of the saga once dependencies are installed', async () => {
    const { port } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await expect(
      run({
        facts: { dependenciesInstallStatusValue: 'completed' },
        port,
        coordinator,
      }),
    ).resolves.not.toBe('dependencies-install-pending');
  });
});

describe('runWorkspaceSetup', () => {
  it('does nothing when the app is not selected', async () => {
    const { port, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({ facts: { needsAppSelection: true }, port, coordinator });
    expect(names()).toEqual([]);
    expect(coordinator.begin).not.toHaveBeenCalled();
  });

  it('does nothing when the device is not ready', async () => {
    const { port, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({ facts: { deviceReady: false }, port, coordinator });
    expect(names()).toEqual([]);
  });

  it('bails when another setup operation is already running', async () => {
    const { port, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator({
      begin: vi.fn(() => null),
    } as unknown as Partial<PreviewSetupCoordinator>);
    await run({ port, coordinator });
    expect(names()).toEqual([]);
    expect(coordinator.complete).not.toHaveBeenCalled();
  });

  it('starts the dependency install and defers setup when deps are missing', async () => {
    const { port, calls, names } = createRecordingPort();
    const { coordinator, operation } = createFakeCoordinator();
    await run({
      facts: { dependenciesInstallStatusValue: undefined },
      port,
      coordinator,
    });
    expect(names()).toEqual([
      'setResumeSetupAfterDependenciesInstall',
      'startAdHocCommand',
    ]);
    expect(calls[0].args).toEqual([true]);
    expect(calls[1].args[0]).toMatchObject({
      runCommandId: 'deps-id',
      name: 'Mobile dependencies install',
      command: 'pnpm install',
      ports: [],
    });
    expect(coordinator.complete).toHaveBeenCalledWith(operation);
  });

  it('arms the resume flag without restarting an install that is already running', async () => {
    const { port, calls, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({
      facts: { dependenciesInstallStatusValue: 'running' },
      port,
      coordinator,
    });
    expect(names()).toEqual(['setResumeSetupAfterDependenciesInstall']);
    expect(calls[0].args).toEqual([true]);
  });

  it('reports an input notice and starts nothing when deps errored', async () => {
    const { port, calls, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({
      facts: { dependenciesInstallStatusValue: 'errored' },
      port,
      coordinator,
    });
    expect(names()).toEqual(['setInputNotice']);
    expect(calls[0].args).toEqual([
      'Dependency install failed; check Metro tab logs',
    ]);
  });

  it('runs the android prebuild and defers setup when the project is missing', async () => {
    const { port, calls, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({
      facts: { androidProjectPath: null, androidProjectExists: false },
      port,
      coordinator,
      options: { shouldPrebuildAndroid: true },
    });
    expect(names()).toEqual([
      'setResumeSetupAfterPrebuild',
      'startAdHocCommand',
      'showActionNotice',
    ]);
    expect(calls[1].args[0]).toMatchObject({
      runCommandId: 'prebuild-id',
      name: 'Expo Android prebuild',
      command: 'expo prebuild',
    });
  });

  it('runs the ios prebuild and defers setup', async () => {
    const { port, calls, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({
      facts: { platform: 'ios' },
      port,
      coordinator,
      options: { shouldPrebuildIos: true },
    });
    expect(names()).toEqual([
      'setResumeSetupAfterPrebuild',
      'startAdHocCommand',
      'showActionNotice',
    ]);
    expect(calls[1].args[0]).toMatchObject({ name: 'Expo iOS prebuild' });
  });

  it('starts the dev server when it is not running', async () => {
    const { port, calls } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({ facts: { devServerRunning: false }, port, coordinator });
    expect(calls[0]).toMatchObject({ name: 'startAdHocCommand' });
    expect(calls[0].args[0]).toMatchObject({
      runCommandId: 'dev-id',
      name: 'Mobile dev server',
      ports: [8081],
      availablePort: { provider: 'args' },
    });
  });

  it('cancels the operation when the active session is for another device', async () => {
    const { port, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({
      facts: {
        session: { id: 'other', platform: 'android', deviceId: 'device-2' },
      },
      port,
      coordinator,
    });
    expect(coordinator.cancel).toHaveBeenCalledTimes(1);
    expect(names()).not.toContain('startPreviewSession');
    expect(names()).not.toContain('startNetworkProxy');
  });

  it('starts a preview session when there is none', async () => {
    const { port, calls, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({
      facts: { hasActiveSession: false, session: null },
      port,
      coordinator,
    });
    expect(names()).toContain('startPreviewSession');
    const startCall = calls.find(
      (call) => call.name === 'startPreviewSession',
    );
    expect(startCall?.args[0]).toEqual({
      projectPath: '/repo',
      platform: 'android',
      deviceId: 'device-1',
      fps: 30,
      quality: 'balanced',
    });
  });

  it('aborts without further port calls when the operation is superseded after a start await', async () => {
    const { port, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator({
      isCurrent: vi.fn(() => false),
    } as unknown as Partial<PreviewSetupCoordinator>);
    await run({
      facts: { hasActiveSession: false, session: null },
      port,
      coordinator,
    });
    expect(names()).toEqual(['startPreviewSession']);
    expect(coordinator.bindSession).not.toHaveBeenCalled();
    expect(coordinator.complete).toHaveBeenCalled();
  });

  it('waits for the first frame on ios before building', async () => {
    const { port } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    const { iosBuildCoordinator, launched } = createFakeIosBuildCoordinator();
    await run({
      facts: {
        platform: 'ios',
        session: { id: 'session-1', platform: 'ios', deviceId: 'device-1' },
        autoStartProxy: false,
      },
      port,
      coordinator,
      iosBuildCoordinator,
      options: { shouldAutoBuildIos: true },
    });
    expect(coordinator.waitForFrame).toHaveBeenCalledWith(
      expect.anything(),
      'session-1',
      15_000,
    );
    expect(launched).toEqual(['build-id']);
  });

  it('stops before the ios build when the frame wait is cancelled', async () => {
    const { port, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator({
      waitForFrame: vi.fn(async () => 'cancelled'),
    } as unknown as Partial<PreviewSetupCoordinator>);
    await run({
      facts: {
        platform: 'ios',
        session: { id: 'session-1', platform: 'ios', deviceId: 'device-1' },
      },
      port,
      coordinator,
      options: { shouldAutoBuildIos: true },
    });
    expect(names()).toEqual([]);
  });

  it('never touches the proxy when autoStartProxy is off', async () => {
    const { port, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({
      facts: {
        autoStartProxy: false,
        networkCertificateInstalled: false,
        networkStatus: 'stopped',
        proxyStatus: 'error',
      },
      port,
      coordinator,
    });
    expect(names()).not.toContain('startNetworkProxy');
    expect(names()).not.toContain('stopNetworkProxy');
    expect(names()).not.toContain('installCertificate');
    expect(names()).not.toContain('prepareAndroidAppTrust');
  });

  it('builds the android app without the proxy when it is missing', async () => {
    const { port, calls, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({
      facts: { autoStartProxy: false, androidAppMissing: true },
      port,
      coordinator,
    });
    expect(names()).toEqual([
      'setActiveConsoleCommandId',
      'startAdHocCommand',
    ]);
    expect(calls[1].args[0]).toMatchObject({
      runCommandId: 'build-id',
      name: 'Android build',
    });
  });

  it('prompts for the android project folder instead of proxying when prebuild is off', async () => {
    const { port, calls, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({
      facts: { androidProjectPath: null, androidProjectExists: false },
      port,
      coordinator,
    });
    expect(names()).toEqual(['showActionNotice']);
    expect(calls[0].args).toEqual([
      'Checking Android project folder before proxy setup',
    ]);
  });

  it('stops nothing and starts nothing when the proxy is already healthy', async () => {
    const { port, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({ port, coordinator });
    expect(names()).toEqual([]);
  });

  it('restarts the proxy when it is in an error state', async () => {
    const { port, calls, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({
      facts: { proxyStatus: 'error', networkStatus: 'stopped' },
      port,
      coordinator,
    });
    expect(names()).toEqual([
      'stopNetworkProxy',
      'setEnableNetworkMitm',
      'startNetworkProxy',
    ]);
    expect(calls[0].args).toEqual(['proxy-1']);
    expect(calls[2].args[0]).toMatchObject({ enableMitm: true });
  });

  it('installs the certificate and starts the proxy when no certificate is installed', async () => {
    const { port, calls, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({
      facts: { networkCertificateInstalled: false },
      port,
      coordinator,
    });
    expect(names()).toEqual([
      'stopNetworkProxy',
      'installCertificate',
      'setEnableNetworkMitm',
      'setAndroidCertGuidanceVisible',
      'startNetworkProxy',
    ]);
    expect(calls[1].args[0]).toEqual({
      platform: 'android',
      deviceId: 'device-1',
    });
  });

  it('skips the android certificate guidance on ios', async () => {
    const { port, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({
      facts: {
        platform: 'ios',
        session: { id: 'session-1', platform: 'ios', deviceId: 'device-1' },
        networkCertificateInstalled: false,
      },
      port,
      coordinator,
    });
    expect(names()).toEqual([
      'stopNetworkProxy',
      'installCertificate',
      'setEnableNetworkMitm',
      'startNetworkProxy',
    ]);
  });

  it('starts the proxy when it is not running', async () => {
    const { port, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({
      facts: { networkStatus: 'stopped', networkSession: null },
      port,
      coordinator,
    });
    expect(names()).toEqual(['setEnableNetworkMitm', 'startNetworkProxy']);
  });

  it('restarts the proxy with mitm when the running session has mitm off', async () => {
    const { port, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({
      facts: { networkSession: { id: 'proxy-1', enableMitm: false } },
      port,
      coordinator,
    });
    expect(names()).toEqual([
      'stopNetworkProxy',
      'setEnableNetworkMitm',
      'startNetworkProxy',
    ]);
  });

  it('returns early when there are no proxy params', async () => {
    const { port, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({
      facts: { networkProxyParams: null, networkStatus: 'stopped' },
      port,
      coordinator,
    });
    expect(names()).toEqual([]);
  });

  it('prepares android trust and rebuilds the app', async () => {
    const { port, calls, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({
      facts: { androidTrustConfigured: false },
      port,
      coordinator,
    });
    expect(names()).toEqual([
      'prepareAndroidAppTrust',
      'setAndroidAppStatus',
      'setActiveConsoleCommandId',
      'startAdHocCommand',
    ]);
    expect(calls[0].args[0]).toEqual({
      projectId: 'project-1',
      taskId: 'task-1',
      androidProjectPath: 'apps/mobile/android',
    });
    expect(calls[3].args[0]).toMatchObject({ name: 'Android build' });
  });

  it('skips the rebuild when trust did not change and the app is installed', async () => {
    const { port, names } = createRecordingPort({
      prepareAndroidAppTrust: (() =>
        Promise.resolve({
          appPath: 'apps/mobile',
          nativeFiles: [],
          message: 'ok',
          changed: false,
          updatedAt: '2026-01-01T00:00:00.000Z',
        })) as PreviewPort['prepareAndroidAppTrust'],
    });
    const { coordinator } = createFakeCoordinator();
    await run({
      facts: { androidTrustConfigured: false },
      port,
      coordinator,
    });
    expect(names()).toEqual(['setAndroidAppStatus']);
  });

  it('rebuilds the android app when trust is already configured but the app is missing', async () => {
    const { port, calls, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({ facts: { androidAppMissing: true }, port, coordinator });
    expect(names()).toEqual([
      'setActiveConsoleCommandId',
      'startAdHocCommand',
    ]);
    expect(calls[1].args[0]).toMatchObject({ name: 'Android build' });
  });

  it('reports setup failures through the input notice', async () => {
    const { port, calls, names } = createRecordingPort({
      installCertificate: (() =>
        Promise.reject(
          new Error('cert boom'),
        )) as PreviewPort['installCertificate'],
    });
    const { coordinator, operation } = createFakeCoordinator();
    await run({
      facts: { networkCertificateInstalled: false },
      port,
      coordinator,
    });
    expect(names()).toEqual(['stopNetworkProxy', 'setInputNotice']);
    expect(calls[1].args).toEqual(['cert boom']);
    expect(coordinator.complete).toHaveBeenCalledWith(operation);
  });

  it('surfaces manual certificate guidance as a notice without failing setup', async () => {
    // Physical iOS: the port returns install instructions instead of throwing.
    const { port, calls, names } = createRecordingPort({
      installCertificate: (() =>
        Promise.resolve({
          message: 'Install the profile on the device.',
        })) as PreviewPort['installCertificate'],
    });
    const { coordinator } = createFakeCoordinator();
    await run({
      facts: {
        platform: 'ios',
        selectedDeviceIsPhysical: true,
        session: { id: 'session-1', platform: 'ios', deviceId: 'device-1' },
        networkCertificateInstalled: false,
      },
      port,
      coordinator,
    });
    expect(names()).not.toContain('setInputNotice');
    // The overridden `installCertificate` stub is not recorded by name.
    expect(names()).toEqual([
      'stopNetworkProxy',
      'showActionNotice',
      'setEnableNetworkMitm',
      'startNetworkProxy',
    ]);
    expect(calls[1].args).toEqual(['Install the profile on the device.']);
  });
});

describe('runWorkspaceSetup — physical devices', () => {
  it('reverses the Metro port for a physical Android device', async () => {
    const { port, calls, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({
      facts: { selectedDeviceIsPhysical: true, configuredDevServerPort: 8082 },
      port,
      coordinator,
    });
    expect(names()).toContain('ensureMetroReverse');
    const reverse = calls.find((call) => call.name === 'ensureMetroReverse');
    expect(reverse?.args[0]).toEqual({ deviceId: 'device-1', metroPort: 8082 });
  });

  it('never reverses the Metro port for an emulator', async () => {
    const { port, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({ port, coordinator });
    expect(names()).not.toContain('ensureMetroReverse');
  });

  it('never reverses the Metro port on iOS', async () => {
    const { port, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({
      facts: {
        platform: 'ios',
        selectedDeviceIsPhysical: true,
        session: { id: 'session-1', platform: 'ios', deviceId: 'device-1' },
      },
      port,
      coordinator,
    });
    expect(names()).not.toContain('ensureMetroReverse');
  });

  it('skips the preview stream but still builds on a physical iPhone', async () => {
    const { port, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    const { iosBuildCoordinator, launched } = createFakeIosBuildCoordinator();
    await run({
      facts: {
        platform: 'ios',
        selectedDeviceIsPhysical: true,
        hasActiveSession: false,
        session: null,
        autoStartProxy: false,
        buildCommand: 'npx expo run:ios --device abc',
      },
      port,
      coordinator,
      iosBuildCoordinator,
      options: { shouldAutoBuildIos: true },
    });
    expect(names()).not.toContain('startPreviewSession');
    expect(coordinator.waitForFrame).not.toHaveBeenCalled();
    expect(launched).toEqual(['build-id']);
  });

  it('still opens a preview stream for a physical Android device', async () => {
    const { port, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({
      facts: {
        selectedDeviceIsPhysical: true,
        hasActiveSession: false,
        session: null,
      },
      port,
      coordinator,
    });
    expect(names()).toContain('startPreviewSession');
  });
});
