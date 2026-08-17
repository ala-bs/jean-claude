import { useEffect, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';


import {
  AGENT_RESOURCE_SAMPLING_INTERVAL_MS,
  type AgentResourceSnapshot,
} from '@shared/agent-resource-types';
import { api } from '@/lib/api';


const RESOURCE_HISTORY_WINDOW_MS = 60 * 60 * 1000;

export type AgentResourceSample = AgentResourceSnapshot;

let resourceHistoryByStepId: Record<string, AgentResourceSample[]> = {};
const resourceHistoryListeners = new Set<() => void>();

function subscribeToResourceHistory(listener: () => void): () => void {
  resourceHistoryListeners.add(listener);
  return () => resourceHistoryListeners.delete(listener);
}

function getResourceHistorySnapshot(): Record<string, AgentResourceSample[]> {
  return resourceHistoryByStepId;
}

function publishResourceHistory(
  nextHistoryByStepId: Record<string, AgentResourceSample[]>,
): void {
  resourceHistoryByStepId = nextHistoryByStepId;
  for (const listener of resourceHistoryListeners) listener();
}

export function useAgentResourceSnapshots(
  {
    refetchIntervalMs = AGENT_RESOURCE_SAMPLING_INTERVAL_MS,
  }: { refetchIntervalMs?: number } = {},
) {
  const historyByStepId = useSyncExternalStore(
    subscribeToResourceHistory,
    getResourceHistorySnapshot,
    getResourceHistorySnapshot,
  );
  const snapshotsQuery = useQuery({
    queryKey: ['agent-resource-snapshots'],
    queryFn: () => api.agent.getResourceSnapshots(),
    refetchInterval: refetchIntervalMs,
  });
  const historyQuery = useQuery({
    queryKey: ['agent-resource-history'],
    queryFn: () => api.agent.getResourceHistory(),
    staleTime: Infinity,
    refetchOnMount: 'always',
  });

  useEffect(() => {
    if (!historyQuery.data) return;

    const cutoff = Date.now() - RESOURCE_HISTORY_WINDOW_MS;
    const nextHistoryByStepId: Record<string, AgentResourceSample[]> = {
      ...resourceHistoryByStepId,
    };
    const serverStepIds = new Set(Object.keys(historyQuery.data));
    let changed = false;

    for (const stepId of Object.keys(nextHistoryByStepId)) {
      if (serverStepIds.has(stepId)) continue;
      delete nextHistoryByStepId[stepId];
      changed = true;
    }

    for (const [stepId, samples] of Object.entries(historyQuery.data)) {
      const supportedSamples = samples.filter(
        (sample) => !sample.unsupportedReason,
      );
      if (supportedSamples.length === 0) continue;

      const existing = nextHistoryByStepId[stepId] ?? [];
      const samplesByDate = new Map(
        existing.map((sample) => [sample.sampledAt, sample]),
      );

      for (const sample of supportedSamples) {
        samplesByDate.set(sample.sampledAt, sample);
      }

      const merged = Array.from(samplesByDate.values())
        .filter((sample) => Date.parse(sample.sampledAt) >= cutoff)
        .sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt));

      if (
        merged.length !== existing.length ||
        merged.some(
          (sample, index) => existing[index]?.sampledAt !== sample.sampledAt,
        )
      ) {
        changed = true;
      }
      nextHistoryByStepId[stepId] = merged;
    }

    if (!changed) return;

    publishResourceHistory(nextHistoryByStepId);
  }, [historyQuery.data]);

  useEffect(() => {
    if (!snapshotsQuery.data) return;

    const cutoff = Date.now() - RESOURCE_HISTORY_WINDOW_MS;
    const nextHistoryByStepId: Record<string, AgentResourceSample[]> = {
      ...resourceHistoryByStepId,
    };
    let changed = false;

    for (const [stepId, samples] of Object.entries(nextHistoryByStepId)) {
      if (Date.parse(samples[0]?.sampledAt ?? '') >= cutoff) continue;

      const pruned = samples.filter(
        (sample) => Date.parse(sample.sampledAt) >= cutoff,
      );
      if (pruned.length === 0) {
        delete nextHistoryByStepId[stepId];
      } else {
        nextHistoryByStepId[stepId] = pruned;
      }
      changed = true;
    }

    for (const snapshot of snapshotsQuery.data) {
      if (snapshot.unsupportedReason) continue;

      const existing = nextHistoryByStepId[snapshot.stepId] ?? [];
      if (existing.some((sample) => sample.sampledAt === snapshot.sampledAt)) {
        continue;
      }

      nextHistoryByStepId[snapshot.stepId] = [...existing, snapshot].filter(
        (sample) => Date.parse(sample.sampledAt) >= cutoff,
      );
      changed = true;
    }

    if (!changed) return;

    publishResourceHistory(nextHistoryByStepId);
  }, [snapshotsQuery.data]);

  return {
    ...snapshotsQuery,
    historyByStepId,
  };
}
