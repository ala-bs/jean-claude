import type {
  MobilePreviewAndroidAppStatus,
  MobilePreviewQuality,
  MobilePreviewSession,
  MobilePreviewStartParams,
} from '@shared/mobile-simulator-types';
import type { StartAdHocRunCommandParams } from '@shared/run-command-types';

import type {
  createIosBuildLaunchCoordinator,
  createPreviewSetupOperationCoordinator,
} from './utils-setup-operation';
import { formatError } from './utils-preview-error';
import { getPreviewDeviceKey } from './utils-device-setup';
import type { PreviewFacts } from './utils-setup-model';

export const FIRST_PREVIEW_FRAME_SETUP_WAIT_MS = 15_000;

export type PreviewSetupCoordinator = ReturnType<
  typeof createPreviewSetupOperationCoordinator
>;
export type PreviewIosBuildCoordinator = ReturnType<
  typeof createIosBuildLaunchCoordinator
>;

/**
 * Why a single `runWorkspaceSetup` pass stopped where it did.
 *
 * The saga deliberately runs at most one long-running step per invocation, so
 * "it stopped early" is normal — but *which* gate stopped it is the only way to
 * tell an expected hand-off (waiting on a resume effect) from a stall.
 */
export type RunWorkspaceSetupStop =
  | 'needs-app-selection'
  | 'device-not-ready'
  | 'operation-superseded'
  | 'dependencies-install-errored'
  | 'dependencies-install-pending'
  | 'prebuild-started'
  | 'session-device-mismatch'
  | 'session-superseded'
  | 'session-not-bound'
  | 'frame-wait-cancelled'
  | 'cancelled'
  | 'failed'
  | 'completed';

type AdHocCommandParams = Omit<
  StartAdHocRunCommandParams,
  'taskId' | 'projectId' | 'workingDir'
>;

/**
 * The imperative capabilities the workspace-setup saga needs.
 *
 * Everything the saga *reads* lives in {@link RunWorkspaceSetupFacts};
 * everything it *does* goes through this port, which keeps the saga free of
 * React hooks and makes it testable with a recording fake.
 */
export type PreviewPort = {
  // run commands
  startAdHocCommand: (params: AdHocCommandParams) => Promise<unknown>;
  stopCommand: (runCommandId: string) => Promise<unknown>;

  /**
   * `adb reverse tcp:<port> tcp:<port>` so a physical handset can reach Metro
   * on the Mac. Idempotent and safe to call repeatedly; physical Android only.
   */
  ensureMetroReverse: (params: {
    deviceId: string;
    metroPort: number;
  }) => Promise<unknown>;

  // preview stream session
  startPreviewSession: (
    params: Omit<MobilePreviewStartParams, 'taskId'>,
  ) => Promise<MobilePreviewSession>;

  // setters the saga writes
  setInputNotice: (notice: string | null) => void;
  showActionNotice: (message?: string) => void;
  setResumeSetupAfterDependenciesInstall: (resume: boolean) => void;
  setResumeSetupAfterPrebuild: (resume: boolean) => void;
  setActiveConsoleCommandId: (commandId: string | null) => void;
  setLaunchedIosBuildCommandIds: (
    updater: (current: string[]) => string[],
  ) => void;
  setAndroidAppStatus: (
    updater: (
      current: MobilePreviewAndroidAppStatus | null,
    ) => MobilePreviewAndroidAppStatus,
  ) => void;
};

/**
 * Every scalar the saga reads. Fields shared with the setup model are picked
 * from {@link PreviewFacts} so the two stay in sync.
 */
export type RunWorkspaceSetupFacts = Pick<
  PreviewFacts,
  | 'platform'
  | 'deviceId'
  | 'needsAppSelection'
  | 'androidProjectPath'
  | 'androidProjectExists'
  | 'inferredAndroidProjectPath'
  | 'dependenciesInstallCommand'
  | 'devServerRunning'
  | 'devServerStarting'
  | 'hasActiveSession'
  | 'buildRunning'
  | 'buildStarting'
  | 'selectedDeviceIsPhysical'
