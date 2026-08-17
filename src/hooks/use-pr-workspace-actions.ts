import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { reconcilePrWorkspaceDeletion } from '@/lib/reconcile-pr-workspace-deletion';

export function usePrWorkspaceActions() {
  const queryClient = useQueryClient();

  const deleteCurrent = useMutation({
    mutationFn: (params: { taskId: string }) =>
      api.tasks.deletePrWorkspaceTask(params),
    onSuccess: (result) =>
      reconcilePrWorkspaceDeletion(result.taskIds, queryClient),
  });

  const deleteAll = useMutation({
    mutationFn: async (params: {
      projectId: string;
      pullRequestId: number;
    }) => {
      return api.tasks.deleteAllPrWorkspaces(params);
    },
    onSuccess: (result) =>
      reconcilePrWorkspaceDeletion(result.taskIds, queryClient),
  });

  return { deleteCurrent, deleteAll };
}
