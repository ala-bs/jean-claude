import type { UsageSnapshot } from '@shared/usage-types';

export interface ChartSnapshot {
  utilization: number;
  recordedAt: string;
  resetsAt: string;
  synthetic: boolean;
}

/**
 * Insert synthetic zero-utilization points at inferred window resets.
 *
 * When consecutive snapshots have different `resetsAt` values, a window
 * reset happened at the earlier snapshot's `resetsAt`. We inject:
 *   1. A point at `resetsAt - 1ms` preserving last known utilization (visual drop)
 *   2. A point at `resetsAt` with utilization = 0 (the reset)
 *
 * When there is a large time gap between the reset and the next real
 * snapshot, an additional zero point is inserted closer to the next
 * snapshot so the chart shows flat zero during the unknown period.
 *
 * Only inserts synthetic points if the reset time falls between the two
 * snapshots' `recordedAt` times.
 */
export function interpolateResets(snapshots: UsageSnapshot[]): ChartSnapshot[] {
  if (snapshots.length === 0) return [];

  const result: ChartSnapshot[] = [{ ...snapshots[0]!, synthetic: false }];

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1]!;
    const curr = snapshots[i]!;

    if (prev.resetsAt === curr.resetsAt) {
      // Same window — no reset between these points
      result.push({ ...curr, synthetic: false });
      continue;
    }

    const prevResetMs = new Date(prev.resetsAt).getTime();
    const prevRecordedMs = new Date(prev.recordedAt).getTime();
    const currRecordedMs = new Date(curr.recordedAt).getTime();

    // The previous window's reset time — inject if it falls in the gap
    if (prevResetMs > prevRecordedMs && prevResetMs < currRecordedMs) {
      // Hold previous utilization right up to reset
      result.push({
        utilization: prev.utilization,
        recordedAt: new Date(prevResetMs - 1).toISOString(),
        resetsAt: prev.resetsAt,
        synthetic: true,
      });

      // Drop to zero at reset
      result.push({
        utilization: 0,
        recordedAt: new Date(prevResetMs).toISOString(),
        resetsAt: curr.resetsAt,
        synthetic: true,
      });
    }

    // If curr's window start is significantly after prevResetMs, there were
    // intermediate windows we know nothing about. We can't infer those, but
    // we DO know curr's window started fresh at 0%. Insert a synthetic zero
    // point before curr so the chart shows flat zero during the unknown period.
    const GAP_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
    const lastSyntheticMs =
      prevResetMs > prevRecordedMs ? prevResetMs : prevRecordedMs;
    if (currRecordedMs - lastSyntheticMs > GAP_THRESHOLD_MS) {
      const currWindowStartApproxMs = currRecordedMs - GAP_THRESHOLD_MS;
      if (currWindowStartApproxMs > lastSyntheticMs + GAP_THRESHOLD_MS) {
        result.push({
          utilization: 0,
          recordedAt: new Date(currWindowStartApproxMs).toISOString(),
          resetsAt: curr.resetsAt,
          synthetic: true,
        });
      }
    }

    result.push({ ...curr, synthetic: false });
  }

  return result;
}
