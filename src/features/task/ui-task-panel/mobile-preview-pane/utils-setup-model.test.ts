import { describe, expect, it } from 'vitest';

import {
  getSetupModel,
  type PreviewDerived,
  type PreviewFacts,
  type PreviewStepKey,
} from './utils-setup-model';
import { baseDerived, baseFacts } from './utils-preview-fixtures';

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
  it('shows the base steps with proxy disabled', () => {
    expect(keys()).toEqual([
      'app',
      'dependencies-install',
      'device',
      'install',
      'metro',
      'preview',
    ]);
  });

  it('adds proxy and https when autoStartProxy is on', () => {
    expect(keys({ autoStartProxy: true })).toContain('proxy');
    expect(keys({ autoStartProxy: true })).toContain('https');
  });

  it('omits proxy and https when autoStartProxy is off', () => {
    expect(keys()).not.toContain('proxy');
    expect(keys()).not.toContain('https');
  });

  it('adds prebuild for ios when an ios prebuild is needed', () => {
    expect(keys({}, { needsExpoIosPrebuild: true })).toContain('prebuild');
  });

  it('adds prebuild for android only when the proxy is auto-started', () => {
    expect(
      keys({ platform: 'android' }, { needsExpoAndroidPrebuild: true }),
    ).not.toContain('prebuild');
    expect(
      keys(
        { platform: 'android', autoStartProxy: true },
        { needsExpoAndroidPrebuild: true },
      ),
    ).toContain('prebuild');
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

  it('surfaces proxy errors in the proxy step', () => {
    const proxy = step('proxy', {
      autoStartProxy: true,
      networkProxyErrorRaw: new Error('proxy exploded'),
    });
    expect(proxy.status).toBe('idle');
    expect(String(proxy.detail)).toContain('proxy exploded');
  });

  it('shows the proxy url when running', () => {
    expect(
      step('proxy', {
        autoStartProxy: true,
        networkStatus: 'running',
        networkSessionProxyUrl: 'http://127.0.0.1:9090',
      }).detail,
    ).toBe('http://127.0.0.1:9090');
  });
});

describe('getSetupModel — https step detail is a descriptor, never JSX', () => {
  it('returns the network-request-count descriptor when ready', () => {
    expect(step('https', { autoStartProxy: true }, { httpsStatus: 'ready' }).detail).toEqual({
      kind: 'network-request-count',
    });
  });

  it('explains android trust when blocked', () => {
    expect(
      step(
        'https',
        { autoStartProxy: true, platform: 'android' },
        {
          httpsStatus: 'blocked',
          effectiveAndroidProjectPath: 'apps/mobile/android',
          androidTrustConfigured: true,
        },
      ).detail,
    ).toBe('Build and install app on device');

    expect(
      step(
        'https',
        { autoStartProxy: true, platform: 'android' },
        {
          httpsStatus: 'blocked',
          effectiveAndroidProjectPath: 'apps/mobile/android',
          androidTrustConfigured: false,
        },
      ).detail,
    ).toBe('Rebuild app so debug trust config applies');

    expect(
      step(
        'https',
        { autoStartProxy: true, platform: 'android' },
        { httpsStatus: 'blocked', effectiveAndroidProjectPath: null },
      ).detail,
    ).toBe('Set Android project folder in project settings');
  });

  it('guides certificate install when not yet installed', () => {
    expect(
      step('https', { autoStartProxy: true, networkCertificateInstalled: false }).detail,
    ).toBe('Install CA certificate to decrypt HTTPS');

    expect(
      step('https', {
        autoStartProxy: true,
        platform: 'android',
        networkCertificateInstalled: false,
        androidCertGuidanceVisible: true,
      }).detail,
    ).toBe('Finish CA install on Android, then restart app');
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
    expect(result.setupDetail).toBe('Preview and Metro are live. Proxy stays manual.');
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

  it('offers to restart a failed proxy', () => {
    expect(
      model({ autoStartProxy: true }, { proxyStatus: 'error' }).ctaLabel,
    ).toBe('Restart proxy');
  });

  it('offers to fix android trust when https is blocked', () => {
    expect(
      model({ autoStartProxy: true }, { httpsStatus: 'blocked' }).ctaLabel,
    ).toBe('Fix Android trust');
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
    expect(model({ networkRunning: true }).canStopSetup).toBe(true);
    expect(model({ prebuildStatusStatus: 'running' }).canStopSetup).toBe(true);
  });

  it('anySetupStopping follows any stopping resource', () => {
    expect(model({ isStopping: true }).anySetupStopping).toBe(true);
    expect(model({ devServerStopping: true }).anySetupStopping).toBe(true);
    expect(model({ buildStopping: true }).anySetupStopping).toBe(true);
    expect(model({ prebuildStopping: true }).anySetupStopping).toBe(true);
    expect(model({ proxyIsStopping: true }).anySetupStopping).toBe(true);
    expect(model().anySetupStopping).toBe(false);
  });

  it('never interpolates a descriptor detail into the summary text', () => {
    const result = model(
      { autoStartProxy: true, deviceId: '' },
      { httpsStatus: 'ready', deviceReady: false },
    );
    expect(result.setupDetail).not.toContain('[object Object]');
  });
});
