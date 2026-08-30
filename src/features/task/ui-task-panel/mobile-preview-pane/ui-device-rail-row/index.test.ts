import { describe, expect, it } from 'vitest';

import type { MobilePreviewDevice } from '@shared/mobile-simulator-types';

import { getDeviceMetaLabel } from './index';

const simulator: MobilePreviewDevice = {
  id: 'sim-1',
  name: 'iPhone 16',
  platform: 'ios',
  state: 'shutdown',
  osVersion: '18.0',
};

const physical: MobilePreviewDevice = {
  id: 'phone-1',
  name: "Patrick's iPhone",
  platform: 'ios',
  state: 'booted',
  kind: 'physical',
  connection: 'connected',
  model: 'iPhone 14 Pro',
  osVersion: '18.1',
};

describe('getDeviceMetaLabel', () => {
  it('keeps simulator labels unchanged', () => {
    expect(getDeviceMetaLabel(simulator, false)).toBe('18.0');
    expect(
      getDeviceMetaLabel({ ...simulator, osVersion: undefined }, false),
    ).toBe('Shutdown');
  });

  it('shows model and os version for a connected physical device', () => {
    expect(getDeviceMetaLabel(physical, true)).toBe('iPhone 14 Pro · 18.1');
  });

  it('does not repeat a model already present in the device name', () => {
    expect(
      getDeviceMetaLabel({ ...physical, name: 'iPhone 14 Pro' }, true),
    ).toBe('18.1');
  });

  it('states the connection in words when the device is not usable', () => {
    expect(
      getDeviceMetaLabel({ ...physical, connection: 'unauthorized' }, true),
    ).toBe('iPhone 14 Pro · Unauthorized');
    expect(
      getDeviceMetaLabel({ ...physical, connection: 'untrusted' }, true),
    ).toBe('iPhone 14 Pro · Untrusted');
    expect(
      getDeviceMetaLabel({ ...physical, connection: 'unavailable' }, true),
    ).toBe('iPhone 14 Pro · Not connected');
  });

  it('shows the state alone when the model adds nothing', () => {
    expect(
      getDeviceMetaLabel(
        { ...physical, name: 'iPhone 14 Pro', connection: 'unavailable' },
        true,
      ),
    ).toBe('Not connected');
    expect(
      getDeviceMetaLabel(
        { ...physical, model: undefined, connection: 'unavailable' },
        true,
      ),
    ).toBe('Not connected');
  });
});
