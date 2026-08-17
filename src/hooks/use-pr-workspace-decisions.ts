import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { api } from '@/lib/api';
import { PR_WORKSPACE_DECISIONS_QUERY_KEY } from '@/cache/cache-events';
import { reconcilePrWorkspaceDeletion } from '@/lib/reconcile-pr-workspace-deletion';
import { subscribeCacheResourcesAndWait } from '@/cache/cache-subscriptions';

export type PrWorkspaceDecision = {
  key: string;
  projectId: string;
  pullRequestId: number;
  taskIds: string[];
};

function normalizeDecisions(
  decisions: Awaited<
    ReturnType<typeof api.tasks.listPendingPrWorkspaceDecisions>
  >,
) {
  const byKey = new Map<string, PrWorkspaceDecision>();

  for (const decision of decisions) {
    const key = `${decision.projectId}:${decision.pullRequestId}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.taskIds = [...new Set([...existing.taskIds, ...decision.taskIds])];
      continue;
    }

    byKey.set(key, { ...decision, key, taskIds: [...new Set(decision.taskIds)] });
  }

  return [...byKey.values()];
}

export function usePrWorkspaceDecisions() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    void subscribeCacheResourcesAndWait([
      { resourceKey: 'tasks' },
      { resourceKey: 'projects' },
    ])
      .then((release) => {
        if (cancelled) {
          release();
          return;
        }

        unsubscribe = release;
        void queryClient.invalidateQueries({
          queryKey: PR_WORKSPACE_DECISIONS_QUERY_KEY,
        });
      })
      .catch((error: unknown) => {
        console.error('Failed to subscribe to PR workspace decisions:', error);
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [queryClient]);

  return useQuery({
    queryKey: PR_WORKSPACE_DECISIONS_QUERY_KEY,
    queryFn: () => api.tasks.listPendingPrWorkspaceDecisions(),
    select: normalizeDecisions,
  });
}

export function useResolvePrWorkspaceDecision() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      projectId: string;
      pullRequestId: number;
      action: 'keep' | 'delete';
      taskIds: string[];
    }) => {
      const { taskIds: _taskIds, ...apiParams } = params;
      return api.tasks.resolveClosedPrWorkspace(apiParams);
    },
    onSuccess: async (result, params) => {
      if (params.action === 'delete') {
        await reconcilePrWorkspaceDeletion(result.taskIds, queryClient);
        return;
      }
      await queryClient.invalidateQueries({
        queryKey: PR_WORKSPACE_DECISIONS_QUERY_KEY,
      });
    },
  });
}
