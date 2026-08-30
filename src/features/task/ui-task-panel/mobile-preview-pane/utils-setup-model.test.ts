import { describe, expect, it } from 'vitest';

import { baseDerived, baseFacts } from './utils-preview-fixtures';
import {
  getSetupModel,
  PHYSICAL_IOS_STREAMING_UNSUPPORTED_DETAIL,
  type PreviewDerived,
  type PreviewFacts,
  type PreviewStepKey,
} from './utils-setup-model';

function model(
  facts: Partial<PreviewFacts> = {},
  derived: Partial<PreviewDerived> = {},
) {
  return getSetupModel(
    { ...baseFacts, ...facts },
    { ...baseDerived, ...derived },
  );
}

function keys(facts?: Partial<PreviewFacts>, derived?: Partial<PreviewDerived>) {
  return model(facts, derived).setupSteps.map((step) => step.key);
}

function step(
  key: PreviewStepKey,
  facts?: Partial<PreviewFacts>,
  derived?: Partial<PreviewDerived>,
) {
  const found = model(facts, derived).setupSteps.find((s) => s.key === key);
  if (!found) throw new Error(`step ${key} not present`);
  return found;
}

describe('getSetupModel — which steps are present', () => {
  it('shows the base steps', () => {
    expect(keys()).toEqual([
      'app',
      'dependencies-install',
      'device',
      'install',
      'metro',
      'preview',
    ]);
  });

  it('adds prebuild for ios when an ios prebuild is needed', () => {
    expect(keys({}, { needsExpoIosPrebuild: true })).toContain('prebuild');
  });

  it('omits the install step on android without a resolved project path', () => {
    expect(
      keys({ platform: 'android' }, { effectiveAndroidProjectPath: null }),
    ).not.toContain('install');
  });

  it('includes the install step on android once the project path resolves', () => {
    expect(
      keys(
        { platform: 'android' },
        { effectiveAndroidProjectPath: 'apps/mobile/android' },
      ),
    ).toContain('install');
  });
});

describe('getSetupModel — step statuses', () => {
  it('marks app blocked when selection is required', () => {
    expect(step('app', { needsAppSelection: true }, { appReady: false })).toMatchObject({
      status: 'blocked',
      detail: 'Choose app first',
    });
  });

  it('reports dependency install states', () => {
    expect(step('dependencies-install', {}, { dependenciesInstallStatusValue: 'errored' }).status).toBe('error');
    expect(step('dependencies-install', {}, { dependenciesInstallStatusValue: 'running' }).status).toBe('running');
    expect(step('dependencies-install', {}, { dependenciesInstallStatusValue: 'completed' }).status).toBe('ready');
    expect(step('dependencies-install', {}, { dependenciesInstallStatusValue: undefined }).status).toBe('idle');
  });

  it('marks device idle without a device and blocked when not ready', () => {
    expect(step('device', { deviceId: '' }, { deviceReady: false }).status).toBe('idle');
    expect(step('device', { deviceId: 'd1' }, { deviceReady: false }).status).toBe('blocked');
    expect(step('device', {}, { deviceReady: true }).status).toBe('ready');
  });

  it('describes the device using the active session when none is selected', () => {
    expect(
      step('device', { selectedDevice: null, activeSessionDeviceReady: true }).detail,
    ).toBe('device-1 · active preview session');
    expect(
      step('device', { selectedDevice: null, activeSessionDeviceReady: false }).detail,
    ).toBe('Select booted device');
  });

  it('marks install as error when the ios status check failed', () => {
    expect(step('install', { iosAppStatusError: 'boom' }).status).toBe('error');
    expect(step('install', { iosAppStatusError: 'boom' }).detail).toBe(
      'Status check failed: boom',
    );
  });

  it('marks install running while building or loading', () => {
    expect(step('install', { buildRunning: true }).status).toBe('running');
    expect(step('install', { buildStarting: true }).status).toBe('running');
    expect(step('install', { isIosAppStatusLoading: true }).status).toBe('running');
    expect(step('install', { normalizedBuildStatus: 'loading' }).status).toBe('running');
  });

  it('marks install blocked when a build is required', () => {
    expect(
      step('install', {}, { selectedAppInstalled: false, appNeedsBuild: true }).status,
    ).toBe('blocked');
    expect(
      step('install', {}, { selectedAppInstalled: false, appNeedsBuild: false }).status,
    ).toBe('idle');
  });

  it('reports metro state and port', () => {
    expect(step('metro', { devServerRunning: true }, { metroStatus: 'ready' })).toMatchObject({
      status: 'ready',
      detail: 'port 8081 · live',
    });
    expect(step('metro', { devServerStarting: true }, { metroStatus: 'running' }).detail).toBe(
      'Starting dev server...',
    );
    expect(step('metro').detail).toBe('Not started');
  });

  it('prefers the preview method text when present', () => {
    expect(step('preview', { previewMethodText: 'scrcpy h264' }).detail).toBe('scrcpy h264');
    expect(step('preview', {}, { previewStatus: 'running' }).detail).toBe('Starting stream...');
    expect(step('preview').detail).toBe('Not started');
  });

});

