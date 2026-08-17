import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_AZURE_BOARD_FILTERS,
  EMPTY_AZURE_BOARD_COLUMN_IDS,
  getAzureBoardFilters,
  migrateAzureBoardState,
  useAzureBoardStore,
} from './azure-board';

describe('azure board store', () => {
  beforeEach(() => {
    useAzureBoardStore.setState({
      selectedProjectId: null,
      filtersByProject: {},
      panelWidth: 65,
      collapsedColumnIdsByProject: {},
    });
  });

  it('keeps filters isolated by project and remembers selection', () => {
    const state = useAzureBoardStore.getState();
    state.setSelectedProjectId('project-a');
    state.setFilters('project-a', {
      search: 'login',
      assignees: ['Patrick Lin'],
      tags: ['Frontend'],
    });
    state.setFilters('project-b', { workItemTypes: ['Bug', 'User Story'] });

    expect(useAzureBoardStore.getState().selectedProjectId).toBe('project-a');
    expect(getAzureBoardFilters('project-a')).toEqual({
      search: 'login',
      workItemTypes: [],
      assignees: ['Patrick Lin'],
      iterations: [],
      tags: ['Frontend'],
    });
    expect(getAzureBoardFilters('project-b')).toEqual({
      search: '',
      workItemTypes: ['Bug', 'User Story'],
      assignees: [],
      iterations: [],
      tags: [],
    });
  });

  it('provides stable defaults without storing missing project state', () => {
    expect(getAzureBoardFilters('missing')).toBe(DEFAULT_AZURE_BOARD_FILTERS);
    expect(getAzureBoardFilters('missing')).toBe(getAzureBoardFilters('missing'));
    expect(EMPTY_AZURE_BOARD_COLUMN_IDS).toHaveLength(0);
    expect(useAzureBoardStore.getState().filtersByProject).toEqual({});
    expect(useAzureBoardStore.getState().collapsedColumnIdsByProject).toEqual({});
  });

  it('returns the stored project filter slice without copying it', () => {
    useAzureBoardStore.getState().setFilters('project-a', { search: 'login' });

    expect(getAzureBoardFilters('project-a')).toBe(
      useAzureBoardStore.getState().filtersByProject['project-a'],
    );
  });

  it('persists the board split width', () => {
    useAzureBoardStore.getState().setPanelWidth(58);
    expect(useAzureBoardStore.getState().panelWidth).toBe(58);
  });

  it('toggles collapsed columns independently per project', () => {
    const store = useAzureBoardStore.getState();
    store.toggleCollapsedColumn('project-a', 'column-active');
    store.toggleCollapsedColumn('project-b', 'column-done');
    expect(useAzureBoardStore.getState().collapsedColumnIdsByProject).toEqual({
      'project-a': ['column-active'],
      'project-b': ['column-done'],
    });

    useAzureBoardStore
      .getState()
      .toggleCollapsedColumn('project-a', 'column-active');
    expect(
      useAzureBoardStore.getState().collapsedColumnIdsByProject['project-a'],
    ).toEqual([]);
  });

  it('migrates scalar filters from older versions', () => {
    const migrated = migrateAzureBoardState({
      filtersByProject: {
        project: {
          assignee: 'Patrick Lin',
          iterationPath: 'Project\\Sprint 9',
          workItemType: 'Bug',
        },
      },
    });

    expect(migrated.filtersByProject.project.assignees).toEqual(['Patrick Lin']);
    expect(migrated.filtersByProject.project.iterations).toEqual([
      'Project\\Sprint 9',
    ]);
    expect(migrated.filtersByProject.project.workItemTypes).toEqual(['Bug']);
  });

  it('migrates empty and existing multi-value type filters', () => {
    const migrated = migrateAzureBoardState({
      filtersByProject: {
        empty: { workItemType: '' },
        current: { workItemTypes: ['Feature', 'User Story'] },
      },
    });

    expect(migrated.filtersByProject.empty.workItemTypes).toEqual([]);
    expect(migrated.filtersByProject.current.workItemTypes).toEqual([
      'Feature',
      'User Story',
    ]);
  });
});
