# Guess Rate Reset Time Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Infer rate-limit window resets from sparse snapshot data so the usage chart accurately shows resets even during data gaps.

**Architecture:** Each snapshot stores `resetsAt` (when current window ends). When consecutive snapshots have different `resetsAt` values, a window reset happened at the old `resetsAt`. We synthesize virtual data points (utilization=0) at reset boundaries so the sparkline shows the sawtooth pattern. A pure UI-layer transform — no DB or service changes needed.

**Tech Stack:** TypeScript, React (useMemo), existing Sparkline component

---

## Background

The usage history chart currently plots raw snapshots as-is. Two problems with sparse data:

1. **Gap across reset:** User stops working at 60% utilization, comes back after window reset. Chart draws straight line from 60% → new low value, missing the reset drop to 0%.
2. **Rate-limited gap:** User hits 100%, stops getting data. When they resume in a new window, chart again draws misleading interpolation.

**Key insight:** If snapshot A has `resetsAt = T₁` and snapshot B (later) has `resetsAt = T₂` where `T₂ ≠ T₁`, then:
- Window reset happened at `T₁`
- At time `T₁`, utilization dropped to 0%
- We can inject synthetic points to represent this

Multiple resets may have happened between two snapshots (e.g., 3 five-hour windows passed). We only inject the *last* reset before snapshot B, since we have no data for intermediate windows.

---

### Task 1: Extract snapshot interpolation into a utility function

**Files:**
- Create: `src/layout/ui-header/usage-history-chart/utils-interpolate-resets.ts`

**Step 1: Create the interpolation utility**

This function takes raw snapshots and returns an augmented array with synthetic reset points inserted:

```typescript
import type { UsageSnapshotRow } from '@shared/../../electron/database/schema';

export interface ChartSnapshot {
  utilization: number;
  recordedAt: string;
  resetsAt: string;
  synthetic?: boolean;
}

/**
 * Insert synthetic zero-utilization points at inferred window resets.
 *
 * When consecutive snapshots have different `resetsAt` values, a window
 * reset happened at the earlier snapshot's `resetsAt`. We inject:
 *   1. A point at `resetsAt - 1ms` preserving last known utilization (visual drop)
 *   2. A point at `resetsAt` with utilization = 0 (the reset)
 *
 * Only inserts if the reset time falls between the two snapshots.
 */
export function interpolateResets(
  snapshots: UsageSnapshotRow[],
): ChartSnapshot[] {
  if (snapshots.length === 0) return [];

  const result: ChartSnapshot[] = [snapshots[0]!];

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1]!;
    const curr = snapshots[i]!;

    const prevResetMs = new Date(prev.resetsAt).getTime();
    const prevRecordedMs = new Date(prev.recordedAt).getTime();
    const currRecordedMs = new Date(curr.recordedAt).getTime();

    // A reset happened if: the previous reset time falls between the two snapshots
    if (
      prev.resetsAt !== curr.resetsAt &&
      prevResetMs > prevRecordedMs &&
      prevResetMs < currRecordedMs
    ) {
      // Synthetic point just before reset: last known utilization
      result.push({
        utilization: prev.utilization,
        recordedAt: new Date(prevResetMs - 1).toISOString(),
        resetsAt: prev.resetsAt,
        synthetic: true,
      });

      // Synthetic point at reset: utilization drops to 0
      result.push({
        utilization: 0,
        recordedAt: new Date(prevResetMs).toISOString(),
        resetsAt: curr.resetsAt,
        synthetic: true,
      });
    }

    result.push(curr);
  }

  return result;
}
```

**Step 2: Verify no TypeScript errors**

Run: `pnpm ts-check`

**Step 3: Commit**

```
feat: add interpolateResets utility for synthetic reset points
```

---

### Task 2: Integrate interpolation into the chart

**Files:**
- Modify: `src/layout/ui-header/usage-history-chart/index.tsx`

**Step 1: Wire up interpolation in `chartData` useMemo**

Import the utility and apply it before building chart arrays:

```typescript
import { interpolateResets } from './utils-interpolate-resets';
```

Change the `chartData` useMemo from:

```typescript
const chartData = useMemo(() => {
  if (!history || history.length < 2) return null;
  return {
    timestamps: history.map((snapshot) =>
      new Date(snapshot.recordedAt).getTime(),
    ),
    usage: history.map((snapshot) => snapshot.utilization),
    linear: history.map((snapshot) =>
      getLinearUtilization(snapshot, windowDurationMs),
    ),
  };
}, [history, windowDurationMs]);
```

To:

```typescript
const chartData = useMemo(() => {
  if (!history || history.length < 2) return null;
  const interpolated = interpolateResets(history);
  return {
    timestamps: interpolated.map((s) =>
      new Date(s.recordedAt).getTime(),
    ),
    usage: interpolated.map((s) => s.utilization),
    linear: interpolated.map((s) =>
      getLinearUtilization(s, windowDurationMs),
    ),
  };
}, [history, windowDurationMs]);
```

