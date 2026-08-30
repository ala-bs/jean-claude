import { describe, expect, it } from 'vitest';

import type { MobilePreviewDevice } from '@shared/mobile-simulator-types';

import {
  canStartDevice,
  formatDeviceConnectionState,
  formatDeviceState,
  sortPhysicalDevicesByAvailability,
} from './utils-device-setup';

const simulator: MobilePreviewDevice = {
  id: 'sim-1',
  name: 'iPhone 16',
  platform: 'ios',
  state: 'shutdown',
};

const physical: MobilePreviewDevice = {
  id: 'phone-1',
  name: "Patrick's iPhone",
  platform: 'ios',
  state: 'booted',
  kind: 'physical',
  connection: 'connected',
};

describe('formatDeviceState', () => {
  it('maps every device state to a label', () => {
    expect(formatDeviceState('booted')).toBe('Booted');
    expect(formatDeviceState('shutdown')).toBe('Shutdown');
    expect(formatDeviceState('unknown')).toBe('Unknown');
  });
});

describe('canStartDevice', () => {
  it('keeps simulator behaviour unchanged', () => {
    expect(canStartDevice(simulator)).toBe(true);
    expect(canStartDevice({ ...simulator, state: 'booted' })).toBe(true);
    expect(canStartDevice({ ...simulator, state: 'unknown' })).toBe(false);
    expect(canStartDevice(undefined)).toBe(false);
  });

  it('allows a connected physical device', () => {
    expect(canStartDevice(physical)).toBe(true);
  });

  it.each(['unauthorized', 'untrusted', 'unavailable'] as const)(
    'blocks a %s physical device',
    (connection) => {
      expect(canStartDevice({ ...physical, connection })).toBe(false);
    },
  );

  it('blocks a physical device with no reported connection', () => {
    expect(canStartDevice({ ...physical, connection: undefined })).toBe(false);
  });
});

describe('formatDeviceConnectionState', () => {
  it('returns nothing for simulators or reachable hardware', () => {
    expect(formatDeviceConnectionState(simulator)).toBeNull();
    expect(formatDeviceConnectionState(physical)).toBeNull();
    expect(formatDeviceConnectionState(undefined)).toBeNull();
    expect(
      formatDeviceConnectionState({ ...simulator, connection: 'unauthorized' }),
    ).toBeNull();
  });

  it('names each unusable physical connection state', () => {
    expect(
      formatDeviceConnectionState({ ...physical, connection: 'unauthorized' }),
    ).toBe('Unauthorized');
    expect(
      formatDeviceConnectionState({ ...physical, connection: 'untrusted' }),
    ).toBe('Untrusted');
    expect(
      formatDeviceConnectionState({ ...physical, connection: 'unavailable' }),
    ).toBe('Not connected');
  });
});

describe('sortPhysicalDevicesByAvailability', () => {
  const make = (
    id: string,
    connection: MobilePreviewDevice['connection'],
  ): MobilePreviewDevice => ({ ...physical, id, name: id, connection });

  it('floats usable devices to the top', () => {
    const sorted = sortPhysicalDevicesByAvailability([
      make('a', 'unavailable'),
      make('b', 'unauthorized'),
      make('c', 'connected'),
    ]);
    expect(sorted.map((device) => device.id)).toEqual(['c', 'a', 'b']);
  });

  it('is stable within each bucket', () => {
    const sorted = sortPhysicalDevicesByAvailability([
      make('a', 'unavailable'),
      make('b', 'connected'),
      make('c', 'untrusted'),
      make('d', 'connected'),
      make('e', 'unauthorized'),
    ]);
    expect(sorted.map((device) => device.id)).toEqual([
      'b',
      'd',
      'a',
      'c',
      'e',
    ]);
  });

  it('keeps every unreachable device listed', () => {
    const devices = [make('a', 'unavailable'), make('b', 'unavailable')];
    expect(sortPhysicalDevicesByAvailability(devices)).toHaveLength(2);
  });
});
