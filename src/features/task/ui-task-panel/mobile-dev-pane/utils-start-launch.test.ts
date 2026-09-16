import { describe, expect, it } from 'vitest';

import { resolveStartLaunchDecision } from './utils-start-launch';

const simulator = { platform: 'ios' as const, kind: 'simulator' as const };

function decide(
  overrides: Partial<Parameters<typeof resolveStartLaunchDecision>[0]> = {},
) {
  return resolveStartLaunchDecision({
    isPending: true,
    hasLiveDevServerPort: true,
    isLoadingDevices: false,
    device: simulator,
    isDeviceBooted: true,
    isExpoApp: true,
    metroPort: 8081,
    appScheme: 'myapp',
    ...overrides,
  });
}

describe('resolveStartLaunchDecision', () => {
  it('stays idle when no start is pending', () => {
    expect(decide({ isPending: false })).toEqual({ status: 'idle' });
  });

  it('waits until the dev server reports a live port', () => {
    // Deeplinking the configured port during startup is rejected by
    // `launchExpo` when the runner fell back to another port.
    expect(decide({ hasLiveDevServerPort: false })).toEqual({
      status: 'waiting',
    });
  });

  it('launches the app on the selected booted simulator', () => {
    expect(decide()).toEqual({
      status: 'launch',
      metroPort: 8081,
      appScheme: 'myapp',
    });
  });

  it('waits while the device list is still loading', () => {
    // `device` is null both when nothing is selected and while the list loads.
    // Skipping here would drop the deeplink whenever Metro wins the race
    // against `simctl list`, with no way to retry.
    expect(decide({ isLoadingDevices: true, device: null })).toEqual({
      status: 'waiting',
    });
  });

  it('skips when no device is selected', () => {
    expect(decide({ device: null })).toEqual({ status: 'skip' });
  });

  it('skips a device that is not booted', () => {
    // `simctl openurl` on a shut-down simulator errors, and starting Metro
    // still succeeded.
    expect(decide({ isDeviceBooted: false })).toEqual({ status: 'skip' });
  });

  it('skips a bare React Native app', () => {
    expect(decide({ isExpoApp: false })).toEqual({ status: 'skip' });
  });

  it('skips physical iOS hardware', () => {
    // `exp://` deeplinking an installed app is simulator-only on iOS.
    expect(
      decide({ device: { platform: 'ios', kind: 'physical' } }),
    ).toEqual({ status: 'skip' });
  });
});
