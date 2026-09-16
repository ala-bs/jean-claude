import { describe, expect, it } from 'vitest';

import type { MobilePreviewDevice } from '@shared/mobile-simulator-types';

import { makeMobileDevDeviceKey } from '@/stores/mobile-dev-pane';

import {
  buildDeviceOptions,
  FAVORITES_GROUP_LABEL,
  getFavoriteDevices,
  isFavoriteDevice,
  PLATFORM_LABELS,
} from './utils-device-options';

function device(
  overrides: Partial<MobilePreviewDevice> & { id: string; name: string },
): MobilePreviewDevice {
  return { platform: 'ios', state: 'shutdown', ...overrides };
}

const SE = device({ id: 'sim-se', name: 'iPhone SE' });
const PRO = device({ id: 'sim-pro', name: 'iPhone 16 Pro', state: 'booted' });
const PIXEL = device({ id: 'Pixel_8', name: 'Pixel 8', platform: 'android' });
const NEXUS = device({ id: 'Nexus_5', name: 'Nexus 5', platform: 'android' });

function favorites(...devices: MobilePreviewDevice[]) {
  return Object.fromEntries(
    devices.map((entry) => [
      makeMobileDevDeviceKey({ platform: entry.platform, deviceId: entry.id }),
      {
        platform: entry.platform,
        deviceId: entry.id,
        deviceName: entry.name,
      },
    ]),
  );
}

describe('buildDeviceOptions', () => {
  it('orders favorites, then iOS, then Android', () => {
    const options = buildDeviceOptions({
      devices: [SE, PRO, PIXEL, NEXUS],
      favoriteDevices: favorites(NEXUS),
    });

    expect(options.map((option) => option.value)).toEqual([
      'android:Nexus_5',
      // Booted first inside the iOS group.
      'ios:sim-pro',
      'ios:sim-se',
      'android:Pixel_8',
    ]);
    expect(options[0].group).toBe(FAVORITES_GROUP_LABEL);
    expect(options[1].group).toBe(PLATFORM_LABELS.ios);
    expect(options[3].group).toBe(PLATFORM_LABELS.android);
  });

  it('floats booted devices to the top of each group and marks them active', () => {
    const bootedPixel = device({
      id: 'Pixel_9',
      name: 'Pixel 9',
      platform: 'android',
      state: 'booted',
    });
    const bootedNexus = { ...NEXUS, state: 'booted' as const };

    const options = buildDeviceOptions({
      devices: [SE, PRO, PIXEL, bootedPixel, bootedNexus],
      favoriteDevices: favorites(NEXUS, SE),
    });

    expect(options.map((option) => option.value)).toEqual([
      'android:Nexus_5',
      'ios:sim-se',
      'ios:sim-pro',
      'android:Pixel_9',
      'android:Pixel_8',
    ]);
    expect(
      options
        .filter((option) => option.indicator === 'active')
        .map((option) => option.value),
    ).toEqual(['android:Nexus_5', 'ios:sim-pro', 'android:Pixel_9']);
  });

  it('keys options by platform and id so ids can collide across platforms', () => {
    const collidingAndroid = device({
      id: 'sim-se',
      name: 'Emulator',
      platform: 'android',
    });
    const options = buildDeviceOptions({
      devices: [SE, collidingAndroid],
      favoriteDevices: {},
    });

    expect(options.map((option) => option.value)).toEqual([
      'ios:sim-se',
      'android:sim-se',
    ]);
  });

  it('omits group labels when only one group is non-empty', () => {
    // A lone "iOS" header above every row is pure noise.
    const options = buildDeviceOptions({
      devices: [SE, PRO],
      favoriteDevices: {},
    });

    expect(options.every((option) => option.group === undefined)).toBe(true);
  });

  it('labels groups as soon as both platforms are present', () => {
    const options = buildDeviceOptions({
      devices: [SE, PIXEL],
      favoriteDevices: {},
    });

    expect(options[0].group).toBe(PLATFORM_LABELS.ios);
    expect(options[1].group).toBe(PLATFORM_LABELS.android);
  });

  it('names the platform on favorite rows, whose header spans both', () => {
    const options = buildDeviceOptions({
      devices: [SE, PIXEL],
      favoriteDevices: favorites(PIXEL),
    });

    expect(options[0].value).toBe('android:Pixel_8');
    expect(options[0].description).toBe('Android');
    // The iOS row sits under an "iOS" header, so it must not repeat it. Assert
    // the exact string: `not.toContain('iOS ·')` passed even with the platform
    // wrongly included, because this fixture has no other description parts to
    // produce a separator.
    expect(options[1].description).toBe('');
  });

  it('names the platform inline when group labels are suppressed', () => {
    const options = buildDeviceOptions({
      devices: [SE],
      favoriteDevices: {},
    });

    expect(options[0].description).toContain('iOS');
  });

  it('surfaces state and unavailability in the description', () => {
    const options = buildDeviceOptions({
      devices: [
        device({
          id: 'sim-x',
          name: 'iPhone X',
          osVersion: 'iOS 18.2',
          state: 'booted',
          unavailableReason: 'Runtime missing',
        }),
      ],
      favoriteDevices: {},
    });

    expect(options[0].description).toBe(
      'iOS · iOS 18.2 · Booted · Runtime missing',
    );
  });

  it('exposes platform, id and state as searchable keywords', () => {
    // The platform usually lives in the group header rather than the row, but
    // "android" is an obvious thing to type into the search box.
    const options = buildDeviceOptions({
      devices: [PIXEL],
      favoriteDevices: {},
    });

    expect(options[0].keywords).toEqual(
      expect.arrayContaining(['Android', 'android', 'Pixel_8', 'shutdown']),
    );
  });

  it('marks booted devices as searchable by state', () => {
    const options = buildDeviceOptions({
      devices: [PRO],
      favoriteDevices: {},
    });

    expect(options[0].keywords).toContain('booted');
  });
});

describe('getFavoriteDevices', () => {
  it('returns favorites from both platforms in list order', () => {
    const result = getFavoriteDevices({
      devices: [SE, PRO, PIXEL],
      favoriteDevices: favorites(PRO, PIXEL),
    });

    expect(result).toEqual([PRO, PIXEL]);
  });

  it('returns only favorites present in the live device list', () => {
    // A chip for a device that is gone would be a dead end: selecting it
    // resolves to "nothing selected".
    const missing = device({ id: 'sim-gone', name: 'Deleted' });
    const result = getFavoriteDevices({
      devices: [SE, PRO],
      favoriteDevices: favorites(PRO, missing),
    });

    expect(result).toEqual([PRO]);
  });

  it('returns an empty list when nothing is favorited', () => {
    expect(
      getFavoriteDevices({ devices: [SE, PRO], favoriteDevices: {} }),
    ).toEqual([]);
  });
});

describe('isFavoriteDevice', () => {
  it('keys favorites by platform and device id together', () => {
    const favoriteDevices = favorites(SE);
    expect(
      isFavoriteDevice({ favoriteDevices, platform: 'ios', deviceId: 'sim-se' }),
    ).toBe(true);
    expect(
      isFavoriteDevice({
        favoriteDevices,
        platform: 'android',
        deviceId: 'sim-se',
      }),
    ).toBe(false);
  });
});
