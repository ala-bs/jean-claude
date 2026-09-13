import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import {
  type BoardColorSettings,
  DEFAULT_BOARD_COLOR_SETTINGS,
  sanitizeBoardColorSettings,
} from '@/features/work-item/utils-board-colors';

export type AzureBoardFilters = {
  search: string;
  workItemTypes: string[];
  assignees: string[];
  iterations: string[];
  tags: string[];
};
export const DEFAULT_AZURE_BOARD_FILTERS: AzureBoardFilters = {
  search: '',
  workItemTypes: [],
  assignees: [],
  iterations: [],
  tags: [],
};

export type WorkItemsViewMode = 'list' | 'board';

/**
 * The surfaces that embed the shared work item workspace. Filters, collapsed
 * columns, split width and view mode are persisted per surface *and* per
 * project, so narrowing the board down while picking work items for a new task
 * never rewrites what the standalone Azure Board overlay shows.
 */
export type WorkItemWorkspaceSurface = 'board' | 'new-task' | 'task-panel';

export function workItemWorkspaceScopeKey({
  surface,
  projectId,
}: {
  surface: WorkItemWorkspaceSurface;
  projectId: string;
}) {
  return `${surface}:${projectId}`;
}

export const EMPTY_AZURE_BOARD_COLUMN_IDS: string[] = [];
export const DEFAULT_AZURE_BOARD_PANEL_WIDTH = 65;
export const DEFAULT_WORK_ITEMS_VIEW_MODE: WorkItemsViewMode = 'board';

type AzureBoardState = {
  selectedProjectId: string | null;
  filtersByScope: Record<string, AzureBoardFilters>;
  panelWidthByScope: Record<string, number>;
  viewModeByScope: Record<string, WorkItemsViewMode>;
  collapsedColumnIdsByScope: Record<string, string[]>;
  colorSettings: BoardColorSettings;
  setSelectedProjectId: (projectId: string) => void;
  setFilters: (scopeKey: string, filters: Partial<AzureBoardFilters>) => void;
  setPanelWidth: (scopeKey: string, panelWidth: number) => void;
  setViewMode: (scopeKey: string, viewMode: WorkItemsViewMode) => void;
  toggleCollapsedColumn: (scopeKey: string, columnId: string) => void;
  setColorSettings: (colorSettings: BoardColorSettings) => void;
  resetColorSettings: () => void;
};

type LegacyAzureBoardState = Partial<AzureBoardState> & {
  /** Pre-v7: keyed by project id and implicitly scoped to the board overlay. */
  filtersByProject?: Record<
    string,
    Partial<AzureBoardFilters> & {
      assignee?: string;
      iterationPath?: string;
      workItemType?: string;
    }
  >;
  collapsedColumnIdsByProject?: Record<string, string[]>;
  panelWidth?: number;
};

export function migrateAzureBoardState(persistedState: unknown) {
  const state = (persistedState ?? {}) as LegacyAzureBoardState;
  const legacyFilters = Object.fromEntries(
    Object.entries(state.filtersByProject ?? {}).map(([projectId, filters]) => [
      workItemWorkspaceScopeKey({ surface: 'board', projectId }),
      {
        ...DEFAULT_AZURE_BOARD_FILTERS,
        ...filters,
        assignees:
          filters.assignees ?? (filters.assignee ? [filters.assignee] : []),
        iterations:
          filters.iterations ??
          (filters.iterationPath ? [filters.iterationPath] : []),
        workItemTypes:
          filters.workItemTypes ??
          (filters.workItemType ? [filters.workItemType] : []),
        assignee: undefined,
        iterationPath: undefined,
        workItemType: undefined,
      },
    ]),
  );
  const legacyCollapsed = Object.fromEntries(
    Object.entries(state.collapsedColumnIdsByProject ?? {}).map(
      ([projectId, columnIds]) => [
        workItemWorkspaceScopeKey({ surface: 'board', projectId }),
        columnIds,
      ],
    ),
  );
  // The old width was a single global value, so it has to fan out to every
  // board scope we know about — not just the ones that happen to have filters,
  // or a user who only ever dragged the splitter loses their width.
  const legacyWidth = state.panelWidth;
  const legacyPanelWidths =
    typeof legacyWidth === 'number'
      ? Object.fromEntries(
          [
            ...new Set([
              ...Object.keys(legacyFilters),
              ...Object.keys(legacyCollapsed),
              ...(state.selectedProjectId
                ? [
                    workItemWorkspaceScopeKey({
                      surface: 'board',
                      projectId: state.selectedProjectId,
                    }),
                  ]
                : []),
            ]),
          ].map((scopeKey) => [scopeKey, legacyWidth]),
        )
      : {};

  return {
    ...state,
    filtersByScope: { ...legacyFilters, ...state.filtersByScope },
    collapsedColumnIdsByScope: {
      ...legacyCollapsed,
      ...state.collapsedColumnIdsByScope,
    },
    panelWidthByScope: { ...legacyPanelWidths, ...state.panelWidthByScope },
    viewModeByScope: state.viewModeByScope ?? {},
    colorSettings: sanitizeBoardColorSettings(state.colorSettings),
    filtersByProject: undefined,
    collapsedColumnIdsByProject: undefined,
    panelWidth: undefined,
  } as AzureBoardState;
}

export const useAzureBoardStore = create<AzureBoardState>()(
  persist(
    (set) => ({
      selectedProjectId: null,
      filtersByScope: {},
      panelWidthByScope: {},
      viewModeByScope: {},
      collapsedColumnIdsByScope: {},
      colorSettings: DEFAULT_BOARD_COLOR_SETTINGS,
      setSelectedProjectId: (selectedProjectId) => set({ selectedProjectId }),
      setFilters: (scopeKey, filters) =>
        set((state) => ({
          filtersByScope: {
            ...state.filtersByScope,
            [scopeKey]: {
              ...DEFAULT_AZURE_BOARD_FILTERS,
              ...state.filtersByScope[scopeKey],
              ...filters,
            },
          },
        })),
      setPanelWidth: (scopeKey, panelWidth) =>
        set((state) => ({
          panelWidthByScope: { ...state.panelWidthByScope, [scopeKey]: panelWidth },
        })),
      setViewMode: (scopeKey, viewMode) =>
        set((state) => ({
          viewModeByScope: { ...state.viewModeByScope, [scopeKey]: viewMode },
        })),
      toggleCollapsedColumn: (scopeKey, columnId) =>
        set((state) => {
          const collapsed = state.collapsedColumnIdsByScope[scopeKey] ?? [];
          return {
            collapsedColumnIdsByScope: {
              ...state.collapsedColumnIdsByScope,
              [scopeKey]: collapsed.includes(columnId)
                ? collapsed.filter((id) => id !== columnId)
                : [...collapsed, columnId],
            },
          };
        }),
      setColorSettings: (colorSettings) => set({ colorSettings }),
      resetColorSettings: () =>
        set({ colorSettings: DEFAULT_BOARD_COLOR_SETTINGS }),
    }),
    {
      name: 'azure-board',
      version: 7,
      migrate: migrateAzureBoardState,
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<AzureBoardState>;
        return {
          ...currentState,
          ...persisted,
          colorSettings: sanitizeBoardColorSettings(persisted.colorSettings),
        };
      },
    },
  ),
);

export function getAzureBoardFilters(scopeKey: string) {
  const filters = useAzureBoardStore.getState().filtersByScope[scopeKey];
  return filters ?? DEFAULT_AZURE_BOARD_FILTERS;
}
