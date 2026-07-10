import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ProjectSuggestions } from '@shared/run-command-types';

import { api } from '@/lib/api';

export function useProjectSuggestions(projectPath: string | undefined) {
  return useQuery({
    queryKey: ['projectSuggestions', projectPath],
    queryFn: () => api.runCommands.getProjectSuggestions(projectPath!),
    enabled: !!projectPath,
  });
}

export function useSaveProjectSuggestions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectPath,
      suggestions,
    }: {
      projectPath: string;
      suggestions: ProjectSuggestions;
    }) => api.runCommands.saveProjectSuggestions(projectPath, suggestions),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['projectSuggestions', variables.projectPath],
      });
    },
  });
}
