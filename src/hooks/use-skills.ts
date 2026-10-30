import { useQuery } from '@tanstack/react-query';

import type { AgentBackendType } from '@shared/agent-backend-types';

import { api } from '@/lib/api';

export const skillsQueryKeys = {
  all: ['skills'] as const,
  byStep: (taskId: string, stepId?: string) =>
    [...skillsQueryKeys.all, 'step', taskId, stepId ?? ''] as const,
  // Prefix key: matches every backend variant for a project.
  projectPrefix: (projectId: string) =>
    [...skillsQueryKeys.all, 'project', projectId] as const,
  byProject: (projectId: string, backendType?: AgentBackendType | null) =>
    [...skillsQueryKeys.all, 'project', projectId, backendType ?? ''] as const,
};

/**
 * Fetches enabled skills for a task step.
 * The IPC handler resolves the backend type from the step and the project
 * path from the task's worktree (or its parent project), then returns only
 * skills that are enabled for that backend.
 */
export function useSkills(params: { taskId?: string; stepId?: string }) {
  const { taskId, stepId } = params;

  return useQuery({
    queryKey: skillsQueryKeys.byStep(taskId ?? '', stepId),
    queryFn: () => api.skillManagement.getForStep({ taskId: taskId!, stepId }),
    enabled: !!taskId,
    staleTime: 30_000,
  });
}

/**
 * Fetches the skills enabled for a project. `backendType` lets a caller that
 * already has a backend selected (the new-task overlay) override the project's
 * `agent` role, so switching backend in the UI refetches the matching list.
 */
export function useProjectSkills(
  projectId: string | undefined,
  backendType?: AgentBackendType | null,
) {
  return useQuery({
    queryKey: skillsQueryKeys.byProject(projectId ?? '', backendType),
    queryFn: () => api.projects.getSkills(projectId!, backendType),
    enabled: !!projectId,
    staleTime: 5 * 60 * 1000, // Skills don't change often, cache for 5 minutes
  });
}
