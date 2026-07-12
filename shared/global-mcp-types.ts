// shared/global-mcp-types.ts
// Types for the global MCP lifecycle feature.
// Separate from existing project/worktree MCP templates.

import type { AgentBackendType } from './agent-backend-types';

/** Transport type for MCP servers */
export type McpTransportType = 'stdio' | 'http' | 'sse';

export function normalizeGlobalMcpName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

export function sanitizeGlobalMcpName(name: string): string {
  const sanitized = name.trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return (sanitized || 'mcp-server').slice(0, 128);
}

export interface GlobalMcpBackendState {
  owned: boolean;
  entryName: string;
  rawEntry: Record<string, unknown>;
  fingerprint: string;
}

export type GlobalMcpBackendStates = Partial<
  Record<AgentBackendType, GlobalMcpBackendState>
>;

/** A globally-managed MCP server record stored in SQLite */
export interface GlobalMcpServer {
  id: string;
  name: string;
  transportType: McpTransportType;
  /** stdio: command to run */
  command: string | null;
  /** stdio: arguments */
  args: string[];
  /** stdio: environment variables */
  env: Record<string, string>;
  /** Stored environment exists but values are withheld from renderer. */
  hasStoredEnv?: boolean;
  /** http/sse: server URL */
  url: string | null;
  /** Which backends this server is currently enabled on */
  enabledBackends: AgentBackendType[];
  createdAt: string;
  updatedAt: string;
}

export interface GlobalMcpServerRecord extends GlobalMcpServer {
  normalizedName: string;
  envManaged: boolean;
  backendStates: GlobalMcpBackendStates;
}

export interface NewGlobalMcpServer {
  name: string;
  transportType: McpTransportType;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  url?: string | null;
  enabledBackends: AgentBackendType[];
}

export interface UpdateGlobalMcpServer {
  name?: string;
  transportType?: McpTransportType;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  url?: string | null;
  enabledBackends?: AgentBackendType[];
}

export interface DiscoveredMcpCommonConfig {
  transportType: McpTransportType;
  command: string | null;
  args: string[];
  url: string | null;
}

export interface DiscoveredMcpSource {
  backend: AgentBackendType;
  entryName: string;
  fingerprint: string;
}

export interface DiscoveredMcpVariant {
  name: string;
  canonicalName: string;
  common: DiscoveredMcpCommonConfig;
  sources: DiscoveredMcpSource[];
}

export interface DiscoveredMcpGroup {
  name: string;
  normalizedName: string;
  conflict: boolean;
  variants: DiscoveredMcpVariant[];
}

export interface GlobalMcpDiscoveryResult {
  groups: DiscoveredMcpGroup[];
  errors: Array<{ backend: AgentBackendType; message: string }>;
}

/** Result of a name collision check */
export interface McpNameCollisionResult {
  hasCollision: boolean;
  /** The existing server that collides */
  existingName?: string;
  /** Whether the configs differ (same name but different command/args) */
  configsDiffer?: boolean;
}
