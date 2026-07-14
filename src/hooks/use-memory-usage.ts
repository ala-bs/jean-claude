import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';


import {
  AGENT_RESOURCE_HIGH_FREQUENCY_SAMPLING_INTERVAL_MS,
  AGENT_RESOURCE_SAMPLING_INTERVAL_MS,
} from '@shared/agent-resource-types';
import { api } from '@/lib/api';

const RAM_POLL_INTERVAL_MS = AGENT_RESOURCE_SAMPLING_INTERVAL_MS;
const MEMORY_USAGE_HISTORY_WINDOW_MS = 20 * 60 * 1000;
const MAX_MEMORY_USAGE_SAMPLE_GAP_MS = RAM_POLL_INTERVAL_MS * 2;
export const MAX_MEMORY_USAGE_SAMPLES = Math.ceil(
  MEMORY_USAGE_HISTORY_WINDOW_MS / RAM_POLL_INTERVAL_MS,
);
const MAX_MEMORY_USAGE_BUFFER_SAMPLES =
  MAX_MEMORY_USAGE_SAMPLES +
  Math.ceil(
    MEMORY_USAGE_HISTORY_WINDOW_MS /
      AGENT_RESOURCE_HIGH_FREQUENCY_SAMPLING_INTERVAL_MS,
  );

type MemoryUsageSnapshot = Awaited<
  ReturnType<typeof api.system.getMemoryUsage>
>;

export type MemoryUsageSample = MemoryUsageSnapshot & {
  sampledAt: number;
};

let memoryUsageHistory: MemoryUsageSample[] = [];

export function useMemoryUsage(
  {
    pollIntervalMs = RAM_POLL_INTERVAL_MS,
    isolatedHistory = false,
  }: { pollIntervalMs?: number; isolatedHistory?: boolean } = {},
) {
  const [isolatedHistoryStore] = useState(() => [...memoryUsageHistory]);
  const historyStore = isolatedHistory
    ? isolatedHistoryStore
    : memoryUsageHistory;
  const [history, setHistory] = useState(historyStore);
  const mutation = useMutation({
    mutationFn: () => api.system.getMemoryUsage(),
    onSuccess: (data) => {
      const sampledAt = Date.now();
      const lastSample = historyStore[historyStore.length - 1];

      if (
        lastSample &&
        sampledAt - lastSample.sampledAt > MAX_MEMORY_USAGE_SAMPLE_GAP_MS
      ) {
        historyStore.splice(0);
      }

      historyStore.push({ ...data, sampledAt });

      const cutoff = sampledAt - MEMORY_USAGE_HISTORY_WINDOW_MS;
      const firstValidIndex = historyStore.findIndex(
        (sample) => sample.sampledAt >= cutoff,
      );
      if (firstValidIndex > 0) {
        historyStore.splice(0, firstValidIndex);
      }

      if (historyStore.length > MAX_MEMORY_USAGE_BUFFER_SAMPLES) {
        historyStore.splice(
          0,
          historyStore.length - MAX_MEMORY_USAGE_BUFFER_SAMPLES,
        );
      }

      setHistory([...historyStore]);
    },
  });
  const { mutate } = mutation;

  useEffect(() => {
    mutate();

    const interval = window.setInterval(() => {
      mutate();
    }, pollIntervalMs);

    return () => window.clearInterval(interval);
  }, [mutate, pollIntervalMs]);

  return {
    ...mutation,
    data: history[history.length - 1] ?? mutation.data,
    history,
  };
}
