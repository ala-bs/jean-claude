import { useMutation, useQueryClient } from '@tanstack/react-query';

import { ingestStep, markStepListsStale } from '@/cache/domains/steps';
import { api } from '@/lib/api';

function useStepPermissionMutation(
  mutation: (params: {
    stepId: string;
    toolName: string;
    input?: Record<string, unknown>;
    pattern?: string;
  }) => ReturnType<typeof api.steps.addSessionAllowedTool>,
  options: {
    invalidateGlobal?: boolean;
    invalidateProject?: boolean;
    onError?: (error: Error) => void;
  } = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: mutation,
    onSuccess: (step) => {
      ingestStep(step);
      markStepListsStale(step.taskId);
      queryClient.invalidateQueries({ queryKey: ['steps', step.id] });
      queryClient.invalidateQueries({
        queryKey: ['steps', { taskId: step.taskId }],
      });
      if (options.invalidateGlobal) {
        queryClient.invalidateQueries({ queryKey: ['globalPermissions'] });
      }
      if (options.invalidateProject) {
        // The step response carries no project path, so invalidate the whole
        // prefix — otherwise the project permissions view goes stale after
        // granting from the permission bar.
        queryClient.invalidateQueries({ queryKey: ['projectPermissions'] });
      }
    },
    onError: options.onError,
  });
}

export function useAddSessionAllowedTool() {
  return useStepPermissionMutation(({ stepId, toolName, input = {} }) =>
    api.steps.addSessionAllowedTool({ stepId, toolName, input }),
  );
}

export function useRemoveSessionAllowedTool() {
  return useStepPermissionMutation(({ stepId, toolName, pattern }) =>
    api.steps.removeSessionAllowedTool({ stepId, toolName, pattern }),
  );
}

export function useAllowForProject() {
  return useStepPermissionMutation(
    ({ stepId, toolName, input = {} }) =>
      api.steps.allowForProject({ stepId, toolName, input }),
    { invalidateProject: true },
  );
}

export function useAllowForProjectWorktrees() {
  return useStepPermissionMutation(
    ({ stepId, toolName, input = {} }) =>
      api.steps.allowForProjectWorktrees({ stepId, toolName, input }),
    { invalidateProject: true },
  );
}

export function useAllowGlobally({
  onError,
}: { onError?: (error: Error) => void } = {}) {
  return useStepPermissionMutation(
    ({ stepId, toolName, input = {} }) =>
      api.steps.allowGlobally({ stepId, toolName, input }),
    { invalidateGlobal: true, onError },
  );
}
