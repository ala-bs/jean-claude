import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  NewProjectCommandGroup,
  ProjectCommandGroup,
  UpdateProjectCommandGroup,
} from '@shared/run-command-types';
import { api } from '@/lib/api';
import { flattenCommandGroupStages } from '@shared/run-command-types';


export function useProjectCommandGroups(projectId: string) {
  return useQuery({
    queryKey: ['projectCommandGroups', projectId],
    queryFn: () => api.projectCommandGroups.findByProjectId(projectId),
  });
}

/** Favorite groups across all projects, runnable from the project root. */
export function useFavoriteProjectCommandGroups() {
  return useQuery({
    queryKey: ['projectCommandGroups', 'favorites'],
    queryFn: () => api.projectCommandGroups.findFavorites(),
  });
}

/** Every command group, used by the favorites picker. */
export function useAllProjectCommandGroups({ enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: ['projectCommandGroups', 'all'],
    queryFn: () => api.projectCommandGroups.findAll(),
    enabled,
  });
}

export function useCreateProjectCommandGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: NewProjectCommandGroup) =>
      api.projectCommandGroups.create(data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['projectCommandGroups', variables.projectId],
      });
    },
  });
}

export function useUpdateProjectCommandGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: UpdateProjectCommandGroup;
    }) => api.projectCommandGroups.update(id, data),
    // Optimistic: stage edits (drag, wait-for-exit toggle, delay) fire in quick
    // succession and each one rebuilds the whole stage array from the cached
    // group. Without this, an edit made before the previous refetch lands is
    // computed from stale data and silently reverts the earlier one.
    onMutate: async ({ id, data }) => {
      await queryClient.cancelQueries({ queryKey: ['projectCommandGroups'] });
      const previous = queryClient.getQueriesData<ProjectCommandGroup[]>({
        queryKey: ['projectCommandGroups'],
      });

      queryClient.setQueriesData<ProjectCommandGroup[]>(
        { queryKey: ['projectCommandGroups'] },
        (old) =>
          old?.map((group) =>
            group.id === id
              ? {
                  ...group,
                  ...data,
                  // Keep the derived field in step with the optimistic stages,
                  // exactly as the repository does on write.
                  commandIds: data.stages
                    ? flattenCommandGroupStages(data.stages)
                    : group.commandIds,
                }
              : group,
          ),
      );

      return { previous };
    },
    onError: (_err, _variables, context) => {
      for (const [queryKey, value] of context?.previous ?? []) {
        queryClient.setQueryData(queryKey, value);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['projectCommandGroups'] });
    },
  });
}

export function useDeleteProjectCommandGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.projectCommandGroups.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projectCommandGroups'] });
    },
  });
}

export function useReorderProjectCommandGroups() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      groupIds,
    }: {
      projectId: string;
      groupIds: string[];
    }) => api.projectCommandGroups.reorder(projectId, groupIds),
    onMutate: async ({ projectId, groupIds }) => {
      await queryClient.cancelQueries({
        queryKey: ['projectCommandGroups', projectId],
      });
      const previous = queryClient.getQueryData<ProjectCommandGroup[]>([
        'projectCommandGroups',
        projectId,
      ]);
      queryClient.setQueryData<ProjectCommandGroup[]>(
        ['projectCommandGroups', projectId],
        (old) => {
          if (!old) return old;
          return groupIds
            .map((id, i) => {
              const group = old.find((entry) => entry.id === id);
              return group ? { ...group, sortOrder: i } : undefined;
            })
            .filter((group): group is ProjectCommandGroup => group != null);
        },
      );
      return { previous };
    },
    onError: (_err, { projectId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          ['projectCommandGroups', projectId],
          context.previous,
        );
      }
    },
    onSettled: (_data, _err, { projectId }) => {
      queryClient.invalidateQueries({
        queryKey: ['projectCommandGroups', projectId],
      });
    },
  });
}
