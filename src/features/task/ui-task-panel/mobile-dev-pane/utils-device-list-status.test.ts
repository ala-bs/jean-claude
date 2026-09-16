import { describe, expect, it } from 'vitest';

import { resolveDeviceListStatus } from './utils-device-list-status';

const IDLE = { isLoading: false, isFetching: false, error: null };
const LOADING = { isLoading: true, isFetching: true, error: null };
const FAILED = { isLoading: false, isFetching: false, error: new Error('no sdk') };

describe('resolveDeviceListStatus', () => {
  it('does not report a hard error while the other platform is still loading', () => {
    // Android tooling fails fast; a cold simctl takes seconds. Without the
    // loading guard the pane flashes a red error before the iOS list arrives.
    const status = resolveDeviceListStatus({
      deviceCount: 0,
      ios: LOADING,
      android: FAILED,
    });

    expect(status.isLoading).toBe(true);
    expect(status.errors).toEqual([]);
    expect(status.failedPlatforms).toEqual(['Android']);
  });

  it('keeps one platform usable when the other cannot be listed', () => {
    const status = resolveDeviceListStatus({
      deviceCount: 3,
      ios: IDLE,
      android: FAILED,
    });

    expect(status.errors).toEqual([]);
    expect(status.failedPlatforms).toEqual(['Android']);
  });

  it('reports a hard error only once nothing loaded and loading settled', () => {
    const status = resolveDeviceListStatus({
      deviceCount: 0,
      ios: FAILED,
      android: FAILED,
    });

    expect(status.errors).toHaveLength(2);
    expect(status.failedPlatforms).toEqual(['iOS', 'Android']);
  });

  it('surfaces an android-only failure rather than only the ios error', () => {
    // A naive `iosError ?? androidError` would report nothing here.
    const status = resolveDeviceListStatus({
      deviceCount: 0,
      ios: IDLE,
      android: FAILED,
    });

    expect(status.errors).toHaveLength(1);
    expect((status.errors[0] as Error).message).toBe('no sdk');
  });

  it('reports no failure when both platforms simply have no devices', () => {
    const status = resolveDeviceListStatus({
      deviceCount: 0,
      ios: IDLE,
      android: IDLE,
    });

    expect(status.failedPlatforms).toEqual([]);
    expect(status.errors).toEqual([]);
  });

  it('is fetching while either platform refetches', () => {
    expect(
      resolveDeviceListStatus({
        deviceCount: 2,
        ios: { isLoading: false, isFetching: true, error: null },
        android: IDLE,
      }).isFetching,
    ).toBe(true);
  });
});
