// Walks the per-project PR completion queue, one PR at a time.
//
// Mounted once at the app root. For every project that has queued entries it
// mounts a runner for that project's HEAD entry only — arming it against Azure
// DevOps, then polling until the PR reaches a terminal state. On settle the
// entry is dropped, which promotes the next one. Failures never stop the queue.

import { useCallback, useEffect, useRef } from 'react';

import {
  type PrCompletionQueueEntry,
  usePrCompletionQueueProjectIds,
  usePrCompletionQueueStore,
} from '@/stores/pr-completion-queue';
import {
  useInvalidatePullRequestDetails,
  usePullRequest,
  usePullRequestPolicyEvaluations,
  useSetAutoComplete,
} from '@/hooks/use-pull-requests';
import type { AzureDevOpsPullRequestDetails } from '@/lib/api';
import { useBackgroundJobsStore } from '@/stores/background-jobs';
import { useProject } from '@/hooks/use-projects';
import { useToastStore } from '@/stores/toasts';


/**
 * How often the armed PR is re-checked. PR pipelines usually take minutes, so
 * this is slow enough not to hammer Azure but fast enough that the next PR in
 * the queue starts within a few seconds of the current one merging.
 */
export const POLL_INTERVAL_MS = 15_000;

/**
 * How many consecutive polls may show no `autoCompleteSetBy` before we believe
 * it, even though we never saw the armed value land. Bounds the stale-read
 * guard so a wedged entry can't block its project's queue forever.
 */
export const UNARMED_READS_BEFORE_TRUSTED = 4;

type Settlement = {
  outcome: 'succeeded' | 'failed';
  reason: string;
};

/**
 * Decide whether an armed PR has finished its turn.
 *
 * Returns null while the PR is still in flight. Order matters: a completed PR
 * is reported as merged even if a stale policy evaluation still looks rejected.
 */
export function resolveArmedPrSettlement({
  pr,
  hasRejectedBlockingPolicy,
  hasObservedArmed,
}: {
  pr: AzureDevOpsPullRequestDetails;
  hasRejectedBlockingPolicy: boolean;
  /**
   * Whether a fetched PR has actually shown `autoCompleteSetBy` set since we
   * armed it. Guards against a pre-arm GET that was already in flight landing
   * on the shared query cache after our PATCH and masquerading as a cancel.
   */
  hasObservedArmed: boolean;
}): Settlement | null {
  if (pr.status === 'completed') {
    return { outcome: 'succeeded', reason: 'merged' };
  }
  if (pr.status === 'abandoned') {
    return { outcome: 'failed', reason: 'PR was abandoned' };
  }
  if (pr.mergeStatus === 'conflicts') {
    return { outcome: 'failed', reason: 'merge conflicts with the target branch' };
  }
  if (pr.mergeStatus === 'failure') {
    return { outcome: 'failed', reason: 'Azure DevOps could not merge the PR' };
  }
  // Azure clears `autoCompleteSetBy` when it gives up on the PR (rejected vote,
  // hard policy failure). Only trust that once we've seen the armed value come
  // back at least once, or a stale pre-arm read would fail the entry instantly.
  if (hasObservedArmed && !pr.autoCompleteSetBy) {
    return { outcome: 'failed', reason: 'auto-complete was cancelled' };
  }
  if (hasRejectedBlockingPolicy) {
    return { outcome: 'failed', reason: 'a required check failed' };
  }
  return null;
}

export function PrCompletionQueueDriver() {
  const projectIds = usePrCompletionQueueProjectIds();

  return (
    <>
      {projectIds.map((projectId) => (
        <ProjectQueueRunner key={projectId} projectId={projectId} />
      ))}
    </>
  );
}

function ProjectQueueRunner({ projectId }: { projectId: string }) {
  const entries = usePrCompletionQueueStore((state) => state.entries);
  const clearProject = usePrCompletionQueueStore((state) => state.clearProject);
  const markJobFailed = useBackgroundJobsStore((state) => state.markJobFailed);
  const { data: project } = useProject(projectId);
  const head = entries.find((e) => e.projectId === projectId);

  // Turning the setting off has to drain the queue, or entries enqueued while
  // it was on would keep getting armed later with no UI saying why. Anything
  // already armed keeps its auto-complete — only the queueing stops.
  const isQueueDisabled = !!project && !project.queuePrAutoComplete;
  useEffect(() => {
    if (!isQueueDisabled) return;
    for (const queued of usePrCompletionQueueStore.getState().entries) {
      if (queued.projectId === projectId && queued.jobId) {
        markJobFailed(queued.jobId, 'PR completion queue was turned off');
      }
    }
    clearProject(projectId);
  }, [clearProject, isQueueDisabled, markJobFailed, projectId]);

  if (!head || isQueueDisabled) return null;

  // Keyed by entry id so every promotion gets a fresh runner: the previous
  // entry's polling queries and one-shot arm effect must not leak into it.
  return <QueueEntryRunner key={head.id} entry={head} />;
}

