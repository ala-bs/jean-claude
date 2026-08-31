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

  it('keeps PR draft images when only the text changes', async () => {
    const { useNavigationStore } = await import('./navigation');
    const store = () => useNavigationStore.getState();

    store().setPrDraft('task-1', {
      images: [
        {
          token: '1',
          filePath: '/wt/.jean-claude/tmp/a.png',
          filename: 'a.png',
          mimeType: 'image/png',
        },
      ],
    });

    // The editor persists title/description on every keystroke; a replacing
    // setter would drop the image refs each time.
    store().setPrDraft('task-1', { title: 'My PR' });
    store().setPrDraft('task-1', { description: 'Body' });

    const draft = store().taskState['task-1']?.prDraft;
    expect(draft?.title).toBe('My PR');
    expect(draft?.description).toBe('Body');
    expect(draft?.images).toHaveLength(1);
  });

  it('unsets the PR draft once every field is emptied', async () => {
    const { useNavigationStore } = await import('./navigation');
    const store = () => useNavigationStore.getState();

    store().setPrDraft('task-2', { title: 'Temp' });
    store().setPrDraft('task-2', { title: '' });

    expect(store().taskState['task-2']?.prDraft).toBeUndefined();
  });

  it('clears the whole PR draft, images included', async () => {
    const { useNavigationStore } = await import('./navigation');
    const store = () => useNavigationStore.getState();

    store().setPrDraft('task-3', {
      title: 'My PR',
      images: [
        {
          token: '1',
          filePath: '/wt/.jean-claude/tmp/a.png',
          filename: 'a.png',
          mimeType: 'image/png',
        },
      ],
    });
    store().clearPrDraft('task-3');

    expect(store().taskState['task-3']?.prDraft).toBeUndefined();
  });

  it('leaves the workspace overview when a step is explicitly selected', async () => {
    const { useNavigationStore } = await import('./navigation');

    useNavigationStore.getState().setShowWorkspaceOverview('task-1', true);
    expect(
      useNavigationStore.getState().taskState['task-1']?.showWorkspaceOverview,
    ).toBe(true);

    useNavigationStore.getState().setActiveStepId('task-1', 'step-1');

    expect(
      useNavigationStore.getState().taskState['task-1']?.showWorkspaceOverview,
    ).toBe(false);
    expect(useNavigationStore.getState().taskState['task-1']?.activeStepId).toBe(
      'step-1',
    );
  });

  it('keeps the overview open when a dangling selection is repaired', async () => {
    const { useNavigationStore } = await import('./navigation');

    useNavigationStore.getState().setShowWorkspaceOverview('task-1', true);
    useNavigationStore
      .getState()
      .setActiveStepId('task-1', 'step-2', { keepWorkspaceOverview: true });

    expect(
      useNavigationStore.getState().taskState['task-1']?.showWorkspaceOverview,
    ).toBe(true);
    expect(useNavigationStore.getState().taskState['task-1']?.activeStepId).toBe(
      'step-2',
    );
  });

  it('does not persist the workspace overview flag', async () => {
    const { useNavigationStore } = await import('./navigation');

    useNavigationStore.getState().setShowWorkspaceOverview('task-1', true);

    expect(localStorage.getItem('navigation')).not.toContain(
      'showWorkspaceOverview',
    );
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