**Step 2: Verify TypeScript and lint**

Run: `pnpm ts-check && pnpm lint`

**Step 3: Commit**

```
feat: integrate reset interpolation into usage history chart
```

---

### Task 3: Handle multiple resets in a gap

**Files:**
- Modify: `src/layout/ui-header/usage-history-chart/utils-interpolate-resets.ts`

**Step 1: Handle case where multiple windows passed**

When many hours/days pass between snapshots, multiple resets may have occurred. The current logic only catches the first reset. We need to also consider: if `currRecordedMs - prevResetMs` is longer than a window duration, there were intermediate resets we can't know about. The most useful synthetic point is the *last* reset before `curr`.

Update the interpolation to also insert a synthetic zero point at the start of `curr`'s window:

```typescript
export function interpolateResets(
  snapshots: UsageSnapshotRow[],
): ChartSnapshot[] {
  if (snapshots.length === 0) return [];

  const result: ChartSnapshot[] = [snapshots[0]!];

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1]!;
    const curr = snapshots[i]!;

    if (prev.resetsAt === curr.resetsAt) {
      // Same window — no reset between these points
      result.push(curr);
      continue;
    }

    const prevResetMs = new Date(prev.resetsAt).getTime();
    const prevRecordedMs = new Date(prev.recordedAt).getTime();
    const currResetMs = new Date(curr.resetsAt).getTime();
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

    // If curr's window start (currResetMs - windowDuration) is significantly
    // after prevResetMs, there were intermediate windows we know nothing about.
    // We can't infer those, but we DO know curr's window started fresh at 0%.
    // Only add if there's a meaningful time gap before curr.
    const GAP_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
    const lastSyntheticMs = prevResetMs > prevRecordedMs ? prevResetMs : prevRecordedMs;
    if (currRecordedMs - lastSyntheticMs > GAP_THRESHOLD_MS) {
      // If we didn't already insert a zero point close to curr, and curr's
      // utilization is non-trivial, show it was zero before it started climbing
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

    result.push(curr);
  }

  return result;
}
```

**Step 2: Verify TypeScript and lint**

Run: `pnpm ts-check && pnpm lint`

**Step 3: Commit**

```
feat: handle multiple window resets in usage interpolation
```

---

### Task 4: Visual indicator for synthetic/inferred data

**Files:**
- Modify: `src/layout/ui-header/usage-history-chart/index.tsx`
- Modify: `src/common/ui/sparkline/index.tsx`

**Step 1: Pass synthetic point info to Sparkline**

Add optional `gaps` prop to Sparkline — array of x-ranges where data is inferred. Render these as subtle dotted segments or dimmed fill regions. This tells the user "we're guessing here."

In `usage-history-chart/index.tsx`, compute gap ranges from synthetic points:

```typescript
const gapRanges = useMemo(() => {
  if (!history || history.length < 2) return [];
  const interpolated = interpolateResets(history);
  const ranges: { startMs: number; endMs: number }[] = [];
  let gapStart: number | null = null;

  for (const point of interpolated) {
    const ms = new Date(point.recordedAt).getTime();
    if (point.synthetic && gapStart === null) {
      gapStart = ms;
    } else if (!point.synthetic && gapStart !== null) {
      ranges.push({ startMs: gapStart, endMs: ms });
      gapStart = null;
    }
  }

  return ranges;
}, [history]);
```

**Step 2: Render gap indicators in Sparkline**

Add optional `gapRanges` prop to Sparkline. For each gap range, render a translucent striped rect behind the chart area:

```typescript
// In Sparkline props:
gapRanges?: { startMs: number; endMs: number }[];

// In render, after area fill, before polylines:
{gapRanges?.map((gap) => {
  const x1 = padding + ((gap.startMs - minX) / xRange) * drawWidth;
  const x2 = padding + ((gap.endMs - minX) / xRange) * drawWidth;
  return (
    <rect
      key={`${gap.startMs}-${gap.endMs}`}
      x={x1}
      y={padding}
      width={Math.max(x2 - x1, 1)}
      height={drawHeight}
      fill="var(--color-ink-3)"
      opacity={0.08}
    />
  );
})}
```

**Step 3: Verify TypeScript and lint**

Run: `pnpm ts-check && pnpm lint`

**Step 4: Commit**

```
feat: show visual indicator for inferred data gaps in usage chart
```

---

## Notes

- **No DB changes needed** — all logic is UI-layer interpolation
- `getLinearUtilization` already uses `resetsAt` per-point, so synthetic points with correct `resetsAt` will get correct linear pace values
- The synthetic `resetsAt` on the zero-point uses `curr.resetsAt` (the new window), so the linear pace line also resets correctly
- Task 4 is optional polish — tasks 1-3 deliver core value
