import { describe, expect, it } from 'vitest';

import { getDeviceCornerRadiusRatio } from './utils-device-frame';

describe('getDeviceCornerRadiusRatio', () => {
  it('uses iPhone family profiles', () => {
    expect(
      getDeviceCornerRadiusRatio({ platform: 'ios', deviceName: 'iPhone 16 Pro' }),
    ).toBe(0.118);
    expect(
      getDeviceCornerRadiusRatio({ platform: 'ios', deviceName: 'iPhone 11' }),
    ).toBe(0.105);
    expect(
      getDeviceCornerRadiusRatio({ platform: 'ios', deviceName: 'iPhone SE (3rd generation)' }),
    ).toBe(0);
  });

  it('uses Android family profiles and subtle unknown fallback', () => {
    expect(
      getDeviceCornerRadiusRatio({ platform: 'android', deviceName: 'Pixel_8_API_35' }),
    ).toBe(0.085);
    expect(
      getDeviceCornerRadiusRatio({ platform: 'android', deviceName: 'Galaxy S24' }),
    ).toBe(0.065);
    expect(
      getDeviceCornerRadiusRatio({ platform: 'android', deviceName: 'Custom Phone' }),
    ).toBe(0.04);
  });
});
