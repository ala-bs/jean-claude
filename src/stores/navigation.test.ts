import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function createLocalStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe('navigation store', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('localStorage', createLocalStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps add-step draft updates out of task state', async () => {
    const { useNavigationStore } = await import('./navigation');

    useNavigationStore.getState().setActiveStepId('task-1', 'step-1');
    const taskState = useNavigationStore.getState().taskState['task-1'];

    useNavigationStore.getState().setAddStepDraft('task-1', {
      promptTemplate: 'next step',
    });

    expect(useNavigationStore.getState().taskState['task-1']).toBe(taskState);
    expect(useNavigationStore.getState().addStepDrafts['task-1']).toEqual({
      promptTemplate: 'next step',
      presetType: 'new-session',
    });
  });

  it('defaults gesture feedback on and persists toggle changes', async () => {
    const { useNavigationStore } = await import('./navigation');

    expect(useNavigationStore.getState().mobilePreviewShowGestures).toBe(true);
    useNavigationStore.getState().setMobilePreviewShowGestures(false);

    expect(useNavigationStore.getState().mobilePreviewShowGestures).toBe(false);
    expect(localStorage.getItem('navigation')).toContain(
      '"mobilePreviewShowGestures":false',
    );
  });

  it('migrates legacy mobile task views back to message content', async () => {
    localStorage.setItem(
      'navigation',
      JSON.stringify({
        state: {
          taskState: {
            'task-active-view': {
              activeView: 'mobile',
              rightPane: null,
            },
            'task-right-pane': {
              activeView: undefined,
              rightPane: { type: 'mobilePreview' },
            },
          },
        },
        version: 0,
      }),
    );

    const { useNavigationStore } = await import('./navigation');

    expect(
      useNavigationStore.getState().taskState['task-active-view'],
    ).toMatchObject({ activeView: undefined, rightPane: null });
    expect(
      useNavigationStore.getState().taskState['task-right-pane'],
    ).toMatchObject({ activeView: undefined, rightPane: null });
  });

  it('collapses legacy per-key visible device lists into one global setting', async () => {
    localStorage.setItem(
      'navigation',
      JSON.stringify({
        state: {
          mobilePreviewVisibleDeviceIdsByKey: {
            'project-1:.': { android: null, ios: ['ios-1'] },
            'task-1:.': { android: ['android-1'], ios: null },
          },
        },
        version: 0,
      }),
    );

    const { useNavigationStore } = await import('./navigation');

    const state = useNavigationStore.getState();
    expect(state.mobilePreviewVisibleDeviceIdsByPlatform).toEqual({
      android: ['android-1'],
      ios: ['ios-1'],
    });
    expect(
      (state as { mobilePreviewVisibleDeviceIdsByKey?: unknown })
        .mobilePreviewVisibleDeviceIdsByKey,
    ).toBeUndefined();
  });

  it('shares visible device lists across tasks', async () => {
    const { useNavigationStore } = await import('./navigation');

    useNavigationStore.getState().setMobilePreviewVisibleDeviceIds({
      android: ['android-1'],
      ios: null,
    });

    expect(
      useNavigationStore.getState().mobilePreviewVisibleDeviceIdsByPlatform,
    ).toEqual({ android: ['android-1'], ios: null });
    expect(localStorage.getItem('navigation')).toContain(
      '"mobilePreviewVisibleDeviceIdsByPlatform"',
    );
  });

  it('copies legacy project app device preferences to each task without deleting legacy data', async () => {
    const { useNavigationStore } = await import('./navigation');
    const legacyKey = 'project-1:apps/mobile';
    const firstTaskKey = 'task-1:apps/mobile';
    const secondTaskKey = 'task-2:apps/mobile';
    const visibleIds = { android: ['android-1'], ios: ['ios-1'] };
    const selectedDevice = { platform: 'ios' as const, deviceId: 'ios-1' };
    const store = useNavigationStore.getState();
    store.setMobilePreviewVisibleDeviceIds(visibleIds);
    store.setMobilePreviewSelectedDevice(legacyKey, selectedDevice);

    store.migrateMobilePreviewDeviceSelection(firstTaskKey, legacyKey);
    store.migrateMobilePreviewDeviceSelection(secondTaskKey, legacyKey);

    const state = useNavigationStore.getState();
    expect(state.mobilePreviewVisibleDeviceIdsByPlatform).toEqual(visibleIds);
    expect(state.mobilePreviewSelectedDeviceByKey).toMatchObject({
      [legacyKey]: selectedDevice,
      [firstTaskKey]: selectedDevice,
      [secondTaskKey]: selectedDevice,
    });
  });

  it('does not overwrite task-scoped device preferences during migration', async () => {
    const { useNavigationStore } = await import('./navigation');
    const store = useNavigationStore.getState();
    store.setMobilePreviewSelectedDevice('project-1:.', {
      platform: 'android',
      deviceId: 'legacy',
    });
    store.setMobilePreviewVisibleDeviceIds({
      android: ['task'],
      ios: null,
    });
    store.setMobilePreviewSelectedDevice('task-1:.', null);

    store.migrateMobilePreviewDeviceSelection('task-1:.', 'project-1:.');

    const state = useNavigationStore.getState();
    expect(state.mobilePreviewVisibleDeviceIdsByPlatform.android).toEqual([
      'task',
    ]);
    expect(state.mobilePreviewSelectedDeviceByKey['task-1:.']).toBeNull();
  });
});
