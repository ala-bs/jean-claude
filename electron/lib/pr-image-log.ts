import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { app } from 'electron';

/**
 * Durable, file-backed diagnostics for the two-phase PR description image
 * upload (stage to disk -> create PR -> upload attachments -> PATCH body).
 *
 * `dbg.*` only reaches stdout and the in-app log viewer, both of which are gone
 * by the time a user reports "my images vanished". This writes the same events
 * to `<userData>/logs/pr-image-upload.log` so a repro can be read back later.
 *
 * Deliberately best-effort: this sits on the PR-creation path, so a failing
 * write must never surface to the caller.
 */
export async function logPrImageEvent(params: {
  source: string;
  message: string;
  data?: unknown;
}): Promise<void> {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    await mkdir(dir, { recursive: true });
    let data = '';
    if (params.data !== undefined) {
      try {
        data = ` ${JSON.stringify(params.data)?.slice(0, 4000) ?? ''}`;
      } catch {
        data = ' [unserializable]';
      }
    }
    await appendFile(
      path.join(dir, 'pr-image-upload.log'),
      `${new Date().toISOString()} ${params.source} ${params.message}${data}\n`,
      'utf-8',
    );
  } catch {
    // Diagnostics only.
  }
}

/** Fire-and-forget variant for call sites that must not await. */
export function logPrImageEventSync(params: {
  source: string;
  message: string;
  data?: unknown;
}): void {
  void logPrImageEvent(params);
}
