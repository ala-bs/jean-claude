import { beforeEach, describe, expect, it } from 'vitest';

import {
  mergePersistedMobileDevPaneState,
  migrateMobileDevPaneState,
  setMobileDevPaneSelectedLogTab,
  useMobileDevPaneStore,
} from './mobile-dev-pane';

function resetStore() {
  useMobileDevPaneStore.setState({
    deviceByTaskId: {},
    selectedLogTabByTaskId: {},
    favoriteDevices: {},
  });
}

describe('mobile dev pane store', () => {
  beforeEach(resetStore);

  it('keeps device selection per task', () => {
    const { selectDevice } = useMobileDevPaneStore.getState();
    selectDevice('task-a', {
      platform: 'ios',
      deviceId: 'sim-1',
      deviceName: 'iPhone 16',
    });
    selectDevice('task-b', {
      platform: 'android',
      deviceId: 'emulator-5554',
      deviceName: 'Pixel 8',
    });

    const { deviceByTaskId } = useMobileDevPaneStore.getState();
    expect(deviceByTaskId['task-a']?.deviceId).toBe('sim-1');
    expect(deviceByTaskId['task-b']?.platform).toBe('android');
  });

  it('clears a task selection when passed null', () => {
    const { selectDevice } = useMobileDevPaneStore.getState();
    selectDevice('task-a', {
      platform: 'ios',
      deviceId: 'sim-1',
      deviceName: 'iPhone 16',
    });
    selectDevice('task-a', null);
    expect(useMobileDevPaneStore.getState().deviceByTaskId['task-a']).toBeUndefined();
  });

  it('caps stored tasks and evicts the least recently selected', () => {
    const { selectDevice } = useMobileDevPaneStore.getState();
    for (let index = 0; index < 120; index += 1) {
      selectDevice(`task-${index}`, {
        platform: 'ios',
        deviceId: `sim-${index}`,
        deviceName: `Device ${index}`,
      });
    }

    const { deviceByTaskId } = useMobileDevPaneStore.getState();
    expect(Object.keys(deviceByTaskId)).toHaveLength(100);
    expect(deviceByTaskId['task-0']).toBeUndefined();
    expect(deviceByTaskId['task-119']?.deviceId).toBe('sim-119');
  });

  it('re-selecting an old task keeps it from being evicted', () => {
    const { selectDevice } = useMobileDevPaneStore.getState();
    selectDevice('task-old', {
      platform: 'ios',
      deviceId: 'sim-old',
      deviceName: 'Old',
    });
    for (let index = 0; index < 99; index += 1) {
      selectDevice(`task-${index}`, {
        platform: 'ios',
        deviceId: `sim-${index}`,
        deviceName: `Device ${index}`,
      });
    }
    // Touch the oldest entry, then overflow the cap by one.
    selectDevice('task-old', {
      platform: 'ios',
      deviceId: 'sim-old',
      deviceName: 'Old',
    });
    selectDevice('task-new', {
      platform: 'ios',
      deviceId: 'sim-new',
      deviceName: 'New',
    });

    const { deviceByTaskId } = useMobileDevPaneStore.getState();
    expect(deviceByTaskId['task-old']?.deviceId).toBe('sim-old');
    expect(deviceByTaskId['task-0']).toBeUndefined();
  });

  it('tracks the selected log tab per task and clears both records', () => {
    const { setSelectedLogTab, selectDevice, clearTask } =
      useMobileDevPaneStore.getState();
    selectDevice('task-a', {
      platform: 'ios',
      deviceId: 'sim-1',
      deviceName: 'iPhone 16',
    });
    setSelectedLogTab('task-a', 'run-metro');
    setSelectedLogTab('task-b', 'run-ios');
    expect(
      useMobileDevPaneStore.getState().selectedLogTabByTaskId['task-a'],
    ).toBe('run-metro');

    clearTask('task-a');
    const state = useMobileDevPaneStore.getState();
    expect(state.selectedLogTabByTaskId['task-a']).toBeUndefined();
    expect(state.deviceByTaskId['task-a']).toBeUndefined();
    expect(state.selectedLogTabByTaskId['task-b']).toBe('run-ios');
  });

  it('caps stored log tabs and keeps the most recently selected task', () => {
    const { setSelectedLogTab } = useMobileDevPaneStore.getState();
    setSelectedLogTab('task-old', 'run-old');
    for (let index = 0; index < 99; index += 1) {
      setSelectedLogTab(`task-${index}`, `run-${index}`);
    }
    // Touch the oldest entry, then overflow the cap by one.
    setSelectedLogTab('task-old', 'run-old');
    setSelectedLogTab('task-new', 'run-new');

    const { selectedLogTabByTaskId } = useMobileDevPaneStore.getState();
    expect(Object.keys(selectedLogTabByTaskId)).toHaveLength(100);
    expect(selectedLogTabByTaskId['task-old']).toBe('run-old');
    expect(selectedLogTabByTaskId['task-0']).toBeUndefined();
  });

  it('sets the log tab imperatively outside React', () => {
    setMobileDevPaneSelectedLogTab({ taskId: 'task-a', commandId: 'run-metro' });
    expect(
      useMobileDevPaneStore.getState().selectedLogTabByTaskId['task-a'],
    ).toBe('run-metro');
  });
});

