import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMobilePreviewRuntimeKey } from '@/lib/mobile-preview-runtime';

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

describe('mobile preview workspace store', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('localStorage', createLocalStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens with an optional runtime and keeps the last selection without one', async () => {
    const { useMobilePreviewWorkspaceStore } = await import(
      './mobile-preview-workspace'
    );
    const runtimeKey = createMobilePreviewRuntimeKey({
      taskId: 'task-1',
      appPath: 'apps/mobile',
    });

    useMobilePreviewWorkspaceStore.getState().open(runtimeKey);
    expect(useMobilePreviewWorkspaceStore.getState()).toMatchObject({
      isOpen: true,
      selectedRuntimeKey: runtimeKey,
    });

    useMobilePreviewWorkspaceStore.getState().close();
    useMobilePreviewWorkspaceStore.getState().open();
    expect(useMobilePreviewWorkspaceStore.getState()).toMatchObject({
      isOpen: true,
      selectedRuntimeKey: runtimeKey,
    });
  });

  it('toggles and closes without clearing the selection', async () => {
    const { useMobilePreviewWorkspaceStore } = await import(
      './mobile-preview-workspace'
    );
    const runtimeKey = createMobilePreviewRuntimeKey({
      taskId: 'task-2',
      appPath: '.',
    });

    useMobilePreviewWorkspaceStore.getState().toggle(runtimeKey);
    expect(useMobilePreviewWorkspaceStore.getState().isOpen).toBe(true);
    expect(useMobilePreviewWorkspaceStore.getState().selectedRuntimeKey).toBe(
      runtimeKey,
    );

    useMobilePreviewWorkspaceStore.getState().toggle();
    expect(useMobilePreviewWorkspaceStore.getState().isOpen).toBe(false);
    expect(useMobilePreviewWorkspaceStore.getState().selectedRuntimeKey).toBe(
      runtimeKey,
    );

    useMobilePreviewWorkspaceStore.getState().open();
    useMobilePreviewWorkspaceStore.getState().close();
    expect(useMobilePreviewWorkspaceStore.getState().isOpen).toBe(false);
  });

  it('moves runtime selection only when expected source still owns selection', async () => {
    const { useMobilePreviewWorkspaceStore } = await import(
      './mobile-preview-workspace'
    );
    const oldRuntimeKey = createMobilePreviewRuntimeKey({
      taskId: 'task-1',
      appPath: 'apps/old',
    });
    const newRuntimeKey = createMobilePreviewRuntimeKey({
      taskId: 'task-1',
      appPath: 'apps/new',
    });
    const otherRuntimeKey = createMobilePreviewRuntimeKey({
      taskId: 'task-2',
      appPath: 'apps/other',
    });

    useMobilePreviewWorkspaceStore.getState().selectRuntime(oldRuntimeKey);
    useMobilePreviewWorkspaceStore
      .getState()
      .moveRuntimeSelection(oldRuntimeKey, newRuntimeKey);
    expect(
      useMobilePreviewWorkspaceStore.getState().selectedRuntimeKey,
    ).toBe(newRuntimeKey);

    useMobilePreviewWorkspaceStore.getState().selectRuntime(otherRuntimeKey);
    useMobilePreviewWorkspaceStore
      .getState()
      .moveRuntimeSelection(oldRuntimeKey, newRuntimeKey);
    expect(
      useMobilePreviewWorkspaceStore.getState().selectedRuntimeKey,
    ).toBe(otherRuntimeKey);
  });

  it('persists only the last selected runtime and starts closed after reload', async () => {
    const firstModule = await import('./mobile-preview-workspace');
    const runtimeKey = createMobilePreviewRuntimeKey({
      taskId: 'task-3',
      appPath: 'packages/app',
    });

    firstModule.useMobilePreviewWorkspaceStore.getState().open(runtimeKey);

    expect(JSON.parse(localStorage.getItem('mobile-preview-workspace') ?? '')).toEqual(
      {
        state: { selectedRuntimeKey: runtimeKey },
        version: 1,
      },
    );

    vi.resetModules();
    const secondModule = await import('./mobile-preview-workspace');
    expect(secondModule.useMobilePreviewWorkspaceStore.getState()).toMatchObject({
      isOpen: false,
      selectedRuntimeKey: runtimeKey,
    });
  });

  it('canonicalizes a parseable persisted runtime key', async () => {
    localStorage.setItem(
      'mobile-preview-workspace',
      JSON.stringify({
        state: {
          selectedRuntimeKey: 'mobile-runtime:task%2D1:apps%2fmobile',
        },
        version: 1,
      }),
    );

    const { useMobilePreviewWorkspaceStore } = await import(
      './mobile-preview-workspace'
    );

    expect(
      useMobilePreviewWorkspaceStore.getState().selectedRuntimeKey,
    ).toBe(
      createMobilePreviewRuntimeKey({
        taskId: 'task-1',
        appPath: 'apps/mobile',
      }),
    );
  });

  it.each([
    { selectedRuntimeKey: 42, isOpen: true },
    { selectedRuntimeKey: 'not-a-runtime-key', isOpen: true },
    ['unexpected'],
    null,
  ])('safely ignores malformed persisted state %#', async (state) => {
    localStorage.setItem(
      'mobile-preview-workspace',
      JSON.stringify({ state, version: 1 }),
    );

    const {
      selectMobilePreviewWorkspaceIsOpen,
      selectMobilePreviewWorkspaceRuntimeKey,
      useMobilePreviewWorkspaceStore,
    } = await import('./mobile-preview-workspace');
    const storeState = useMobilePreviewWorkspaceStore.getState();

    expect(selectMobilePreviewWorkspaceIsOpen(storeState)).toBe(false);
    expect(selectMobilePreviewWorkspaceRuntimeKey(storeState)).toBeNull();
  });
});
