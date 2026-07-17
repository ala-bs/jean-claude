import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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

export const EMPTY_AZURE_BOARD_COLUMN_IDS: string[] = [];

type AzureBoardState = {
  selectedProjectId: string | null;
  filtersByProject: Record<string, AzureBoardFilters>;
  panelWidth: number;
  collapsedColumnIdsByProject: Record<string, string[]>;
  setSelectedProjectId: (projectId: string) => void;
  setFilters: (projectId: string, filters: Partial<AzureBoardFilters>) => void;
  setPanelWidth: (panelWidth: number) => void;
  toggleCollapsedColumn: (projectId: string, columnId: string) => void;
};

export function migrateAzureBoardState(persistedState: unknown) {
  const state = persistedState as Partial<AzureBoardState> & {
    filtersByProject?: Record<
      string,
      Partial<AzureBoardFilters> & {
        assignee?: string;
        iterationPath?: string;
        workItemType?: string;
      }
    >;
  };
  return {
    ...state,
    filtersByProject: Object.fromEntries(
      Object.entries(state.filtersByProject ?? {}).map(([projectId, filters]) => [
        projectId,
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
    ),
    collapsedColumnIdsByProject: state.collapsedColumnIdsByProject ?? {},
  } as AzureBoardState;
}

export const useAzureBoardStore = create<AzureBoardState>()(
  persist(
    (set) => ({
      selectedProjectId: null,
      filtersByProject: {},
      panelWidth: 65,
      collapsedColumnIdsByProject: {},
      setSelectedProjectId: (selectedProjectId) => set({ selectedProjectId }),
      setFilters: (projectId, filters) =>
        set((state) => ({
          filtersByProject: {
            ...state.filtersByProject,
            [projectId]: {
              ...DEFAULT_AZURE_BOARD_FILTERS,
              ...state.filtersByProject[projectId],
              ...filters,
            },
          },
        })),
      setPanelWidth: (panelWidth) => set({ panelWidth }),
      toggleCollapsedColumn: (projectId, columnId) =>
        set((state) => {
          const collapsed = state.collapsedColumnIdsByProject[projectId] ?? [];
          return {
            collapsedColumnIdsByProject: {
              ...state.collapsedColumnIdsByProject,
              [projectId]: collapsed.includes(columnId)
                ? collapsed.filter((id) => id !== columnId)
                : [...collapsed, columnId],
            },
          };
        }),
    }),
    {
      name: 'azure-board',
      version: 4,
      migrate: migrateAzureBoardState,
    },
  ),
);

export function getAzureBoardFilters(projectId: string) {
  const filters = useAzureBoardStore.getState().filtersByProject[projectId];
  return filters ?? DEFAULT_AZURE_BOARD_FILTERS;
}