describe('mobile dev pane persisted-state migration', () => {
  it('drops the v1 logs-expanded record and seeds the log tabs', () => {
    const migrated = migrateMobileDevPaneState(
      {
        deviceByTaskId: {
          'task-a': {
            platform: 'ios',
            deviceId: 'sim-1',
            deviceName: 'iPhone 16',
          },
        },
        logsExpandedByTaskId: { 'task-a': false },
        favoriteDevices: {},
      },
      1,
    ) as Record<string, unknown>;

    expect(migrated.logsExpandedByTaskId).toBeUndefined();
    expect(migrated.selectedLogTabByTaskId).toEqual({});
    expect(Object.keys(migrated.deviceByTaskId as object)).toEqual(['task-a']);
  });

  it('leaves a v2 payload untouched', () => {
    const payload = { selectedLogTabByTaskId: { 'task-a': 'run-metro' } };
    expect(migrateMobileDevPaneState(payload, 2)).toBe(payload);
  });
});

describe('mobile dev pane persisted-state sanitizing', () => {
  // Read live rather than at collection time: if a fallback-to-`current`
  // branch is ever added to the merge, a captured snapshot would make these
  // tests order-dependent.
  const current = () => useMobileDevPaneStore.getState();

  it('drops entries that are not valid device selections', () => {
    const merged = mergePersistedMobileDevPaneState(
      {
        deviceByTaskId: {
          good: { platform: 'ios', deviceId: 'sim-1', deviceName: 'iPhone' },
          badPlatform: { platform: 'web', deviceId: 'x', deviceName: 'x' },
          emptyId: { platform: 'ios', deviceId: '', deviceName: 'x' },
          missingName: { platform: 'ios', deviceId: 'sim-2' },
          notAnObject: 'nope',
        },
        selectedLogTabByTaskId: { a: 'run-metro', b: '', c: 1, d: null },
      },
      current(),
    );

    expect(Object.keys(merged.deviceByTaskId)).toEqual(['good']);
    expect(merged.selectedLogTabByTaskId).toEqual({ a: 'run-metro' });
  });

  it('survives a corrupt or absent payload', () => {
    expect(mergePersistedMobileDevPaneState(undefined, current()).deviceByTaskId).toEqual({});
    expect(mergePersistedMobileDevPaneState('garbage', current()).deviceByTaskId).toEqual({});
    expect(
      mergePersistedMobileDevPaneState({ deviceByTaskId: 42 }, current()).deviceByTaskId,
    ).toEqual({});
  });
});

describe('mobile dev pane favorites', () => {
  beforeEach(() => {
    useMobileDevPaneStore.setState({ favoriteDevices: {} });
  });

  const IPHONE = {
    platform: 'ios' as const,
    deviceId: 'sim-1',
    deviceName: 'iPhone 16',
  };
  const PIXEL = {
    platform: 'android' as const,
    deviceId: 'Pixel_8',
    deviceName: 'Pixel 8',
  };

  it('toggles a device on and back off', () => {
    const { toggleFavoriteDevice } = useMobileDevPaneStore.getState();

    toggleFavoriteDevice(IPHONE);
    expect(useMobileDevPaneStore.getState().favoriteDevices).toEqual({
      'ios:sim-1': IPHONE,
    });

    toggleFavoriteDevice(IPHONE);
    expect(useMobileDevPaneStore.getState().favoriteDevices).toEqual({});
  });

  it('keys by platform so the same id can be starred on both', () => {
    const { toggleFavoriteDevice } = useMobileDevPaneStore.getState();
    toggleFavoriteDevice(IPHONE);
    toggleFavoriteDevice({ ...IPHONE, platform: 'android' });

    expect(Object.keys(useMobileDevPaneStore.getState().favoriteDevices)).toEqual(
      ['ios:sim-1', 'android:sim-1'],
    );
  });

  it('is global rather than per task', () => {
    const { toggleFavoriteDevice, clearTask, selectDevice, setSelectedLogTab } =
      useMobileDevPaneStore.getState();
    // Populate the task first: clearing an empty task would pass even if
    // clearTask wiped favorites.
    selectDevice('task-a', IPHONE);
    setSelectedLogTab('task-a', 'run-metro');
    toggleFavoriteDevice(PIXEL);

    clearTask('task-a');

    const state = useMobileDevPaneStore.getState();
    expect(state.deviceByTaskId['task-a']).toBeUndefined();
    expect(state.selectedLogTabByTaskId['task-a']).toBeUndefined();
    expect(state.favoriteDevices).toEqual({ 'android:Pixel_8': PIXEL });
  });

  it('caps favorites and evicts the oldest', () => {
    const { toggleFavoriteDevice } = useMobileDevPaneStore.getState();
    for (let index = 0; index < 51; index += 1) {
      toggleFavoriteDevice({
        platform: 'ios',
        deviceId: `sim-${index}`,
        deviceName: `Device ${index}`,
      });
    }

    const { favoriteDevices } = useMobileDevPaneStore.getState();
    expect(Object.keys(favoriteDevices)).toHaveLength(50);
    expect(favoriteDevices['ios:sim-0']).toBeUndefined();
    expect(favoriteDevices['ios:sim-50']).toBeDefined();
  });

  it('drops persisted favorites whose key does not match their payload', () => {
    // A hand-edited or migrated key would otherwise yield a favorite that can
    // never match a device lookup.
    const merged = mergePersistedMobileDevPaneState(
      {
        favoriteDevices: {
          'ios:sim-1': IPHONE,
          'ios:wrong-id': IPHONE,
          'android:sim-1': IPHONE,
        },
      },
      useMobileDevPaneStore.getState(),
    );

    expect(Object.keys(merged.favoriteDevices)).toEqual(['ios:sim-1']);
  });

  it('defaults favorites to empty for a payload written before the feature', () => {
    const merged = mergePersistedMobileDevPaneState(
      { deviceByTaskId: {}, selectedLogTabByTaskId: {} },
      useMobileDevPaneStore.getState(),
    );
    expect(merged.favoriteDevices).toEqual({});
  });
});