describe('getSetupModel — summary', () => {
  it('reports ready when every step is ready', () => {
    const result = model(
      {
        devServerRunning: true,
        sessionStatus: 'streaming',
        previewMethodText: 'live',
      },
      { metroStatus: 'ready', previewStatus: 'ready' },
    );
    expect(result.allSetupReady).toBe(true);
    expect(result.ctaLabel).toBe('Workspace ready');
    expect(result.ctaDisabled).toBe(true);
    expect(result.setupHeadline).toBe('Workspace ready');
    expect(result.setupDetail).toBe('Preview and Metro are live.');
  });

  it('reports running while a step is starting', () => {
    const result = model({ devServerStarting: true }, { metroStatus: 'running' });
    expect(result.anySetupRunning).toBe(true);
    expect(result.ctaLabel).toBe('Starting workspace...');
    expect(result.ctaDisabled).toBe(true);
  });

  it('asks for app selection first', () => {
    expect(model({ needsAppSelection: true }, { appReady: false }).ctaLabel).toBe(
      'Continue setup',
    );
  });

  it('offers to retry a failed ios app status check', () => {
    expect(model({ iosAppStatusError: 'nope' }).ctaLabel).toBe('Retry app status');
  });

  it('offers prebuild when required and not done', () => {
    expect(
      model({}, { needsExpoIosPrebuild: true, prebuildDone: false, prebuildStatusValue: 'idle' })
        .ctaLabel,
    ).toBe('Run Expo prebuild');
  });

  it('disables the cta when the device is not ready', () => {
    expect(model({}, { deviceReady: false }).ctaDisabled).toBe(true);
  });

  it('lists the missing steps in the detail line', () => {
    const result = model({ deviceId: '' }, { deviceReady: false });
    expect(result.setupDetail).toContain('Missing:');
    expect(result.setupDetail).toContain('Device ready');
  });

  it('picks a blocked step as the next step ahead of idle ones', () => {
    const result = model({ needsAppSelection: true }, { appReady: false });
    expect(result.blockedSetupStep?.key).toBe('app');
    expect(result.nextSetupStep?.key).toBe('app');
    expect(result.setupHeadline).toBe('Next: App selected');
  });

  it('canStopSetup follows any live resource', () => {
    expect(model().canStopSetup).toBe(false);
    expect(model({ hasActiveSession: true }).canStopSetup).toBe(true);
    expect(model({ devServerRunning: true }).canStopSetup).toBe(true);
    expect(model({ buildRunning: true }).canStopSetup).toBe(true);
    expect(model({ nativeLogRunning: true }).canStopSetup).toBe(true);
    expect(model({ prebuildStatusStatus: 'running' }).canStopSetup).toBe(true);
  });

  it('anySetupStopping follows any stopping resource', () => {
    expect(model({ isStopping: true }).anySetupStopping).toBe(true);
    expect(model({ devServerStopping: true }).anySetupStopping).toBe(true);
    expect(model({ buildStopping: true }).anySetupStopping).toBe(true);
    expect(model({ prebuildStopping: true }).anySetupStopping).toBe(true);
    expect(model().anySetupStopping).toBe(false);
  });

});

