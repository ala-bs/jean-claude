import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
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
