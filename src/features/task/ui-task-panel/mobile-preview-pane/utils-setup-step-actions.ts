import type {
  PreviewDerived,
  PreviewFacts,
  PreviewStepKey,
} from './utils-setup-model';

/**
 * What a setup-step button *means*, decoupled from how it is wired.
 *
 * The component maps each intent to a handler through a lookup object, so this
 * module stays pure and unit-testable.
 */
export type PreviewStepActionIntent =
  | 'dependencies-install-toggle'
  | 'prebuild-toggle'
  | 'ios-app-status-retry'
  | 'build-toggle'
  | 'dev-server-toggle'
  | 'preview-toggle'
  | 'proxy-toggle'
  | 'android-app-trust'
  | 'install-network-certificate';

export type PreviewStepAction = {
  label: string;
  disabled: boolean;
  loading: boolean;
  variant: 'primary' | 'secondary';
  intent: PreviewStepActionIntent;
};

/**
 * Capabilities that are not part of the setup model's facts because only the
 * action row cares about them.
 */
export type PreviewActionFacts = {
  dependenciesInstallStarting: boolean;
  hasBuildCommand: boolean;
  hasNetworkProxyStartParams: boolean;
};

export function getSetupStepAction(
  stepKey: PreviewStepKey,
  facts: PreviewFacts,
  derived: PreviewDerived,
  actionFacts: PreviewActionFacts,
): PreviewStepAction | null {
  const { platform, deviceId, needsAppSelection } = facts;

  if (stepKey === 'dependencies-install') {
    const running = derived.dependenciesInstallStatusValue === 'running';
    return {
      label: running ? 'Stop' : 'Run',
      intent: 'dependencies-install-toggle',
      disabled: actionFacts.dependenciesInstallStarting,
      loading: actionFacts.dependenciesInstallStarting,
      variant: running ? 'secondary' : 'primary',
    };
  }

  if (stepKey === 'prebuild') {
    const running = facts.prebuildStatusStatus === 'running';
    return {
      label: running ? 'Stop' : 'Run',
      intent: 'prebuild-toggle',
      disabled: facts.prebuildStarting,
      loading: facts.prebuildStarting,
      variant: running ? 'secondary' : 'primary',
    };
  }

  if (stepKey === 'install') {
    if (platform === 'ios' && facts.iosAppStatusError) {
      return {
        label: 'Retry',
        intent: 'ios-app-status-retry',
        disabled: facts.isIosAppStatusLoading,
        loading: facts.isIosAppStatusLoading,
        variant: 'primary',
      };
    }
    return {
      label: facts.buildRunning
        ? 'Stop'
        : derived.selectedAppInstalled ||
            facts.normalizedBuildStatus === 'completed'
          ? 'Rebuild'
          : 'Build',
      intent: 'build-toggle',
      disabled:
        !actionFacts.hasBuildCommand ||
        needsAppSelection ||
        (platform === 'ios' && !deviceId) ||
        facts.normalizedBuildStatus === 'loading' ||
        facts.buildStarting ||
        facts.buildStopping,
      loading: facts.buildStarting || facts.buildStopping,
      variant: facts.buildRunning ? 'secondary' : 'primary',
    };
  }

  if (stepKey === 'metro') {
    return {
      label: facts.devServerRunning ? 'Stop' : 'Start',
      intent: 'dev-server-toggle',
      disabled:
        needsAppSelection || facts.devServerStarting || facts.devServerStopping,
      loading: facts.devServerStarting || facts.devServerStopping,
      variant: facts.devServerRunning ? 'secondary' : 'primary',
    };
  }

  if (stepKey === 'preview') {
    return {
      label: facts.hasActiveSession ? 'Stop' : 'Start',
      intent: 'preview-toggle',
      disabled:
        facts.isStopping ||
        (!facts.hasActiveSession &&
          (!deviceId ||
            !derived.deviceReady ||
            facts.isStarting ||
            needsAppSelection)),
      loading: facts.isStarting || facts.isStopping,
      variant: facts.hasActiveSession ? 'secondary' : 'primary',
    };
  }

  // NOTE: there is no 'logs' step in the setup model, so native log capture has
  // no start affordance in this pane. Add a 'logs' step to getSetupModel to
  // bring it back.

  if (stepKey === 'proxy') {
    return {
      label: facts.networkRunning ? 'Stop' : 'Start',
      intent: 'proxy-toggle',
      disabled:
        !actionFacts.hasNetworkProxyStartParams ||
        facts.proxyIsStarting ||
        facts.proxyIsStopping ||
        facts.proxyIsInstallingCertificate,
      loading: facts.proxyIsStarting || facts.proxyIsStopping,
      variant: facts.networkRunning ? 'secondary' : 'primary',
    };
  }

  if (stepKey === 'https') {
    const needsTrust = platform === 'android' && !derived.androidTrustConfigured;
    return {
      label: needsTrust ? 'Trust app' : 'Install cert',
      intent: needsTrust ? 'android-app-trust' : 'install-network-certificate',
      disabled:
        !deviceId ||
        !actionFacts.hasNetworkProxyStartParams ||
        facts.proxyIsInstallingCertificate ||
        facts.proxyIsPreparingAndroidAppTrust ||
        facts.proxyIsStarting ||
        facts.proxyIsStopping,
      loading:
        facts.proxyIsInstallingCertificate ||
        facts.proxyIsPreparingAndroidAppTrust,
      variant: 'secondary',
    };
  }

  return null;
}