describe('getSetupModel — physical devices', () => {
  const connectedIphone: Partial<PreviewFacts> = {
    platform: 'ios',
    selectedDevice: { name: "Pat's iPhone", state: 'booted' },
    selectedDeviceIsPhysical: true,
    selectedDeviceConnected: true,
  };
  const unreachableIphone: Partial<PreviewFacts> = {
    ...connectedIphone,
    selectedDeviceConnected: false,
    selectedDeviceUnavailableReason: 'Device is locked; unlock to continue',
  };

  it('marks a connected physical device ready and says "Connected"', () => {
    const deviceStep = step(
      'device',
      connectedIphone,
      { deviceReady: true },
    );
    expect(deviceStep.status).toBe('ready');
    expect(deviceStep.detail).toBe("Pat's iPhone · Connected");
  });

  it('lets the install step reach ready on a connected physical device', () => {
    const installStep = step(
      'install',
      { ...connectedIphone, iosAppStatus: { bundleId: 'com.acme.app' } as never },
      { deviceReady: true, selectedAppInstalled: true },
    );
    expect(installStep.status).toBe('ready');
    expect(installStep.detail).toBe('com.acme.app · installed');
  });

  it('blocks the install step with the unavailable reason when not connected', () => {
    const installStep = step(
      'install',
      unreachableIphone,
      { deviceReady: false, selectedAppInstalled: true },
    );
    expect(installStep.status).toBe('blocked');
    expect(installStep.detail).toBe('Device is locked; unlock to continue');
  });

  it('blocks the device step with the unavailable reason when not connected', () => {
    const deviceStep = step('device', unreachableIphone, { deviceReady: false });
    expect(deviceStep.status).toBe('blocked');
    expect(deviceStep.detail).toBe(
      "Pat's iPhone · Device is locked; unlock to continue",
    );
  });

  it('falls back to generic copy when no unavailable reason is given', () => {
    const deviceStep = step(
      'device',
      { ...connectedIphone, selectedDeviceConnected: false },
      { deviceReady: false },
    );
    expect(deviceStep.detail).toBe("Pat's iPhone · Device not connected");
  });

  it('surfaces the build-command notice on the install step', () => {
    const installStep = step(
      'install',
      { ...connectedIphone, buildCommandDeviceNotice: 'Add {{device}} yourself' },
      { deviceReady: true, selectedAppInstalled: true },
    );
    expect(installStep.detail).toBe('Add {{device}} yourself');
  });

  it('drops the preview step entirely for a physical iPhone', () => {
    expect(keys(connectedIphone, { deviceReady: true })).toEqual([
      'app',
      'dependencies-install',
      'device',
      'install',
      'metro',
    ]);
    expect(() => step('preview', connectedIphone, { deviceReady: true })).toThrow(
      'step preview not present',
    );
  });

  it('lets a built and launched physical iPhone read as fully ready', () => {
    const result = model(connectedIphone, {
      deviceReady: true,
      selectedAppInstalled: true,
      metroStatus: 'ready',
    });
    expect(result.allSetupReady).toBe(true);
    expect(result.nextSetupStep).toBeNull();
    expect(result.ctaLabel).toBe('Workspace ready');
    expect(result.setupHeadline).toBe('Workspace ready');
    // The explanation is not lost: it moves into the ready summary (and onto
    // the preview surface's empty state).
    expect(result.setupDetail).toContain(
      PHYSICAL_IOS_STREAMING_UNSUPPORTED_DETAIL,
    );
  });

  it('does not report a preview step as the next action on a physical iPhone', () => {
    const result = model(connectedIphone, {
      deviceReady: true,
      selectedAppInstalled: false,
      appNeedsBuild: true,
    });
    expect(result.nextSetupStep?.key).toBe('install');
    expect(result.missingSetupLabels).not.toContain('Preview streaming');
  });

  it('keeps the preview step for a physical Android device', () => {
    expect(
      keys(
        {
          platform: 'android',
          selectedDeviceIsPhysical: true,
          selectedDeviceConnected: true,
        },
        { deviceReady: true },
      ),
    ).toContain('preview');
  });

  it('keeps physical Android streaming supported', () => {
    const previewStep = step(
      'preview',
      {
        platform: 'android',
        selectedDevice: { name: 'Pixel 7', state: 'booted' },
        selectedDeviceIsPhysical: true,
        selectedDeviceConnected: true,
        previewMethodText: 'scrcpy',
      },
      { deviceReady: true, previewStatus: 'ready' },
    );
    expect(previewStep.status).toBe('ready');
    expect(previewStep.detail).toBe('scrcpy');
  });

  it('does not change any simulator step', () => {
    const deviceStep = step('device');
    expect(deviceStep.status).toBe('ready');
    expect(deviceStep.detail).toBe('iPhone 15 · booted');
    expect(step('preview').status).toBe('idle');
    expect(keys()).toContain('preview');
  });
});
