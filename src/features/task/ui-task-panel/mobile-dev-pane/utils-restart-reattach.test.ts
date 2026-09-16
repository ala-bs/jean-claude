import { describe, expect, it } from 'vitest';

import { resolveRestartReattach } from './utils-restart-reattach';

const BASE = {
  isExpoApp: true,
  hasLiveDevServerPort: true,
  device: { platform: 'ios' as const, kind: 'simulator' as const },
  metroPort: 8082,
  appScheme: 'myapp' as string | null,
};

describe('resolveRestartReattach', () => {
  it('re-attaches a simulator to the live Metro port', () => {
    expect(resolveRestartReattach(BASE)).toEqual({
      metroPort: 8082,
      appScheme: 'myapp',
    });
  });

  it('skips a bare React Native app, which has no exp:// URL', () => {
    expect(
      resolveRestartReattach({ ...BASE, isExpoApp: false }),
    ).toBeNull();
  });

  it('skips when there is no live dev server port', () => {
    // launchExpo requires a running command serving exactly this port.
    expect(
      resolveRestartReattach({ ...BASE, hasLiveDevServerPort: false }),
    ).toBeNull();
  });

  it('skips physical iOS devices, which simctl openurl cannot address', () => {
    // Asking anyway paints an error on a restart that succeeded.
    expect(
      resolveRestartReattach({
        ...BASE,
        device: { platform: 'ios', kind: 'physical' },
      }),
    ).toBeNull();
  });

  it('still re-attaches physical Android devices', () => {
    // The iOS-only guard must not swallow Android hardware, which deeplinks
    // fine over adb.
    expect(
      resolveRestartReattach({
        ...BASE,
        device: { platform: 'android', kind: 'physical' },
      }),
    ).toEqual({ metroPort: 8082, appScheme: 'myapp' });
  });
});
