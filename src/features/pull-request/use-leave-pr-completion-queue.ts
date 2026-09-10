import { useCallback } from 'react';

import {
  type PrCompletionQueueEntry,
  usePrCompletionQueueStore,
} from '@/stores/pr-completion-queue';
import { useBackgroundJobsStore } from '@/stores/background-jobs';

/**
 * Manual exit from the completion queue, shared by the PR chip and the queue
 * panel.
 *
 * Leaving the queue bypasses the driver's own settle path, so both loose ends
 * have to be tied off here: the background job the driver opened (running jobs
 * are never pruned from localStorage, so an unresolved one hangs forever) and
 * the live auto-complete on Azure's side.
 *
 * The `arming` window is deliberately NOT disarmed here — the PATCH is still in
 * flight, so a disarm now could be overtaken by it. The driver re-checks queue
 * membership once the PATCH resolves and disarms there instead.
 */
export function useLeavePrCompletionQueue() {
  const remove = usePrCompletionQueueStore((state) => state.remove);
  const markJobFailed = useBackgroundJobsStore((state) => state.markJobFailed);

  return useCallback(
    ({
      entry,
      disarm,
    }: {
      entry: PrCompletionQueueEntry;
      /** Sets auto-complete back off for this PR. */
      disarm: () => void;
    }) => {
      if (entry.status === 'armed') disarm();
      if (entry.jobId) markJobFailed(entry.jobId, 'Removed from the queue');
      remove(entry.id);
    },
    [markJobFailed, remove],
  );
}
