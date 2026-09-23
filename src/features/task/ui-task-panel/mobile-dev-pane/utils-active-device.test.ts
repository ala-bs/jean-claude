import { describe, expect, it } from 'vitest';

import type { MobilePreviewDevice } from '@shared/mobile-simulator-types';

import { resolveActiveDevice } from './utils-active-device';

const IPHONE: MobilePreviewDevice = {
  id: 'sim-1',
  name: 'iPhone 16',
  platform: 'ios',
  state: 'shutdown',
};
const PIXEL: MobilePreviewDevice = {
  id: 'Pixel_8',
  name: 'Pixel 8',
  platform: 'android',
  state: 'booted',
};

describe('resolveActiveDevice', () => {
  it('resolves a persisted device that is still listed', () => {
    const result = resolveActiveDevice({
      devices: [IPHONE, PIXEL],
      selection: { platform: 'ios', deviceId: 'sim-1', deviceName: 'iPhone 16' },
    });
    expect(result.activeDeviceKey).toBe('ios:sim-1');
    expect(result.activeDevice).toBe(IPHONE);
  });

  it('resolves an android device from the same merged list', () => {
    const result = resolveActiveDevice({
      devices: [IPHONE, PIXEL],
      selection: {
        platform: 'android',
        deviceId: 'Pixel_8',
        deviceName: 'Pixel 8',
      },
    });
    expect(result.activeDeviceKey).toBe('android:Pixel_8');
    expect(result.activeDevice).toBe(PIXEL);
  });

  it('reports nothing selected when the persisted device vanished', () => {
    // Deleted simulator. Returning the stale key would leave Boot/Restart
    // targeting a device the user can no longer see in the picker.
    const result = resolveActiveDevice({
      devices: [IPHONE],
      selection: {
        platform: 'ios',
        deviceId: 'sim-deleted',
        deviceName: 'Old iPhone',
      },
    });
    expect(result.activeDeviceKey).toBe('');
    expect(result.activeDevice).toBeNull();
  });

  it('does not match the same id across platforms', () => {
    // Ids are only unique within a platform, so an AVD name could in principle
    // collide with a simulator UDID in the merged list.
    const collidingAndroid: MobilePreviewDevice = {
      id: 'sim-1',
      name: 'Some Emulator',
      platform: 'android',
      state: 'shutdown',
    };
    const result = resolveActiveDevice({
      devices: [collidingAndroid],
      selection: { platform: 'ios', deviceId: 'sim-1', deviceName: 'iPhone 16' },
    });
    expect(result.activeDeviceKey).toBe('');
    expect(result.activeDevice).toBeNull();
  });

  it('exposes the cached name even before the list resolves', () => {
    expect(
      resolveActiveDevice({
        devices: [],
        selection: {
          platform: 'ios',
          deviceId: 'sim-1',
          deviceName: 'iPhone 16',
        },
      }).persistedDeviceName,
    ).toBe('iPhone 16');
  });

  it('handles no selection at all', () => {
    const result = resolveActiveDevice({
      devices: [IPHONE],
      selection: null,
    });
    expect(result.activeDeviceKey).toBe('');
    expect(result.persistedDeviceName).toBeNull();
  });

  it('does not match an android device by its adb serial', () => {
    // `bootDevice` returns the serial but `listDevices` reports booted
    // emulators under the AVD name, so persisting a serial must not appear to
    // resolve. This is the regression that made the selection unrecoverable.
    const booted: MobilePreviewDevice = {
      ...PIXEL,
      connectionId: 'emulator-5554',
    };
    const result = resolveActiveDevice({
      devices: [booted],
      selection: {
        platform: 'android',
        deviceId: 'emulator-5554',
        deviceName: 'Pixel 8',
      },
    });
    expect(result.activeDeviceKey).toBe('');
  });
});
