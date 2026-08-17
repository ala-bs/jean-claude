/**
 * Restarting the native app kills its Hermes CDP target, so the embedded React
 * Native DevTools view keeps rendering a dead session until something asks
 * Metro for targets again.
 *
 * The new target does not appear instantly: the app has to boot, connect to
 * Metro and register its inspector page. So we wait a beat, then poll Metro
 * until a target id we have not seen before shows up (or we give up).
 *
 * This only *detects* the new target — it must not mutate the DevTools query
 * cache, because every resolve mints a fresh `launchId` and the embedded view
 * reloads whenever its URL changes. The caller refetches once, at the end.
 */
export const DEVTOOLS_REATTACH_INITIAL_DELAY_MS = 2000;
export const DEVTOOLS_REATTACH_INTERVAL_MS = 2000;
export const DEVTOOLS_REATTACH_MAX_ATTEMPTS = 8;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export async function waitForDevToolsReattach({
  previousTargetIds,
  pollTargetIds,
  isCancelled = () => false,
  initialDelayMs = DEVTOOLS_REATTACH_INITIAL_DELAY_MS,
  intervalMs = DEVTOOLS_REATTACH_INTERVAL_MS,
  maxAttempts = DEVTOOLS_REATTACH_MAX_ATTEMPTS,
  sleep = defaultSleep,
}: {
  previousTargetIds: string[];
  /** Read-only probe of Metro's current target ids. Must not touch the cache. */
  pollTargetIds: () => Promise<string[]>;
  isCancelled?: () => boolean;
  initialDelayMs?: number;
  intervalMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<'reattached' | 'timeout' | 'cancelled'> {
  const seen = new Set(previousTargetIds);

  await sleep(initialDelayMs);
  if (isCancelled()) return 'cancelled';

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let targetIds: string[] = [];
    try {
      targetIds = await pollTargetIds();
    } catch {
      targetIds = [];
    }
    if (isCancelled()) return 'cancelled';
    if (targetIds.some((targetId) => !seen.has(targetId))) return 'reattached';

    if (attempt === maxAttempts - 1) break;
    await sleep(intervalMs);
    if (isCancelled()) return 'cancelled';
  }

  return 'timeout';
}
