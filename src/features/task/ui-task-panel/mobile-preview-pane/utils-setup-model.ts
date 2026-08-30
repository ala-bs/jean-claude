import type {
  MobilePlatform,
  MobilePreviewAndroidAppStatus,
  MobilePreviewDevice,
  MobilePreviewIosAppStatus,
} from '@shared/mobile-simulator-types';

import { cleanPreviewError, formatError } from './utils-preview-error';

export type PreviewStepStatus = 'idle' | 'running' | 'ready' | 'blocked' | 'error';

/**
 * Physical iPhones can be built to and launched, but not mirrored: there is no
 * AVFoundation capture path, so the iOS adapter throws for physical devices.
 * Say so plainly instead of surfacing that error.
 */
export const PHYSICAL_IOS_STREAMING_UNSUPPORTED_DETAIL =
  'Live mirroring is not supported on a physical iPhone. Build, install and launch still work — watch the device itself.';

/** Same, for physical iOS in the preview surface's empty state. */
export const PHYSICAL_IOS_STREAMING_UNSUPPORTED_TITLE =
  'Mirroring unavailable on this iPhone';

export type PreviewStepKey =
  | 'app'
  | 'dependencies-install'
  | 'device'
  | 'prebuild'
  | 'install'
  | 'metro'
  | 'preview'
  | 'proxy'
  | 'https';

/**
 * Step detail is a descriptor, never JSX, so this module stays pure and
 * testable. The `network-request-count` variant is rendered by the setup tab
 * as <NetworkRequestCountDetail/>.
 */
export type PreviewStepDetail =
  | string
  | null
  | undefined
  | { kind: 'network-request-count' };

export type PreviewStepView = {
  key: PreviewStepKey;
  label: string;
  status: PreviewStepStatus;
  detail: PreviewStepDetail;
  tab: 'dev-server' | 'network' | null;
};

/**
 * The complete scalar input to mobile-preview setup derivation.
 *
 * This is the boundary that keeps the derivation pure: adapters
 * (useMobilePreviewSession / useRunCommands / networkProxy / ...) are projected
 * down to these ~50 scalars, and nothing downstream touches the adapters.
 */
export type PreviewFacts = {
  platform: MobilePlatform;
  deviceId: string;
  appPath: string;
  isExpoApp: boolean;
  autoStartProxy: boolean;
  needsAppSelection: boolean;

  // device
  selectedDeviceCanStart: boolean;
  activeSessionDeviceReady: boolean;
  selectedDevice: { name: string; state: MobilePreviewDevice['state'] } | null;
  /** True when the selected device is real hardware rather than a simulator. */
  selectedDeviceIsPhysical: boolean;
  /** Physical devices only: whether the handset is reachable right now. */
  selectedDeviceConnected: boolean;
  /** Why the selected device cannot be used, straight from the adapter. */
  selectedDeviceUnavailableReason: string | null;
  /**
   * Set when the configured build command could not be pointed at the selected
   * physical device (unrecognised custom command). See
   * `utils-device-build-command`.
   */
  buildCommandDeviceNotice: string | null;

  // stream session
  sessionStatus: string | undefined;
  isStarting: boolean;
  isStopping: boolean;
  hasActiveSession: boolean;
  previewMethodText: string | null | undefined;

  // dev server / build / prebuild / deps
  devServerRunning: boolean;
  devServerStarting: boolean;
  devServerStopping: boolean;
  effectiveDevServerPort: number;
  buildRunning: boolean;
  buildStarting: boolean;
  buildStopping: boolean;
  normalizedBuildStatus:
    | 'idle'
    | 'loading'
    | 'running'
    | 'completed'
    | 'errored';
  prebuildStatusStatus: string | null | undefined;
  prebuildStarting: boolean;
  prebuildStopping: boolean;
  dependenciesInstallStatusStatus: string | undefined;
  dependenciesInstallCommand: string;

  // app install / trust
  androidProjectPath: string | null;
  androidProjectExists: boolean | null;
  inferredAndroidProjectPath: string | null;
  androidAppStatus: MobilePreviewAndroidAppStatus | null;
  iosAppStatus: MobilePreviewIosAppStatus | null;
  iosAppStatusError: string | null;
  isIosAppStatusLoading: boolean;
  androidCertGuidanceVisible: boolean;

  // network proxy
  networkStatus: string;
  networkProxyErrorRaw: unknown;
  networkSessionEnableMitm: boolean | undefined;
  networkSessionProxyUrl: string | null | undefined;
  networkCertificateInstalled: boolean;
  proxyIsStarting: boolean;
  proxyIsStopping: boolean;
  proxyIsInstallingCertificate: boolean;
  proxyIsPreparingAndroidAppTrust: boolean;
  networkRunning: boolean;
  showTunneledNetworkRequests: boolean;

  // native logs
  nativeLogRunning: boolean;

  formatDeviceState: (state: MobilePreviewDevice['state']) => string;
};

