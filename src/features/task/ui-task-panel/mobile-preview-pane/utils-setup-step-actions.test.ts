import { describe, expect, it } from 'vitest';

import { baseDerived, baseFacts } from './utils-preview-fixtures';
import {
  getSetupStepAction,
  type PreviewActionFacts,
  type PreviewStepAction,
} from './utils-setup-step-actions';
import type { PreviewDerived, PreviewFacts } from './utils-setup-model';

const baseActionFacts: PreviewActionFacts = {
  dependenciesInstallStarting: false,
  hasBuildCommand: true,
};

function action(
  key: Parameters<typeof getSetupStepAction>[0],
  facts: Partial<PreviewFacts> = {},
  derived: Partial<PreviewDerived> = {},
  actionFacts: Partial<PreviewActionFacts> = {},
): PreviewStepAction {
  const result = getSetupStepAction(
    key,
    { ...baseFacts, ...facts },
    { ...baseDerived, ...derived },
    { ...baseActionFacts, ...actionFacts },
  );
  if (!result) throw new Error(`no action for ${key}`);
  return result;
}

describe('getSetupStepAction — steps without actions', () => {
  it('returns null for app and device', () => {
    expect(
      getSetupStepAction('app', baseFacts, baseDerived, baseActionFacts),
    ).toBeNull();
    expect(
      getSetupStepAction('device', baseFacts, baseDerived, baseActionFacts),
    ).toBeNull();
  });
});

describe('getSetupStepAction — dependencies install', () => {
  it('runs when idle and stops when running', () => {
    expect(action('dependencies-install')).toMatchObject({
      label: 'Run',
      variant: 'primary',
      intent: 'dependencies-install-toggle',
    });
    expect(
      action('dependencies-install', {}, { dependenciesInstallStatusValue: 'running' }),
    ).toMatchObject({ label: 'Stop', variant: 'secondary' });
  });

  it('is disabled and loading while starting', () => {
    expect(
      action('dependencies-install', {}, {}, { dependenciesInstallStarting: true }),
    ).toMatchObject({ disabled: true, loading: true });
  });
});

describe('getSetupStepAction — prebuild', () => {
  it('toggles on the prebuild command status', () => {
    expect(action('prebuild')).toMatchObject({ label: 'Run', intent: 'prebuild-toggle' });
    expect(action('prebuild', { prebuildStatusStatus: 'running' })).toMatchObject({
      label: 'Stop',
      variant: 'secondary',
    });
  });

  it('is disabled while starting', () => {
    expect(action('prebuild', { prebuildStarting: true })).toMatchObject({
      disabled: true,
      loading: true,
    });
  });
});

describe('getSetupStepAction — install/build', () => {
  it('offers a retry when the ios status check failed', () => {
    expect(action('install', { iosAppStatusError: 'boom' })).toMatchObject({
      label: 'Retry',
      intent: 'ios-app-status-retry',
    });
  });

  it('does not offer the ios retry on android', () => {
    expect(
      action('install', { platform: 'android', iosAppStatusError: 'boom' }).intent,
    ).toBe('build-toggle');
  });

  it('labels build vs rebuild vs stop', () => {
    expect(action('install', {}, { selectedAppInstalled: false }).label).toBe('Build');
    expect(action('install', {}, { selectedAppInstalled: true }).label).toBe('Rebuild');
    expect(
      action('install', { normalizedBuildStatus: 'completed' }, { selectedAppInstalled: false })
        .label,
    ).toBe('Rebuild');
    expect(action('install', { buildRunning: true })).toMatchObject({
      label: 'Stop',
      variant: 'secondary',
    });
  });

  it('is disabled without a build command', () => {
    expect(action('install', {}, {}, { hasBuildCommand: false }).disabled).toBe(true);
  });

  // Both platforms scope the build command id by device now, so neither can
  // build without one.
  it('is disabled on either platform without a device', () => {
    expect(action('install', { platform: 'ios', deviceId: '' }).disabled).toBe(true);
    expect(action('install', { platform: 'android', deviceId: '' }).disabled).toBe(true);
  });

  it('is disabled while app selection is pending or the build status is loading', () => {
    expect(action('install', { needsAppSelection: true }).disabled).toBe(true);
    expect(action('install', { normalizedBuildStatus: 'loading' }).disabled).toBe(true);
  });
});

describe('getSetupStepAction — metro', () => {
  it('toggles on the dev server', () => {
    expect(action('metro')).toMatchObject({ label: 'Start', intent: 'dev-server-toggle' });
    expect(action('metro', { devServerRunning: true })).toMatchObject({
      label: 'Stop',
      variant: 'secondary',
    });
  });

  it('is disabled while app selection is pending or a transition is in flight', () => {
    expect(action('metro', { needsAppSelection: true }).disabled).toBe(true);
    expect(action('metro', { devServerStarting: true })).toMatchObject({
      disabled: true,
      loading: true,
    });
    expect(action('metro', { devServerStopping: true })).toMatchObject({
      disabled: true,
      loading: true,
    });
  });
});

describe('getSetupStepAction — preview', () => {
  it('toggles on the session', () => {
    expect(action('preview')).toMatchObject({ label: 'Start', intent: 'preview-toggle' });
    expect(action('preview', { hasActiveSession: true })).toMatchObject({
      label: 'Stop',
      variant: 'secondary',
    });
  });

  it('stays enabled to stop an active session even when the device is not ready', () => {
    expect(
      action('preview', { hasActiveSession: true }, { deviceReady: false }).disabled,
    ).toBe(false);
  });

  it('is disabled to start without a ready device', () => {
    expect(action('preview', { deviceId: '' }, { deviceReady: false }).disabled).toBe(true);
    expect(action('preview', {}, { deviceReady: false }).disabled).toBe(true);
    expect(action('preview', { needsAppSelection: true }).disabled).toBe(true);
  });

  it('is always disabled while stopping', () => {
    expect(action('preview', { isStopping: true, hasActiveSession: true })).toMatchObject({
      disabled: true,
      loading: true,
    });
  });
});

describe('getSetupStepAction — physical devices', () => {
  const connectedPixel = {
    platform: 'android' as const,
    selectedDeviceIsPhysical: true,
    selectedDeviceConnected: true,
  };

  it('enables Build for a connected physical Android device', () => {
    expect(action('install', connectedPixel)?.disabled).toBe(false);
  });

  it('enables Build for a connected physical iPhone', () => {
    expect(
      action('install', {
        platform: 'ios',
        selectedDeviceIsPhysical: true,
        selectedDeviceConnected: true,
      })?.disabled,
    ).toBe(false);
  });

  it('disables Build while the physical device is unreachable', () => {
    expect(
      action('install', { ...connectedPixel, selectedDeviceConnected: false })
        ?.disabled,
    ).toBe(true);
  });

  it('disables Build with no device on either platform', () => {
    expect(action('install', { platform: 'android', deviceId: '' })?.disabled).toBe(
      true,
    );
    expect(action('install', { platform: 'ios', deviceId: '' })?.disabled).toBe(
      true,
    );
  });

  it('disables Start preview for a physical iPhone (no capture path)', () => {
    expect(
      action('preview', {
        platform: 'ios',
        selectedDeviceIsPhysical: true,
        selectedDeviceConnected: true,
      })?.disabled,
    ).toBe(true);
  });

  it('keeps Start preview available for a physical Android device', () => {
    expect(action('preview', connectedPixel)?.disabled).toBe(false);
  });
});
