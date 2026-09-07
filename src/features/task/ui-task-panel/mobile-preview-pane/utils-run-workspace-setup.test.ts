import { describe, expect, it, vi } from 'vitest';

import type { MobilePreviewSession } from '@shared/mobile-simulator-types';

import {
  FIRST_PREVIEW_FRAME_SETUP_WAIT_MS,
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

  hasActiveSession: true,
  session: { id: 'session-1', platform: 'android', deviceId: 'device-1' },
  effectiveProjectPath: '/repo',
  fps: 30,
  quality: 'balanced',
  projectId: 'project-1',
  taskId: 'task-1',
};

const baseOptions = {
  shouldAutoBuildIos: false,
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

  it('never runs the android prebuild, even when the project is missing', async () => {
    const { port, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({
      facts: { androidProjectPath: null, androidProjectExists: false },
      port,
      coordinator,
    });
    // `expo prebuild` writes a native `android/` directory into the worktree,
    // so it must not run just because the project has no android/ folder.
    expect(names()).not.toContain('setResumeSetupAfterPrebuild');
    expect(names()).not.toContain('startAdHocCommand');
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
      },
      port,
      coordinator,
      iosBuildCoordinator,
      options: { shouldAutoBuildIos: true },
    });
    expect(coordinator.waitForFrame).toHaveBeenCalledWith(
      expect.anything(),
      'session-1',
      FIRST_PREVIEW_FRAME_SETUP_WAIT_MS,
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

  it('builds the android app when it is missing', async () => {
    const { port, calls, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({
      facts: { androidAppMissing: true },
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

  it('does not rebuild the android app when it is already installed', async () => {
    const { port, names } = createRecordingPort();
    const { coordinator } = createFakeCoordinator();
    await run({ facts: { androidAppMissing: false }, port, coordinator });
    expect(names()).not.toContain('startAdHocCommand');
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
