import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { NewProjectEnvVar, UpdateProjectEnvVar } from '@shared/types';
import { api } from '@/lib/api';

export function useProjectEnvVars(projectId: string | undefined) {
  return useQuery({
    queryKey: ['project-env-vars', { projectId }],
    queryFn: () => api.projects.listEnvVars(projectId!),
    enabled: !!projectId,
  });
}

/**
 * Whether the OS keychain is usable. When false, secret variables can't be
 * saved at all, so the UI hides the "secret" affordance rather than letting a
 * save fail after the fact.
 */
export function useSecretStorageAvailable() {
  return useQuery({
    queryKey: ['secret-storage-available'],
    queryFn: () => api.projects.isSecretStorageAvailable(),
    staleTime: Infinity,
  });
}

export function useCreateProjectEnvVar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: NewProjectEnvVar) => api.projects.createEnvVar(data),
    onSuccess: (envVar) => {
      queryClient.invalidateQueries({
        queryKey: ['project-env-vars', { projectId: envVar.projectId }],
      });
    },
  });
}

export function useUpdateProjectEnvVar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateProjectEnvVar }) =>
      api.projects.updateEnvVar(id, data),
    onSuccess: (envVar) => {
      queryClient.invalidateQueries({
        queryKey: ['project-env-vars', { projectId: envVar.projectId }],
      });
    },
  });
}

export function useDeleteProjectEnvVar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.projects.deleteEnvVar(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-env-vars'] });
    },
  });
}