function QueueEntryRunner({ entry }: { entry: PrCompletionQueueEntry }) {
  const { projectId, prId, repoInfo } = entry;
  const remove = usePrCompletionQueueStore((state) => state.remove);
  const setStatus = usePrCompletionQueueStore((state) => state.setStatus);
  const setJobId = usePrCompletionQueueStore((state) => state.setJobId);
  const addRunningJob = useBackgroundJobsStore((state) => state.addRunningJob);
  const markJobSucceeded = useBackgroundJobsStore(
    (state) => state.markJobSucceeded,
  );
  const markJobFailed = useBackgroundJobsStore((state) => state.markJobFailed);
  const addToast = useToastStore((state) => state.addToast);

  const autoCompleteMutation = useSetAutoComplete(projectId, prId, repoInfo);
  const isArmed = entry.status === 'armed';

  const { data: pr } = usePullRequest(projectId, prId, repoInfo);
  const { data: evaluations = [] } = usePullRequestPolicyEvaluations(
    projectId,
    prId,
    { refetchInterval: isArmed ? POLL_INTERVAL_MS : false, enabled: isArmed },
    repoInfo,
  );

  // The PR query is shared app-wide and has no interval of its own, so the
  // runner drives its own refetch cadence while this entry is armed.
  const invalidatePr = useInvalidatePullRequestDetails(projectId, prId, repoInfo);
  // Held in a ref because its identity changes every render (the resolved repo
  // info is a fresh object literal). Depending on it directly would reset the
  // interval on every render, so the poll would never actually fire.
  const invalidatePrRef = useRef(invalidatePr);
  useEffect(() => {
    invalidatePrRef.current = invalidatePr;
  }, [invalidatePr]);

  useEffect(() => {
    if (!isArmed) return;
    const timer = setInterval(() => invalidatePrRef.current(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isArmed]);

  const settle = useCallback(
    ({ outcome, reason }: Settlement) => {
      // A failed turn does NOT mean Azure dropped the auto-complete. Conflicts
      // and rejected checks leave it armed, so the PR would merge on its own
      // later — while the next queued PR is already armed too. That is exactly
      // the multi-armed-PR pileup this feature exists to prevent, so disarm
      // before handing the queue over.
      if (outcome === 'failed' && pr?.status === 'active' && pr.autoCompleteSetBy) {
        autoCompleteMutation.mutate({ enabled: false });
      }
      if (entry.jobId) {
        if (outcome === 'succeeded') {
          markJobSucceeded(entry.jobId);
        } else {
          markJobFailed(entry.jobId, reason);
        }
      }
      addToast({
        type: outcome === 'succeeded' ? 'success' : 'error',
        message:
          outcome === 'succeeded'
            ? `PR !${prId} merged — moving to the next queued PR`
            : `PR !${prId} skipped: ${reason}`,
      });
      // Dropping the entry promotes the next one. Always — a failure must not
      // stall the rest of the queue.
      remove(entry.id);
    },
    [
      addToast,
      autoCompleteMutation,
      entry.id,
      entry.jobId,
      markJobFailed,
      markJobSucceeded,
      pr,
      prId,
      remove,
    ],
  );

  const disarm = useCallback(() => {
    autoCompleteMutation.mutate(
      { enabled: false },
      {
        onError: () => {
          addToast({
            type: 'error',
            message: `Could not clear auto-complete on !${prId} — check it in Azure DevOps`,
          });
        },
      },
    );
  }, [addToast, autoCompleteMutation, prId]);

  /** Is this PR still queued at all — under this entry or a re-queued one? */
  const isStillQueued = useCallback(
    () =>
      usePrCompletionQueueStore
        .getState()
        .entries.some((e) => e.projectId === projectId && e.prId === prId),
    [prId, projectId],
  );

  // Arm the head exactly once.
  const armStartedRef = useRef(false);
  useEffect(() => {
    if (entry.status !== 'waiting') return;
    if (armStartedRef.current) return;

    // Only the head is polled, so an entry can sit in line while its PR is
    // merged or abandoned elsewhere (Azure web UI, another client). Arming that
    // would just make Azure error and surface a confusing "skipped" toast.
    if (pr && pr.status !== 'active') {
      armStartedRef.current = true;
      addToast({
        type: pr.status === 'completed' ? 'success' : 'error',
        message: `PR !${prId} is already ${pr.status} — moving to the next queued PR`,
      });
      remove(entry.id);
      return;
    }

    armStartedRef.current = true;

    const jobId = addRunningJob({
      type: 'pr-auto-complete',
      title: `Auto-completing !${prId}`,
      projectId,
      details: { prId, prTitle: entry.prTitle },
    });
    setJobId(entry.id, jobId);
    setStatus(entry.id, 'arming');

    autoCompleteMutation
      .mutateAsync({
        enabled: true,
        autoCompleteSetById: entry.autoCompleteSetById,
        completionOptions: entry.completionOptions,
      })
      .then(() => {
        // The user can leave the queue while the PATCH is in flight. Cancelling
        // there would race this call, so the cancel path leaves `arming` alone
        // and we undo it here, once Azure has definitely accepted it.
        if (!isStillQueued()) {
          // Checked by PR identity, not entry id: if the user left and then
          // re-queued the same PR, that new entry wants it armed, so disarming
          // here would sabotage it.
          disarm();
          return;
        }
        setStatus(entry.id, 'armed');
      })
      .catch((error: unknown) => {
        // A rejected PATCH is ambiguous — Azure may have applied it and lost
        // the response. Leaving it armed while the next PR arms too is the very
        // pileup this queue prevents, so disarm defensively; disarming a PR
        // that was never armed is a harmless no-op.
        disarm();

        if (!isStillQueued()) return;
        const reason =
          error instanceof Error ? error.message : 'could not set auto-complete';
        markJobFailed(jobId, reason);
        addToast({ type: 'error', message: `PR !${prId} skipped: ${reason}` });
        remove(entry.id);
      });
  }, [
    addRunningJob,
    addToast,
    autoCompleteMutation,
    entry.autoCompleteSetById,
    entry.completionOptions,
    entry.id,
    entry.prTitle,
    entry.status,
    disarm,
    isStillQueued,
    markJobFailed,
    pr,
    prId,
    projectId,
    remove,
    setJobId,
    setStatus,
  ]);

  // Watch the armed PR for a terminal state.
  const hasObservedArmedRef = useRef(false);
  const unarmedReadsRef = useRef(0);
  const lastCountedPrRef = useRef<AzureDevOpsPullRequestDetails | undefined>(
    undefined,
  );
  useEffect(() => {
    if (!isArmed || !pr) return;

    // Count distinct fetched PRs, NOT effect runs. `settle` depends on the
    // mutation object, whose identity changes every render, so this effect
    // re-runs constantly — counting runs would blow through the threshold in
    // milliseconds and reinstate the false-cancellation bug it guards against.
    if (pr !== lastCountedPrRef.current) {
      lastCountedPrRef.current = pr;
      if (pr.autoCompleteSetBy) {
        hasObservedArmedRef.current = true;
        unarmedReadsRef.current = 0;
      } else {
        unarmedReadsRef.current += 1;
      }
    }
    // The "wait until we've seen it armed" guard absorbs a stale pre-arm read,
    // but on its own it can wedge: if that stale read is the only one we ever
    // get and the user then cancels in the Azure UI, no condition ever fires
    // and the whole project queue stalls behind this entry. Consecutive
    // unarmed reads are not a stale-cache artifact, so after a few we trust it.
    const trustMissingAutoComplete =
      hasObservedArmedRef.current ||
      unarmedReadsRef.current >= UNARMED_READS_BEFORE_TRUSTED;

    const hasRejectedBlockingPolicy = evaluations.some(
      (evaluation) =>
        evaluation.isBlocking &&
        evaluation.status === 'rejected' &&
        !evaluation.context?.isExpired,
    );

    const settlement = resolveArmedPrSettlement({
      pr,
      hasRejectedBlockingPolicy,
      hasObservedArmed: trustMissingAutoComplete,
    });
    if (settlement) settle(settlement);
  }, [evaluations, isArmed, pr, settle]);

  return null;
}
