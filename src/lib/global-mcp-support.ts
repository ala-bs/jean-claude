import type { AgentBackendType } from '@shared/agent-backend-types';
import type { McpTransportType } from '@shared/global-mcp-types';

const TRANSPORT_BACKENDS: Record<McpTransportType, AgentBackendType[]> = {
  stdio: ['claude-code', 'opencode', 'codex', 'copilot', 'vibe'],
  http: ['claude-code', 'opencode', 'codex', 'copilot', 'vibe'],
  sse: ['claude-code'],
};

export function backendSupportsTransport(
  backend: AgentBackendType,
  transport: McpTransportType,
): boolean {
  return TRANSPORT_BACKENDS[transport].includes(backend);
}