> & {
  // derived values the pane already computes
  deviceReady: boolean;
  dependenciesInstallStatusValue: string | undefined;
  androidAppMissing: boolean;

  // identity / paths
  projectId: string;
  taskId: string;
  effectiveProjectPath: string;
  fps: number;
  quality: MobilePreviewQuality;

  // commands
  dependenciesInstallCommandId: string;
  prebuildCommandId: string;
  prebuildCommand: string;
  devServerCommandId: string;
  devServerCommand: string;
  configuredDevServerPort: number;
  buildCommandId: string;
  buildCommand: string | null;

  // live sessions
  session: Pick<MobilePreviewSession, 'id' | 'platform' | 'deviceId'> | null;
};

export type RunWorkspaceSetupOptions = {
  shouldAutoBuildIos: boolean;
  shouldPrebuildIos: boolean;
};

/**
 * The workspace setup saga: dependencies install -> expo prebuild -> app
 * build/install -> metro -> preview stream.
 *
 * It is a saga, not a reducer: it re-checks `coordinator.isCurrent(operation)`
 * after every await and early-returns so the two "resume" effects in the pane
 * can pick setup back up once a long-running command finishes.
 *
 * Returns where it stopped — see {@link RunWorkspaceSetupStop}.
 */
export async function runWorkspaceSetup({
  facts,
  port,
  coordinator,
  iosBuildCoordinator,
  options,
}: {
  facts: RunWorkspaceSetupFacts;
  port: PreviewPort;
  coordinator: PreviewSetupCoordinator;
  iosBuildCoordinator: PreviewIosBuildCoordinator;
  options: RunWorkspaceSetupOptions;
}): Promise<RunWorkspaceSetupStop> {
  const { shouldAutoBuildIos, shouldPrebuildIos } = options;
  const {
    platform,
    deviceId,
    needsAppSelection,
    deviceReady,
    buildCommand,
    buildCommandId,
    buildRunning,
    buildStarting,
    androidAppMissing,
  } = facts;

  if (needsAppSelection) return 'needs-app-selection';
  if (!deviceReady) return 'device-not-ready';
  const setupCoordinator = coordinator;
  const setupOperation = setupCoordinator.begin(
    getPreviewDeviceKey(platform, deviceId),
  );
  if (!setupOperation) return 'operation-superseded';

  const setupEffectiveAndroidProjectPath = facts.androidProjectPath
    ? facts.androidProjectExists === false
      ? null
      : facts.androidProjectPath
    : facts.androidProjectExists === true
      ? facts.inferredAndroidProjectPath
      : null;

  // Background starts are intentionally not awaited, so their rejections would
  // escape the surrounding try/catch. Surface them as an input notice instead
  // of leaving an unhandled rejection and a silently stuck setup.
  const reportBackgroundFailure = (label: string) => (error: unknown) => {
    port.setInputNotice(
      `${label} failed to start: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  };

  const startAndroidBuild = (command: string) => {
    port.setActiveConsoleCommandId(buildCommandId);
    void port
      .startAdHocCommand({
        runCommandId: buildCommandId,
        name: 'Android build',
        command,
        ports: [],
      })
      .catch(reportBackgroundFailure('Android build'));
  };

  try {
    if (facts.dependenciesInstallStatusValue !== 'completed') {
      if (facts.dependenciesInstallStatusValue === 'errored') {
        port.setInputNotice('Dependency install failed; check Metro tab logs');
        return 'dependencies-install-errored';
      }
      // Set the resume flag for the already-running case too, otherwise setup
      // silently never resumes when the install was started elsewhere.
      port.setResumeSetupAfterDependenciesInstall(true);
      if (facts.dependenciesInstallStatusValue !== 'running') {
        await port.startAdHocCommand({
          runCommandId: facts.dependenciesInstallCommandId,
          name: 'Mobile dependencies install',
          command: facts.dependenciesInstallCommand,
          ports: [],
        });
      }
      return 'dependencies-install-pending';
    }

    // Android prebuild stays opt-out here: `expo prebuild` writes a native
    // `android/` directory into the worktree, and nothing in this flow needs
    // one. (It used to run only when the network proxy was enabled, because
    // the HTTPS trust config had to patch a native project.)
    if (shouldPrebuildIos) {
      port.setResumeSetupAfterPrebuild(true);
      await port.startAdHocCommand({
        runCommandId: facts.prebuildCommandId,
        name:
          platform === 'android' ? 'Expo Android prebuild' : 'Expo iOS prebuild',
        command: facts.prebuildCommand,
        ports: [],
      });
      port.showActionNotice(
        'Expo prebuild started; setup will continue when it finishes',
      );
      return 'prebuild-started';
    }

    if (!facts.devServerRunning && !facts.devServerStarting) {
      void port
        .startAdHocCommand({
          runCommandId: facts.devServerCommandId,
          name: 'Mobile dev server',
          command: facts.devServerCommand,
          ports: [facts.configuredDevServerPort],
          availablePort: { provider: 'args' },
        })
        .catch(reportBackgroundFailure('Mobile dev server'));
    }

    // A physical handset has no route to `localhost` on the Mac, so Metro is
    // unreachable until adb reverses the port. Idempotent, so it is fine that
    // this runs on every setup pass; failures are advisory only (the user may
    // be on the same LAN and not need it).
    if (platform === 'android' && facts.selectedDeviceIsPhysical) {
      void port
        .ensureMetroReverse({
          deviceId,
          metroPort: facts.configuredDevServerPort,
        })
        .catch(reportBackgroundFailure('Metro port forwarding'));
    }

    // Physical iOS has no capture path (the iOS adapter throws for it), so the
    // whole streaming section is skipped. Build, install and launch — which do
    // work on real hardware — still run below.
    const skipPreviewStream = platform === 'ios' && facts.selectedDeviceIsPhysical;

    let setupSessionId = facts.session?.id ?? null;
    if (
      !skipPreviewStream &&
      facts.hasActiveSession &&
      (!facts.session ||
        facts.session.platform !== platform ||
        facts.session.deviceId !== deviceId)
    ) {
      setupCoordinator.cancel();
      return 'session-device-mismatch';
    }
    if (!skipPreviewStream && !facts.hasActiveSession) {
      const startedSession = await port.startPreviewSession({
        projectPath: facts.effectiveProjectPath,
        platform,
        deviceId,
        fps: facts.fps,
        quality: facts.quality,
      });
      if (!setupCoordinator.isCurrent(setupOperation)) {
        return 'operation-superseded';
      }
      if (
        startedSession.platform !== platform ||
        startedSession.deviceId !== deviceId ||
        startedSession.status === 'stopped'
      ) {
        setupCoordinator.cancel();
        return 'session-superseded';
      }
      setupSessionId = startedSession.id;
    }

    if (
      !skipPreviewStream &&
      (!setupSessionId ||
        !setupCoordinator.bindSession(setupOperation, setupSessionId))
    ) {
      return 'session-not-bound';
    }

    if (platform === 'ios' && !skipPreviewStream && setupSessionId) {
      const frameResult = await setupCoordinator.waitForFrame(
        setupOperation,
        setupSessionId,
        FIRST_PREVIEW_FRAME_SETUP_WAIT_MS,
      );
      if (
        frameResult === 'cancelled' ||
        !setupCoordinator.isCurrent(setupOperation)
      ) {
        return 'frame-wait-cancelled';
      }
    }

    if (!setupCoordinator.isCurrent(setupOperation)) {
      return 'operation-superseded';
    }
    if (
      platform === 'ios' &&
      shouldAutoBuildIos &&
      buildCommand &&
      !buildRunning &&
      !buildStarting
    ) {
      port.setLaunchedIosBuildCommandIds((current) =>
        current.includes(buildCommandId) ? current : [...current, buildCommandId],
      );
      port.setActiveConsoleCommandId(buildCommandId);
      void iosBuildCoordinator
        .launch({
          commandId: buildCommandId,
          start: () =>
            port.startAdHocCommand({
              runCommandId: buildCommandId,
              name: 'iOS build',
              command: buildCommand,
              ports: [],
            }),
          stop: port.stopCommand,
        })
        .catch(reportBackgroundFailure('iOS build'));
    }

    if (
      platform === 'android' &&
      setupEffectiveAndroidProjectPath &&
      androidAppMissing &&
      buildCommand &&
      !buildRunning &&
      !buildStarting
    ) {
      startAndroidBuild(buildCommand);
    }

    return 'completed';
  } catch (error) {
    if (setupCoordinator.isCurrent(setupOperation)) {
      port.setInputNotice(formatError(error) ?? 'Workspace setup failed');
    }
    return 'failed';
  } finally {
    setupCoordinator.complete(setupOperation);
  }
}
