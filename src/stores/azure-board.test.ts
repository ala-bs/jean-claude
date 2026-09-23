import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_AZURE_BOARD_FILTERS,
  EMPTY_AZURE_BOARD_COLUMN_IDS,
  getAzureBoardFilters,
  migrateAzureBoardState,
  useAzureBoardStore,
  workItemWorkspaceScopeKey,
} from './azure-board';

const boardA = workItemWorkspaceScopeKey({
  surface: 'board',
  projectId: 'project-a',
});
const boardB = workItemWorkspaceScopeKey({
  surface: 'board',
  projectId: 'project-b',
});
const newTaskA = workItemWorkspaceScopeKey({
  surface: 'new-task',
  projectId: 'project-a',
});

describe('azure board store', () => {
  beforeEach(() => {
    useAzureBoardStore.setState({
      selectedProjectId: null,
      filtersByScope: {},
      panelWidthByScope: {},
      viewModeByScope: {},
      collapsedColumnIdsByScope: {},
    });
  });

  it('keeps filters isolated by scope and remembers selection', () => {
    const state = useAzureBoardStore.getState();
    state.setSelectedProjectId('project-a');
    state.setFilters(boardA, {
      search: 'login',
      assignees: ['Patrick Lin'],
      tags: ['Frontend'],
    });
    state.setFilters(boardB, { workItemTypes: ['Bug', 'User Story'] });

    expect(useAzureBoardStore.getState().selectedProjectId).toBe('project-a');
    expect(getAzureBoardFilters(boardA)).toEqual({
      search: 'login',
      workItemTypes: [],
      assignees: ['Patrick Lin'],
      iterations: [],
      tags: ['Frontend'],
    });
    expect(getAzureBoardFilters(boardB)).toEqual({
      search: '',
      workItemTypes: ['Bug', 'User Story'],
      assignees: [],
      iterations: [],
      tags: [],
    });
  });

  it('keeps the same project isolated across surfaces', () => {
    const state = useAzureBoardStore.getState();
    state.setFilters(boardA, { tags: ['Frontend'] });
    state.setFilters(newTaskA, { tags: ['Backend'] });

    expect(getAzureBoardFilters(boardA).tags).toEqual(['Frontend']);
    expect(getAzureBoardFilters(newTaskA).tags).toEqual(['Backend']);
  });

  it('provides stable defaults without storing missing scope state', () => {
    expect(getAzureBoardFilters('missing')).toBe(DEFAULT_AZURE_BOARD_FILTERS);
    expect(getAzureBoardFilters('missing')).toBe(getAzureBoardFilters('missing'));
    expect(EMPTY_AZURE_BOARD_COLUMN_IDS).toHaveLength(0);
    expect(useAzureBoardStore.getState().filtersByScope).toEqual({});
    expect(useAzureBoardStore.getState().collapsedColumnIdsByScope).toEqual({});
  });

  it('returns the stored scope filter slice without copying it', () => {
    useAzureBoardStore.getState().setFilters(boardA, { search: 'login' });

    expect(getAzureBoardFilters(boardA)).toBe(
      useAzureBoardStore.getState().filtersByScope[boardA],
    );
  });

  it('persists the split width and view mode per scope', () => {
    const state = useAzureBoardStore.getState();
    state.setPanelWidth(boardA, 58);
    state.setPanelWidth(newTaskA, 42);
    state.setViewMode(newTaskA, 'list');

    expect(useAzureBoardStore.getState().panelWidthByScope).toEqual({
      [boardA]: 58,
      [newTaskA]: 42,
    });
    expect(useAzureBoardStore.getState().viewModeByScope[newTaskA]).toBe('list');
    expect(
      useAzureBoardStore.getState().viewModeByScope[boardA],
    ).toBeUndefined();
  });

  it('toggles collapsed columns independently per scope', () => {
    const store = useAzureBoardStore.getState();
    store.toggleCollapsedColumn(boardA, 'column-active');
    store.toggleCollapsedColumn(boardB, 'column-done');
    expect(useAzureBoardStore.getState().collapsedColumnIdsByScope).toEqual({
      [boardA]: ['column-active'],
      [boardB]: ['column-done'],
    });

    useAzureBoardStore
      .getState()
      .toggleCollapsedColumn(boardA, 'column-active');
    expect(
      useAzureBoardStore.getState().collapsedColumnIdsByScope[boardA],
    ).toEqual([]);
  });

  it('migrates scalar filters from older versions onto the board scope', () => {
    const migrated = migrateAzureBoardState({
      filtersByProject: {
        'project-a': {
          assignee: 'Patrick Lin',
          iterationPath: 'Project\\Sprint 9',
          workItemType: 'Bug',
        },
      },
    });

    expect(migrated.filtersByScope[boardA].assignees).toEqual(['Patrick Lin']);
    expect(migrated.filtersByScope[boardA].iterations).toEqual([
      'Project\\Sprint 9',
    ]);
    expect(migrated.filtersByScope[boardA].workItemTypes).toEqual(['Bug']);
  });

  it('migrates per-project collapsed columns and the shared panel width', () => {
    const migrated = migrateAzureBoardState({
      filtersByProject: { 'project-a': {} },
      collapsedColumnIdsByProject: { 'project-a': ['column-done'] },
      panelWidth: 58,
    });

    expect(migrated.collapsedColumnIdsByScope[boardA]).toEqual(['column-done']);
    expect(migrated.panelWidthByScope[boardA]).toBe(58);
    expect(migrated.viewModeByScope).toEqual({});
  });

  // The width used to be one global number, so it has to survive even when the
  // user never touched a filter — dragging the splitter is its own gesture.
  it('keeps the legacy panel width for a user who only resized the board', () => {
    const migrated = migrateAzureBoardState({
      selectedProjectId: 'project-a',
      filtersByProject: {},
      panelWidth: 58,
    });

    expect(migrated.panelWidthByScope[boardA]).toBe(58);
  });

  it('keeps the legacy panel width when only collapsed columns were stored', () => {
    const migrated = migrateAzureBoardState({
      collapsedColumnIdsByProject: { 'project-b': ['column-done'] },
      panelWidth: 42,
    });

    expect(migrated.panelWidthByScope[boardB]).toBe(42);
  });

  it('leaves widths untouched when no legacy width was persisted', () => {
    const migrated = migrateAzureBoardState({
      selectedProjectId: 'project-a',
      filtersByProject: { 'project-a': {} },
    });

    expect(migrated.panelWidthByScope).toEqual({});
  });

  it('defaults showPriority off for state persisted before v6', () => {
    const migrated = migrateAzureBoardState({ filtersByProject: {} });
    expect(migrated.colorSettings.showPriority).toBe(false);

    const kept = migrateAzureBoardState({
      colorSettings: { showPriority: true },
    });
    expect(kept.colorSettings.showPriority).toBe(true);
  });

  it('migrates empty and existing multi-value type filters', () => {
    const migrated = migrateAzureBoardState({
      filtersByProject: {
        empty: { workItemType: '' },
        current: { workItemTypes: ['Feature', 'User Story'] },
      },
    });

    expect(
      migrated.filtersByScope[
        workItemWorkspaceScopeKey({ surface: 'board', projectId: 'empty' })
      ].workItemTypes,
    ).toEqual([]);
    expect(
      migrated.filtersByScope[
        workItemWorkspaceScopeKey({ surface: 'board', projectId: 'current' })
      ].workItemTypes,
    ).toEqual(['Feature', 'User Story']);
  });
});
