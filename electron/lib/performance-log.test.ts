import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => mock.userData } }));

import { logPerformanceEvent } from './performance-log';

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
