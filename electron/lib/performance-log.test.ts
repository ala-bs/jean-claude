import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  userData: '',
  appMetrics: [] as unknown[],
}));
vi.mock('electron', () => ({
  app: { getPath: () => mock.userData, getAppMetrics: () => mock.appMetrics },
}));

import {
  beginPerformanceSpan,
  describeActiveSpans,
  describeAppMetrics,
  describeProcessLoad,
  logPerformanceEvent,
} from './performance-log';

const testDir = '/jc-performance-log-test';

it('persists concurrent events in order', async () => {
  mock.userData = testDir;
  await mkdir(testDir, { recursive: true });

  await Promise.all([
    logPerformanceEvent({ source: 'renderer', message: 'IPC tasks:findAll took 600 ms' }),
    logPerformanceEvent({ source: 'main', message: 'Main event loop delayed by 400 ms' }),
  ]);

  const content = await readFile(path.join(testDir, 'logs', 'performance.log'), 'utf-8');
  expect(content).toMatch(/renderer IPC tasks:findAll took 600 ms\n.*main Main event loop delayed by 400 ms\n$/s);
});

it('rotates a full log before appending the next event', async () => {
  mock.userData = testDir;
  const logDir = path.join(testDir, 'logs');
  await mkdir(logDir, { recursive: true });
  await writeFile(path.join(logDir, 'performance.log'), 'x'.repeat(2 * 1024 * 1024));

  await logPerformanceEvent({ source: 'database', message: 'Slow query (120 ms): select ?' });

  expect(await readFile(path.join(logDir, 'performance.log.1'), 'utf-8')).toHaveLength(2 * 1024 * 1024);
  expect(await readFile(path.join(logDir, 'performance.log'), 'utf-8')).toContain('database Slow query (120 ms): select ?');
});

// The point of these fields is to tell "our code blocked the loop" apart from
// "the OS never scheduled us", so the CPU share is what the assertions pin.
it('reports a stall that burned CPU as our own blocking work', () => {
  const load = describeProcessLoad({
    elapsedMs: 1000,
    // 1000 ms of CPU across a 1000 ms stall: the process was running.
    cpuDelta: { user: 800_000, system: 200_000 },
    wallElapsedMs: 1000,
  });

  expect(load).toContain('cpu=100% (1000 ms)');
  expect(load).toContain('wallDrift=0 ms');
});

it('reports a stall that burned no CPU as external starvation', () => {
  const load = describeProcessLoad({
    elapsedMs: 47_000,
    cpuDelta: { user: 0, system: 0 },
    // The wall clock ran far ahead of the monotonic clock: the host suspended.
    wallElapsedMs: 59_000,
  });

  expect(load).toContain('cpu=0% (0 ms)');
  expect(load).toContain('wallDrift=12000 ms');
});

it('names the in-flight operations and forgets them once they end', () => {
  expect(describeActiveSpans()).toBe('none');

  const endSpan = beginPerformanceSpan('ipc:tasks:createWithWorktree');
  expect(describeActiveSpans()).toContain('ipc:tasks:createWithWorktree');

  endSpan();
  expect(describeActiveSpans()).toBe('none');
});

it('keeps concurrent spans of the same label distinct', () => {
  const endFirst = beginPerformanceSpan('ipc:feed:getTaskItems');
  const endSecond = beginPerformanceSpan('ipc:feed:getTaskItems');

  endFirst();
  // Ending one must not clear the other, or a stall would under-report.
  expect(describeActiveSpans()).toContain('ipc:feed:getTaskItems');

  endSecond();
  expect(describeActiveSpans()).toBe('none');
});

it('ranks app processes by CPU so the busiest one is visible', () => {
  mock.appMetrics = [
    { type: 'Browser', cpu: { percentCPUUsage: 12 }, memory: { workingSetSize: 204_800 } },
    { type: 'Tab', name: 'Jean-Claude', cpu: { percentCPUUsage: 97 }, memory: { workingSetSize: 512_000 } },
  ];

  expect(describeAppMetrics()).toBe(
    'Tab:Jean-Claude cpu=97% ws=500 MB, Browser cpu=12% ws=200 MB',
  );
});

it('reports app metrics as unavailable rather than throwing', () => {
  mock.appMetrics = undefined as never;

  expect(describeAppMetrics()).toBe('unavailable');
});
