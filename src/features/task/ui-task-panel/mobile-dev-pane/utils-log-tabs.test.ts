import { describe, expect, it } from 'vitest';

import { describeWellKnownCommandId } from '../command-logs-pane/command-log-tabs';
import { buildMobileDevVirtualTabs } from './utils-log-tabs';

const BASE = {
  projectId: 'project-1',
  devServerCommandId: 'mobile-dev-server:.',
};

const IOS_BUILD = 'mobile-build:.:ios:IOS-1';
const IOS_BUILD_2 = 'mobile-build:.:ios:IOS-2';
const ANDROID_BUILD = 'mobile-build:.:android:AND-1';
const NO_DEVICE_BUILD = 'mobile-build:.:ios:no-device';

const DEVICES = [
  { platform: 'ios' as const, id: 'IOS-1', name: 'iPhone 15' },
  { platform: 'ios' as const, id: 'IOS-2', name: 'iPhone 16 Pro' },
  { platform: 'android' as const, id: 'AND-1', name: 'Pixel 8' },
];

describe('buildMobileDevVirtualTabs', () => {
  it('emits Metro alone when no device is selected', () => {
    const tabs = buildMobileDevVirtualTabs({
      ...BASE,
      buildCommandId: null,
      stickyBuildCommandId: null,
      activeDevice: null,
    });

    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      id: BASE.devServerCommandId,
      name: 'Metro',
      sortOrder: -2,
    });
  });

  it('names the build tab after the selected device, after Metro', () => {
    const tabs = buildMobileDevVirtualTabs({
      ...BASE,
      buildCommandId: ANDROID_BUILD,
      stickyBuildCommandId: null,
      activeDevice: { platform: 'android' },
      devices: DEVICES,
    });

    expect(tabs.map((tab) => [tab.id, tab.name])).toEqual([
      [BASE.devServerCommandId, 'Metro'],
      [ANDROID_BUILD, 'Android build · Pixel 8'],
    ]);
    expect(tabs[1].sortOrder).toBe(-1);
  });

  it('falls back to the device id when the device list is unavailable', () => {
    const tabs = buildMobileDevVirtualTabs({
      ...BASE,
      buildCommandId: ANDROID_BUILD,
      stickyBuildCommandId: null,
      activeDevice: { platform: 'android' },
    });

    expect(tabs[1].name).toBe('Android build · AND-1');
  });

  it('keeps a build with no device reading plainly', () => {
    const tabs = buildMobileDevVirtualTabs({
      ...BASE,
      buildCommandId: NO_DEVICE_BUILD,
      stickyBuildCommandId: null,
      activeDevice: { platform: 'ios' },
      devices: DEVICES,
    });

    expect(tabs[1].name).toBe('iOS build');
    expect(describeWellKnownCommandId(NO_DEVICE_BUILD)).toBe('iOS build');
  });

  it('distinguishes two builds on different devices of the same platform', () => {
    const tabs = buildMobileDevVirtualTabs({
      ...BASE,
      buildCommandId: IOS_BUILD_2,
      stickyBuildCommandId: IOS_BUILD,
      activeDevice: { platform: 'ios' },
      devices: DEVICES,
    });

    expect(tabs.map((tab) => [tab.id, tab.name])).toEqual([
      [BASE.devServerCommandId, 'Metro'],
      [IOS_BUILD_2, 'iOS build · iPhone 16 Pro'],
      [IOS_BUILD, 'iOS build · iPhone 15'],
    ]);
    expect(tabs[1].name).not.toBe(tabs[2].name);
  });

  it('appends the device id when two devices share a name', () => {
    const duplicates = [
      { platform: 'ios' as const, id: 'IOS-1', name: 'iPhone 15' },
      { platform: 'ios' as const, id: 'IOS-2', name: 'iPhone 15' },
    ];
    const tabs = buildMobileDevVirtualTabs({
      ...BASE,
      buildCommandId: IOS_BUILD_2,
      stickyBuildCommandId: IOS_BUILD,
      activeDevice: { platform: 'ios' },
      devices: duplicates,
    });

    expect(tabs[1].name).toBe('iOS build · iPhone 15 (IOS-2)');
    expect(tabs[2].name).toBe('iOS build · iPhone 15 (IOS-1)');
  });

  it('keeps the sticky build tab after the device selection moves on', () => {
    const tabs = buildMobileDevVirtualTabs({
      ...BASE,
      buildCommandId: ANDROID_BUILD,
      stickyBuildCommandId: IOS_BUILD,
      activeDevice: { platform: 'android' },
      devices: DEVICES,
    });

    expect(tabs.map((tab) => [tab.id, tab.name])).toEqual([
      [BASE.devServerCommandId, 'Metro'],
      [ANDROID_BUILD, 'Android build · Pixel 8'],
      // Named from its own command id, since it is no longer the selection.
      [IOS_BUILD, 'iOS build · iPhone 15'],
    ]);
  });

  // The two naming sites deliberately differ: only the pane has the device
  // list, so a build that falls through to a historical tab keeps its device --
  // as an id rather than a name -- and stays unique either way.
  it('agrees with the historical naming up to the device label', () => {
    const [, virtualTab] = buildMobileDevVirtualTabs({
      ...BASE,
      buildCommandId: IOS_BUILD,
      stickyBuildCommandId: null,
      activeDevice: { platform: 'ios' },
      devices: DEVICES,
    });

    expect(virtualTab.name).toBe('iOS build · iPhone 15');
    expect(describeWellKnownCommandId(IOS_BUILD)).toBe('iOS build · IOS-1');
    // Same prefix, and both unique per device.
    expect(describeWellKnownCommandId(IOS_BUILD)).not.toBe(
      describeWellKnownCommandId(IOS_BUILD_2),
    );
  });

  it('does not duplicate the tab when the sticky build is the current one', () => {
    const tabs = buildMobileDevVirtualTabs({
      ...BASE,
      buildCommandId: IOS_BUILD,
      stickyBuildCommandId: IOS_BUILD,
      activeDevice: { platform: 'ios' },
    });

    expect(tabs.map((tab) => tab.id)).toEqual([
      BASE.devServerCommandId,
      IOS_BUILD,
    ]);
  });

  it('still shows a sticky build when nothing is selected', () => {
    const tabs = buildMobileDevVirtualTabs({
      ...BASE,
      buildCommandId: null,
      stickyBuildCommandId: IOS_BUILD,
      activeDevice: null,
      devices: DEVICES,
    });

    expect(tabs.map((tab) => [tab.id, tab.name])).toEqual([
      [BASE.devServerCommandId, 'Metro'],
      [IOS_BUILD, 'iOS build · iPhone 15'],
    ]);
  });
});
