import type { AgentBackendType } from './agent-backend-types';

export const AGENT_RESOURCE_SAMPLING_INTERVAL_MS = 4_000;
export const AGENT_RESOURCE_HIGH_FREQUENCY_SAMPLING_INTERVAL_MS = 500;

export type AgentResourceSnapshot = {
  stepId: string;
  taskId: string;
  backend: AgentBackendType;
  rootPid: number | null;
  pids: number[];
  sampledAt: string;
  cpuPercent: number;
  rssBytes: number;
  peakCpuPercent: number;
  peakRssBytes: number;
  sampleCount: number;
  unsupportedReason?: string;
};

export type AgentResourceSummary = {
  id: string;
  taskId: string;
  stepId: string;
  backend: AgentBackendType;
  rootPid: number | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  sampleCount: number;
  avgCpuPercent: number;
  peakCpuPercent: number;
  avgRssBytes: number;
  peakRssBytes: number;
};
