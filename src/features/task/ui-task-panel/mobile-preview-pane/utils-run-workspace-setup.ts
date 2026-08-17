import type {
  MobilePlatform,
  MobilePreviewAndroidAppStatus,
  MobilePreviewAndroidAppTrustResult,
  MobilePreviewNetworkProxyStartParams,
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
  | 'proxy-disabled'
  | 'android-project-missing'
  | 'no-proxy-params'
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

  // preview stream session
  startPreviewSession: (
    params: Omit<MobilePreviewStartParams, 'taskId'>,
  ) => Promise<MobilePreviewSession>;

  // network proxy
  startNetworkProxy: (
    params: MobilePreviewNetworkProxyStartParams,
  ) => Promise<unknown>;
  stopNetworkProxy: (sessionId: string) => Promise<unknown>;
  installCertificate: (params: {
    platform: MobilePlatform;
    deviceId: string;
  }) => Promise<unknown>;
  prepareAndroidAppTrust: (params: {
    projectId: string;
    taskId: string;
    androidProjectPath: string;
  }) => Promise<MobilePreviewAndroidAppTrustResult>;

  // setters the saga writes
  setInputNotice: (notice: string | null) => void;
  showActionNotice: (message?: string) => void;
  setResumeSetupAfterDependenciesInstall: (resume: boolean) => void;
  setResumeSetupAfterPrebuild: (resume: boolean) => void;
  setActiveConsoleCommandId: (commandId: string | null) => void;
  setLaunchedIosBuildCommandIds: (
    updater: (current: string[]) => string[],
  ) => void;
  setEnableNetworkMitm: (enabled: boolean) => void;
  setAndroidCertGuidanceVisible: (visible: boolean) => void;
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
  | 'autoStartProxy'
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
  | 'networkStatus'
  | 'networkCertificateInstalled'
> & {
  // derived values the pane already computes
  deviceReady: boolean;
  dependenciesInstallStatusValue: string | undefined;
  proxyStatus: string;
  androidTrustConfigured: boolean;
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
  networkSession: { id: string; enableMitm: boolean } | null;
  networkProxyParams: MobilePreviewNetworkProxyStartParams | null;
};

export type RunWorkspaceSetupOptions = {
  shouldAutoBuildIos: boolean;
  shouldPrebuildAndroid: boolean;
  shouldPrebuildIos: boolean;
};

/**
 * The workspace setup saga: dependencies install -> expo prebuild -> app
 * build/install -> android trust -> metro -> preview stream -> network proxy.
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
  const { shouldAutoBuildIos, shouldPrebuildAndroid, shouldPrebuildIos } =
    options;
  const {
    platform,
    deviceId,
    autoStartProxy,
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

  // Provably identical in all three call sites in this saga.
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

    if (
      (autoStartProxy &&
        shouldPrebuildAndroid &&
        !setupEffectiveAndroidProjectPath) ||
      shouldPrebuildIos
    ) {
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

    let setupSessionId = facts.session?.id ?? null;
    if (
      facts.hasActiveSession &&
      (!facts.session ||
        facts.session.platform !== platform ||
        facts.session.deviceId !== deviceId)
    ) {
      setupCoordinator.cancel();
      return 'session-device-mismatch';
    }
    if (!facts.hasActiveSession) {
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
      !setupSessionId ||
      !setupCoordinator.bindSession(setupOperation, setupSessionId)
    ) {
      return 'session-not-bound';
    }

    if (platform === 'ios') {
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

    if (!autoStartProxy) {
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
      return 'proxy-disabled';
    }

    if (platform === 'android' && !setupEffectiveAndroidProjectPath) {
      if (shouldPrebuildAndroid) {
        port.setResumeSetupAfterPrebuild(true);
        await port.startAdHocCommand({
          runCommandId: facts.prebuildCommandId,
          name: 'Expo Android prebuild',
          command: facts.prebuildCommand,
          ports: [],
        });
        port.showActionNotice(
          'Expo prebuild started; setup will continue when it finishes',
        );
      } else {
        port.showActionNotice(
          'Checking Android project folder before proxy setup',
        );
      }
      return 'android-project-missing';
    }

    const networkProxyParams = facts.networkProxyParams;
    if (!networkProxyParams) return 'no-proxy-params';
    if (!setupCoordinator.isCurrent(setupOperation)) {
      return 'operation-superseded';
    }

    if (facts.proxyStatus === 'error' && facts.networkSession) {
      await port.stopNetworkProxy(facts.networkSession.id);
      if (!setupCoordinator.isCurrent(setupOperation)) {
        return 'operation-superseded';
      }
    }

    if (!facts.networkCertificateInstalled) {
      if (facts.networkSession && facts.networkStatus === 'running') {
        await port.stopNetworkProxy(facts.networkSession.id);
        if (!setupCoordinator.isCurrent(setupOperation)) {
          return 'operation-superseded';
        }
      }
      if (!setupCoordinator.isCurrent(setupOperation)) {
        return 'operation-superseded';
      }
      await port.installCertificate({ platform, deviceId });
      if (!setupCoordinator.isCurrent(setupOperation)) {
        return 'operation-superseded';
      }
      port.setEnableNetworkMitm(true);
      if (platform === 'android') {
        port.setAndroidCertGuidanceVisible(true);
      }
      await port.startNetworkProxy({ ...networkProxyParams, enableMitm: true });
    } else if (facts.networkStatus !== 'running') {
      if (!setupCoordinator.isCurrent(setupOperation)) {
        return 'operation-superseded';
      }
      port.setEnableNetworkMitm(true);
      await port.startNetworkProxy({ ...networkProxyParams, enableMitm: true });
    } else if (facts.networkSession && !facts.networkSession.enableMitm) {
      await port.stopNetworkProxy(facts.networkSession.id);
      if (!setupCoordinator.isCurrent(setupOperation)) {
        return 'operation-superseded';
      }
      port.setEnableNetworkMitm(true);
      await port.startNetworkProxy({ ...networkProxyParams, enableMitm: true });
    }

    if (!setupCoordinator.isCurrent(setupOperation)) {
      return 'operation-superseded';
    }
    if (
      platform === 'android' &&
      setupEffectiveAndroidProjectPath &&
      !facts.androidTrustConfigured
    ) {
      const trustResult = await port.prepareAndroidAppTrust({
        projectId: facts.projectId,
        taskId: facts.taskId,
        androidProjectPath: setupEffectiveAndroidProjectPath,
      });
      if (!setupCoordinator.isCurrent(setupOperation)) {
        return 'operation-superseded';
      }
      port.setAndroidAppStatus((current) =>
        current
          ? { ...current, trustConfigured: true }
          : {
              appInstalled: null,
              packageName: null,
              trustConfigured: true,
            },
      );

      if (
        buildCommand &&
        !buildRunning &&
        !buildStarting &&
        (trustResult.changed || androidAppMissing)
      ) {
        startAndroidBuild(buildCommand);
      }
    } else if (
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
