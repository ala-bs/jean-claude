import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { app } from 'electron';

const MAX_LOG_BYTES = 2 * 1024 * 1024;
let pendingWrite = Promise.resolve();

/** Persist slow-operation diagnostics without blocking the Electron main loop. */
export function logPerformanceEvent(params: {
  source: 'renderer' | 'main' | 'database';
  message: string;
}): Promise<void> {
  const line = `${new Date().toISOString()} ${params.source} ${params.message.replace(/[\r\n]+/g, ' ').slice(0, 1000)}\n`;
  pendingWrite = pendingWrite.then(async () => {
    const dir = path.join(app.getPath('userData'), 'logs');
    const file = path.join(dir, 'performance.log');
    await mkdir(dir, { recursive: true });

    const size = await stat(file).then((info) => info.size).catch(() => 0);
    if (size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
      const previous = `${file}.1`;
      await rm(previous, { force: true });
      await rename(file, previous);
    }
    await appendFile(file, line, 'utf-8');
  }).catch((error: unknown) => {
    // Diagnostics must never change application behavior, but a failed write
    // should be visible in the main-process console during investigation.
    console.warn('[performance] Could not write performance log:', error);
  });
  return pendingWrite;
}

/**
 * A stall has two very different causes, and CPU time during the stall is what
 * tells them apart:
 *
 *   cpu ≈ 100% of the stall -> this process was scheduled and running, so our
 *                              own synchronous code blocked the loop. Profile it.
 *   cpu ≈ 0%   of the stall -> this process was never scheduled. The OS
 *                              suspended or starved us (App Nap, occlusion
 *                              throttling, swap-in, a CPU-hungry sibling).
 *                              Tuning our code cannot fix that.
 *
 * `wallDrift` separates "descheduled" from "the machine slept": a monotonic
 * clock and the wall clock diverge across a suspend, but not across CPU burn.
 */
export function describeProcessLoad(params: {
  /** Monotonic ms actually elapsed over the stall window. */
  elapsedMs: number;
  /** `process.cpuUsage()` delta measured over the same window. */
  cpuDelta: NodeJS.CpuUsage;
  /** `Date.now()` ms elapsed over the same window, for suspend detection. */
  wallElapsedMs: number;
}): string {
  const cpuMs = (params.cpuDelta.user + params.cpuDelta.system) / 1000;
  const cpuPercent =
    params.elapsedMs > 0 ? Math.round((cpuMs / params.elapsedMs) * 100) : 0;
  const rssMb = Math.round(process.memoryUsage.rss() / 1024 / 1024);
  const freeMb = Math.round(os.freemem() / 1024 / 1024);
  const wallDrift = Math.round(params.wallElapsedMs - params.elapsedMs);
  const load = os
    .loadavg()
    .map((value) => value.toFixed(1))
    .join('/');
  return `cpu=${cpuPercent}% (${Math.round(cpuMs)} ms) rss=${rssMb} MB freeMem=${freeMb} MB wallDrift=${wallDrift} ms load=${load}`;
}

/**
 * Per-process CPU and memory for the whole Electron app, heaviest first. When a
 * stall shows `cpu=0%`, this says whether another process of ours was the one
 * burning the core (a renderer, the GPU process, a utility process).
 */
export function describeAppMetrics(): string {
  try {
    return app
      .getAppMetrics()
      .map((metric) => ({
        label: metric.name ? `${metric.type}:${metric.name}` : metric.type,
        cpu: Math.round(metric.cpu?.percentCPUUsage ?? 0),
        mb: Math.round((metric.memory?.workingSetSize ?? 0) / 1024),
      }))
      .sort((a, b) => b.cpu - a.cpu)
      .slice(0, 4)
      .map((entry) => `${entry.label} cpu=${entry.cpu}% ws=${entry.mb} MB`)
      .join(', ');
  } catch {
    // Diagnostics must never change application behavior.
    return 'unavailable';
  }
}

/**
 * Operations currently in flight in the main process, by label, with the
 * monotonic time each started.
 *
 * A stall line says how long the loop was blocked but not what the app was
 * busy with. Naming the spans that were open at that moment closes that gap
 * without writing a start/end pair for every operation: the log stays sparse,
 * and a freeze still arrives annotated with its likely cause.
 */
const activeSpans = new Map<string, { label: string; startedAt: number }>();
let nextSpanId = 0;

/** Mark an operation as in flight. Call the returned function when it ends. */
export function beginPerformanceSpan(label: string): () => void {
  const id = `${label}#${(nextSpanId += 1)}`;
  activeSpans.set(id, { label, startedAt: performance.now() });
  return () => {
    activeSpans.delete(id);
  };
}

/** In-flight operations, longest-running first, for annotating a stall. */
export function describeActiveSpans(): string {
  if (activeSpans.size === 0) return 'none';
  const now = performance.now();
  return [...activeSpans.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(0, 6)
    .map((span) => `${span.label} (${Math.round(now - span.startedAt)} ms)`)
    .join(', ');
}
