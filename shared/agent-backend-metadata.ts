import type { AgentBackendType } from './agent-backend-types';

export type AgentBackendBadge = 'Beta';

const AGENT_BACKEND_BADGES: Partial<
  Record<AgentBackendType, AgentBackendBadge>
> = {
  copilot: 'Beta',
};

export function getAgentBackendBadge(
  backend: AgentBackendType,
): AgentBackendBadge | undefined {
  return AGENT_BACKEND_BADGES[backend];
}
