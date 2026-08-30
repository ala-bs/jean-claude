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
  | 'preview-toggle';

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
        // Both platforms scope the build command id by device now, so a build
        // without a target device would write into a shared "no-device" stream.
        // A physical device satisfies this as soon as it is connected.
        !deviceId ||
        (facts.selectedDeviceIsPhysical && !facts.selectedDeviceConnected) ||
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
    // Physical iPhones have no capture path, so offering "Start" here would
    // only produce an adapter error. The step itself explains why.
    const physicalIosStreamingUnsupported =
      platform === 'ios' && facts.selectedDeviceIsPhysical;
    return {
      label: facts.hasActiveSession ? 'Stop' : 'Start',
      intent: 'preview-toggle',
      disabled:
        (physicalIosStreamingUnsupported && !facts.hasActiveSession) ||
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

  return null;
}
