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

describe('work item picker filters store', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('localStorage', createLocalStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps iteration filters isolated per project', async () => {
    const { useWorkItemPickerFiltersStore } = await import(
      './work-item-picker-filters'
    );

    useWorkItemPickerFiltersStore
      .getState()
      .setIterationFilter('project-1', 'Project\\Iteration 1');
    useWorkItemPickerFiltersStore
      .getState()
      .setIterationFilter('project-2', '__all__');

    expect(
      useWorkItemPickerFiltersStore.getState().iterationFilterByProject,
    ).toEqual({
      'project-1': 'Project\\Iteration 1',
      'project-2': '__all__',
    });
  });

  it('persists the selection to localStorage', async () => {
    const { useWorkItemPickerFiltersStore } = await import(
      './work-item-picker-filters'
    );

    useWorkItemPickerFiltersStore
      .getState()
      .setIterationFilter('project-1', 'Project\\Iteration 1');

    const raw = localStorage.getItem('work-item-picker-filters');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).state.iterationFilterByProject).toEqual({
      'project-1': 'Project\\Iteration 1',
    });
  });

  it('clears a project entry', async () => {
    const { useWorkItemPickerFiltersStore } = await import(
      './work-item-picker-filters'
    );

    useWorkItemPickerFiltersStore
      .getState()
      .setIterationFilter('project-1', '__all__');
    useWorkItemPickerFiltersStore.getState().clearProject('project-1');

    expect(
      useWorkItemPickerFiltersStore.getState().iterationFilterByProject,
    ).toEqual({});
  });
});
