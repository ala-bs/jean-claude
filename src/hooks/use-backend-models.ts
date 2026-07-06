import { useQuery } from '@tanstack/react-query';

import type { AgentBackendType } from '@shared/agent-backend-types';
import { api } from '@/lib/api';
import type { ThinkingEffort } from '@shared/types';


export interface BackendModel {
  id: string;
  label: string;
  contextWindow?: number;
  supportsThinking?: boolean;
  thinkingEfforts?: ThinkingEffort[];
}

/**
 * Fetch available models for a given agent backend.
 * Returns { id, label } pairs. 'default' is always prepended client-side.
 */
export function useBackendModels(backend: AgentBackendType | null) {
  return useQuery<BackendModel[]>({
    queryKey: ['backendModels', backend],
    queryFn: () => {
      if (!backend) return [];
      return api.agent.getBackendModels(backend);
    },
    enabled: backend !== null,
    staleTime: 5 * 60 * 1000, // match server-side cache TTL
  });
}
