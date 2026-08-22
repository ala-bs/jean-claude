import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  NewProjectCommand,
  ProjectCommand,
  UpdateProjectCommand,
} from '@shared/run-command-types';
import { api } from '@/lib/api';


export function useProjectCommands(projectId: string) {
  return useQuery({
    queryKey: ['projectCommands', projectId],
    queryFn: () => api.projectCommands.findByProjectId(projectId),
  });
}

/** Favorites across all projects, runnable from the project root. */
export function useFavoriteProjectCommands() {
  return useQuery({
    queryKey: ['projectCommands', 'favorites'],
    queryFn: () => api.projectCommands.findFavorites(),
  });
}

/** Every project command, used by the favorites picker. */
export function useAllProjectCommands({ enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: ['projectCommands', 'all'],
    queryFn: () => api.projectCommands.findAll(),
    enabled,
  });
}

export function useCreateProjectCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: NewProjectCommand) => api.projectCommands.create(data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['projectCommands', variables.projectId],
      });
      queryClient.invalidateQueries({ queryKey: ['projectCommands', 'all'] });
    },
  });
}

export function useUpdateProjectCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateProjectCommand }) =>
      api.projectCommands.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projectCommands'] });
    },
  });
}

export function useDeleteProjectCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.projectCommands.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projectCommands'] });
      queryClient.invalidateQueries({ queryKey: ['projectCommandGroups'] });
    },
  });
}

export function useReorderProjectCommands() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      commandIds,
    }: {
      projectId: string;
      commandIds: string[];
    }) => api.projectCommands.reorder(projectId, commandIds),
    onMutate: async ({ projectId, commandIds }) => {
      await queryClient.cancelQueries({
        queryKey: ['projectCommands', projectId],
      });
      const previous = queryClient.getQueryData<ProjectCommand[]>([
        'projectCommands',
        projectId,
      ]);
      queryClient.setQueryData<ProjectCommand[]>(
        ['projectCommands', projectId],
        (old) => {
          if (!old) return old;
          return commandIds
            .map((id, i) => {
              const cmd = old.find((c) => c.id === id);
              return cmd ? { ...cmd, sortOrder: i } : undefined;
            })
            .filter((cmd): cmd is ProjectCommand => cmd != null);
        },
      );
      return { previous };
    },
    onError: (_err, { projectId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          ['projectCommands', projectId],
          context.previous,
        );
      }
    },
    onSettled: (_data, _err, { projectId }) => {
      queryClient.invalidateQueries({
        queryKey: ['projectCommands', projectId],
      });
    },
  });
}
