import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useCallback } from 'react';

/**
 * Persists the work item picker's iteration filter per app project, shared by
 * every related-work-items surface (new task overlay, task detail link modal),
 * so a manually selected iteration survives navigation and app restarts.
 */

export const DEFAULT_ITERATION_FILTER = '__current__';

interface WorkItemPickerFiltersState {
  /** Map of appProjectId → iteration filter value */
  iterationFilterByProject: Record<string, string>;
  setIterationFilter: (appProjectId: string, iterationFilter: string) => void;
  clearProject: (appProjectId: string) => void;
}

export const useWorkItemPickerFiltersStore =
  create<WorkItemPickerFiltersState>()(
    persist(
      (set) => ({
        iterationFilterByProject: {},
        setIterationFilter: (appProjectId, iterationFilter) =>
          set((state) => ({
            iterationFilterByProject: {
              ...state.iterationFilterByProject,
              [appProjectId]: iterationFilter,
            },
          })),
        clearProject: (appProjectId) =>
          set((state) => {
            const { [appProjectId]: _, ...rest } = state.iterationFilterByProject;
            return { iterationFilterByProject: rest };
          }),
      }),
      { name: 'work-item-picker-filters', version: 1 },
    ),
  );

/**
 * Bound iteration filter state for a given app project.
 * Passing a nullish project id yields the default and ignores writes.
 */
export function useWorkItemPickerIterationFilter(
  appProjectId: string | null | undefined,
) {
  const iterationFilter = useWorkItemPickerFiltersStore((state) =>
    appProjectId
      ? (state.iterationFilterByProject[appProjectId] ??
        DEFAULT_ITERATION_FILTER)
      : DEFAULT_ITERATION_FILTER,
  );
  const setIterationFilterAction = useWorkItemPickerFiltersStore(
    (state) => state.setIterationFilter,
  );
  const setIterationFilter = useCallback(
    (value: string) => {
      if (!appProjectId) return;
      setIterationFilterAction(appProjectId, value);
    },
    [appProjectId, setIterationFilterAction],
  );
  return { iterationFilter, setIterationFilter };
}