export type PreviewDerived = {
  appReady: boolean;
  deviceReady: boolean;
  metroStatus: PreviewStepStatus;
  previewStatus: PreviewStepStatus;
  proxyStatus: PreviewStepStatus;
  httpsStatus: PreviewStepStatus;
  prebuildStatusValue: PreviewStepStatus;
  dependenciesInstallStatusValue: string | undefined;
  effectiveAndroidProjectPath: string | null;
  needsExpoAndroidPrebuild: boolean;
  needsExpoIosPrebuild: boolean;
  prebuildDone: boolean;
  androidAppInstalled: boolean;
  androidTrustConfigured: boolean;
  selectedAppInstalled: boolean;
  appNeedsBuild: boolean;
  iosAppReady: boolean;
  iosBuildVerificationFailed: boolean;
};

export function getSetupModel(facts: PreviewFacts, derived: PreviewDerived) {
  const {
    platform,
    deviceId,
    appPath,
    autoStartProxy,
    needsAppSelection,
  } = facts;

  const networkProxyError = facts.networkProxyErrorRaw;
  const {
    appReady,
    deviceReady,
    metroStatus,
    previewStatus,
    proxyStatus,
    httpsStatus,
    prebuildStatusValue,
    dependenciesInstallStatusValue,
    effectiveAndroidProjectPath,
    needsExpoAndroidPrebuild,
    needsExpoIosPrebuild,
    prebuildDone,
    androidAppInstalled,
    androidTrustConfigured,
    selectedAppInstalled,
    appNeedsBuild,
    iosAppReady,
    iosBuildVerificationFailed,
  } = derived;

  // A physical handset that is not reachable blocks everything downstream of
  // the device step: there is nothing to install onto and nothing to stream.
  const physicalDeviceUnreachable =
    facts.selectedDeviceIsPhysical && !facts.selectedDeviceConnected;
  const physicalDeviceDetail =
    facts.selectedDeviceUnavailableReason ?? 'Device not connected';
  const physicalIosStreamingUnsupported =
    facts.selectedDeviceIsPhysical && platform === 'ios';

  const setupSteps: PreviewStepView[] = [
    {
      key: 'app',
      label: 'App selected',
      status: appReady ? 'ready' : 'blocked',
      detail: appReady ? appPath : 'Choose app first',
      tab: null,
    },
    {
      key: 'dependencies-install',
      label: 'Dependencies installed',
      status:
        dependenciesInstallStatusValue === 'errored'
          ? 'error'
          : dependenciesInstallStatusValue === 'running'
            ? 'running'
            : dependenciesInstallStatusValue === 'completed'
              ? 'ready'
              : 'idle',
      detail:
        dependenciesInstallStatusValue === 'completed'
          ? facts.dependenciesInstallCommand
          : dependenciesInstallStatusValue === 'running'
            ? 'Installing dependencies...'
            : dependenciesInstallStatusValue === 'errored'
              ? 'Dependency install failed; check Metro tab logs'
              : facts.dependenciesInstallCommand,
      tab: 'dev-server',
    },
    {
      key: 'device',
      label: 'Device ready',
      status: deviceReady ? 'ready' : deviceId ? 'blocked' : 'idle',
      detail: facts.selectedDevice
        ? facts.selectedDeviceIsPhysical
          ? `${facts.selectedDevice.name} · ${
              facts.selectedDeviceConnected ? 'Connected' : physicalDeviceDetail
            }`
          : `${facts.selectedDevice.name} · ${facts.formatDeviceState(facts.selectedDevice.state)}`
        : facts.activeSessionDeviceReady
          ? `${deviceId} · active preview session`
          : 'Select booted device',
      tab: null,
    },
    ...((autoStartProxy && needsExpoAndroidPrebuild) || needsExpoIosPrebuild
      ? [
          {
            key: 'prebuild' as const,
            label: `${platform === 'android' ? 'Android' : 'iOS'} project generated`,
            status: prebuildStatusValue,
            detail:
              prebuildStatusValue === 'ready'
                ? `${platform === 'android' ? facts.inferredAndroidProjectPath : `${appPath === '.' ? '' : `${appPath}/`}ios`} · generated`
                : prebuildStatusValue === 'running'
                  ? 'Running expo prebuild...'
                  : prebuildStatusValue === 'error'
                    ? 'Prebuild failed; check Metro tab logs'
                    : `Expo app has no ${platform} folder`,
            tab: 'dev-server' as const,
          },
        ]
      : []),
    ...((platform === 'android' && effectiveAndroidProjectPath) ||
    platform === 'ios'
      ? [
          {
            key: 'install' as const,
            label: 'App installed',
            status: (physicalDeviceUnreachable
              ? 'blocked'
              : facts.iosAppStatusError
              ? 'error'
              : facts.isIosAppStatusLoading ||
                  facts.normalizedBuildStatus === 'loading' ||
                  facts.buildStarting ||
                  facts.buildRunning
                ? 'running'
                : selectedAppInstalled
                  ? 'ready'
                  : appNeedsBuild
                    ? 'blocked'
                    : 'idle') as PreviewStepStatus,
            detail: physicalDeviceUnreachable
              ? physicalDeviceDetail
              : (facts.buildCommandDeviceNotice ??
                (platform === 'android'
                ? facts.androidAppStatus?.packageName
                  ? androidAppInstalled
                    ? `${facts.androidAppStatus.packageName} · installed`
                    : `${facts.androidAppStatus.packageName} · build required`
                  : 'Package id not detected; build optional'
                : facts.iosAppStatus?.bundleId
                  ? iosAppReady
                    ? `${facts.iosAppStatus.bundleId} · installed`
                    : `${facts.iosAppStatus.bundleId} · build required`
                  : facts.isIosAppStatusLoading
                    ? 'Checking simulator app status...'
                    : facts.normalizedBuildStatus === 'loading'
                      ? 'Checking persisted build history...'
                      : facts.iosAppStatusError
                        ? `Status check failed: ${facts.iosAppStatusError}`
                        : iosBuildVerificationFailed
                          ? 'Build completed, but bundle id is still unresolved'
                          : facts.normalizedBuildStatus === 'errored'
                            ? 'Build failed; check iOS build logs'
                            : 'Bundle id not detected; build required')),
            tab: 'dev-server' as const,
          },
        ]
      : []),
    {
      key: 'metro',
      label: 'Metro running',
      status: metroStatus,
      detail: facts.devServerRunning
        ? `port ${facts.effectiveDevServerPort} · live`
        : facts.devServerStarting
          ? 'Starting dev server...'
          : 'Not started',
      tab: 'dev-server',
    },
    // Physical iOS has no capture path, so streaming is not part of that
    // target's setup at all — build, install and launch *are* the complete
    // working setup there. A step that could never reach `ready` would make a
    // correctly-running workspace look permanently broken. The explanation
    // lives on the preview surface instead (see
    // PHYSICAL_IOS_STREAMING_UNSUPPORTED_DETAIL).
    ...(physicalIosStreamingUnsupported
      ? []
      : [
          {
            key: 'preview' as const,
            label: 'Preview streaming',
            status: previewStatus,
            detail:
              facts.previewMethodText ??
              (previewStatus === 'running'
                ? 'Starting stream...'
                : 'Not started'),
            tab: null,
          },
        ]),
    ...(autoStartProxy
      ? [
          {
            key: 'proxy' as const,
            label: 'Proxy running',
            status: proxyStatus,
            detail: networkProxyError
              ? cleanPreviewError(formatError(networkProxyError) ?? 'Proxy failed')
              : facts.networkStatus === 'running'
                ? (facts.networkSessionProxyUrl ?? 'Proxy live')
                : facts.proxyIsStarting
                  ? 'Starting proxy...'
                  : platform === 'android'
                    ? 'Android emulator proxy auto-configured'
                    : 'iOS proxy routing automatic',
            tab: 'network' as const,
          },
          {
            key: 'https' as const,
            label: 'HTTPS decrypt ready',
            status: httpsStatus,
            detail: (httpsStatus === 'ready'
              ? { kind: 'network-request-count' }
              : httpsStatus === 'blocked'
                ? effectiveAndroidProjectPath
                  ? androidTrustConfigured
                    ? 'Build and install app on device'
                    : 'Rebuild app so debug trust config applies'
                  : 'Set Android project folder in project settings'
                : httpsStatus === 'running'
                  ? 'Preparing certificate trust...'
                  : !facts.networkCertificateInstalled
                    ? platform === 'android' && facts.androidCertGuidanceVisible
                      ? 'Finish CA install on Android, then restart app'
                      : 'Install CA certificate to decrypt HTTPS'
                    : facts.networkStatus !== 'running'
                      ? 'Start proxy with HTTPS decrypt'
                      : 'Waiting for certificate trust') as PreviewStepDetail,
            tab: 'network' as const,
          },
        ]
      : []),
  ];

  const readySetupSteps = setupSteps.filter(
    (step) => step.status === 'ready',
  ).length;
  const incompleteSetupSteps = setupSteps.filter(
    (step) => step.status !== 'ready',
  );
  const anySetupRunning = setupSteps.some((step) => step.status === 'running');
  const anySetupStopping =
    facts.isStopping ||
    facts.devServerStopping ||
    facts.buildStopping ||
    facts.prebuildStopping ||
    facts.proxyIsStopping;
  const canStopSetup = !!(
    facts.hasActiveSession ||
    facts.isStarting ||
    facts.devServerRunning ||
    facts.buildRunning ||
    facts.prebuildStatusStatus === 'running' ||
    facts.nativeLogRunning ||
    facts.networkRunning ||
    anySetupStopping
  );
  const allSetupReady = readySetupSteps === setupSteps.length;
  const blockedSetupStep = setupSteps.find(
    (step) => step.status === 'blocked' || step.status === 'error',
  );
  const nextSetupStep =
    blockedSetupStep ??
    incompleteSetupSteps.find((step) => step.status !== 'running') ??
    incompleteSetupSteps[0] ??
    null;
  const missingSetupLabels = incompleteSetupSteps
    .filter((step) => step.status !== 'running')
    .map((step) => step.label);
  const missingSetupDetail = missingSetupLabels.length
    ? `Missing: ${missingSetupLabels.join(', ')}.`
    : 'Setup is running.';

  const ctaLabel = allSetupReady
    ? 'Workspace ready'
    : anySetupRunning
      ? 'Starting workspace...'
      : needsAppSelection
        ? 'Continue setup'
        : platform === 'ios' && facts.iosAppStatusError
          ? 'Retry app status'
          : ((autoStartProxy && needsExpoAndroidPrebuild) ||
                needsExpoIosPrebuild) &&
              !prebuildDone
            ? 'Run Expo prebuild'
            : autoStartProxy && proxyStatus === 'error'
              ? 'Restart proxy'
              : autoStartProxy && httpsStatus === 'blocked'
                ? 'Fix Android trust'
                : nextSetupStep?.key === 'https'
                  ? facts.networkCertificateInstalled
                    ? 'Finish HTTPS setup'
                    : 'Install certificate'
                  : readySetupSteps > 2
                    ? 'Continue setup'
                    : 'Start workspace';
  const ctaDisabled =
    allSetupReady || anySetupRunning || needsAppSelection || !deviceReady;
  const setupHeadline = allSetupReady
    ? 'Workspace ready'
    : nextSetupStep
      ? `Next: ${nextSetupStep.label}`
      : readySetupSteps > 2
        ? 'Resume mobile debug'
        : 'Debug this app end-to-end';
  const setupDetail = allSetupReady
    ? physicalIosStreamingUnsupported
      ? `The app is built, installed and launched on this iPhone. ${PHYSICAL_IOS_STREAMING_UNSUPPORTED_DETAIL}`
      : autoStartProxy
      ? 'Preview, Metro, proxy, and HTTPS decrypt are live.'
      : 'Preview and Metro are live. Proxy stays manual.'
    : nextSetupStep
      ? `${typeof nextSetupStep.detail === 'string' ? nextSetupStep.detail : ''}. ${missingSetupDetail}`
      : autoStartProxy
        ? 'One action starts Metro, preview, proxy, and HTTPS decrypt. Logs stay manual.'
        : 'One action starts Metro and preview. Proxy stays manual.';

  return {
    setupSteps,
    readySetupSteps,
    incompleteSetupSteps,
    anySetupRunning,
    anySetupStopping,
    canStopSetup,
    allSetupReady,
    blockedSetupStep,
    nextSetupStep,
    missingSetupLabels,
    missingSetupDetail,
    ctaLabel,
    ctaDisabled,
    setupHeadline,
    setupDetail,
  };
}
