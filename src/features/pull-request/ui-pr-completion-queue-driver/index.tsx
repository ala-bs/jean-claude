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
  useRequeuePolicyEvaluation,
  useSetAutoComplete,
} from '@/hooks/use-pull-requests';
import type { AzureDevOpsPullRequestDetails } from '@/lib/api';
import type { AzureDevOpsPolicyEvaluation as AzurePolicyEvaluation } from '@/lib/api';
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

/**
 * How many consecutive fetched PR reads must report a blocking `mergeStatus`
 * before we treat it as real.
 *
 * Merging the head PR moves the target branch, which makes Azure recompute the
 * merge of every other PR that targets it. During that window a PR can read
 * back as `conflicts`/`failure` even though it merges cleanly moments later —
 * and the read sitting in the shared query cache when an entry is promoted can
 * predate the merge entirely. Acting on the first such read dropped the rest of
 * the queue one entry per promotion, in seconds. One confirming re-read
 * (`POLL_INTERVAL_MS` later, so after the recompute) is enough to tell a real
 * conflict from that transient.
 */
export const MERGE_BLOCKED_READS_BEFORE_TRUSTED = 2;

/**
 * Minimum `dataUpdatedAt` gap between two reads that both count toward the
 * thresholds above.
 *
 * The PR query key is shared with every other PR mutation, and each one writes
 * through `setQueryData` on success — a reviewer's vote re-stamps the cache with
 * whatever `mergeStatus` was already there. Without a time floor those writes
 * count as confirming reads, and a threshold of N is satisfied by one real poll
 * plus N-1 unrelated clicks. Slightly under `POLL_INTERVAL_MS`, so a poll that
 * fires a touch early still counts.
 */
export const MIN_COUNTED_READ_GAP_MS = POLL_INTERVAL_MS * 0.8;

/**
 * How many consecutive fetched policy reads must report a rejected blocking
 * policy before we treat it as real.
 *
 * Same hazard as `MERGE_BLOCKED_READS_BEFORE_TRUSTED`, one query over: the
 * policy-evaluation query key is shared with the PR details view, has a 30s
 * `staleTime`, and is only *enabled* once this entry arms — so the very first
 * value the runner sees is usually a cached read that predates arming. A build
 * that failed on an earlier iteration (or a check Azure is about to re-run)
 * sits in that snapshot as `rejected`, and acting on it skipped the PR the
 * instant it was promoted. That first value is therefore only a baseline; this
 * many reads a poll interval past it, all naming the SAME policy, are what
 * separate a genuinely failed check from a stale snapshot.
 */
export const REJECTED_POLICY_READS_BEFORE_TRUSTED = 2;

/**
 * Queue entries can be removed or reordered between render and an effect
 * running. Side effects must verify the store's current head, not rely only on
 * the parent having rendered this entry as the head.
 */
export function isCurrentProjectQueueHead({
  entries,
  projectId,
  entryId,
}: {
  entries: PrCompletionQueueEntry[];
  projectId: string;
  entryId: string;
}): boolean {
  return entries.find((entry) => entry.projectId === projectId)?.id === entryId;
}

/**
 * How many times the queue re-runs a *failed* required build policy before it
 * accepts the failure and skips the PR.
 *
 * Azure reports a policy as `rejected` for anything from a genuinely broken
 * build to an agent that lost its pool slot, a flaky test, or a run that was
 * cancelled when a previous merge moved the target branch. Those are the common
 * case, and every one of them is fixed by simply running the pipeline again —
 * which is exactly what the user did by hand ("retry a few times and it works").
 * Bounded, so a pipeline that fails for a real reason still settles instead of
 * rebuilding forever.
 */
export const MAX_AUTO_REQUEUES_PER_POLICY = 2;

/**
 * Extra confirming reads granted per failure re-run the queue has issued.
 *
 * A re-run needs time before Azure stops reporting the old failure: the PATCH
 * is accepted, but the evaluation can dwell on `rejected` until the new build
 * registers. Without this the poll that dispatched a re-run would immediately
 * count as a confirming read, and the PR could be skipped while the re-run it
 * just asked for was still executing.
 *
 * Deliberately a *window*, not a gate. Settlement must never be blocked on "a
 * retry is outstanding": Azure can accept a requeue and still never start a
 * build (superseded iteration, deleted definition), and an entry that waits for
 * a transition that never comes stalls its whole project queue — there is no
 * wall-clock timeout anywhere else to catch it. Worst case here is
 * `REJECTED + MAX * GRANTED` counted polls (~2.5 min) before the PR is skipped.
 */
export const READS_GRANTED_PER_FAILURE_RETRY = 4;

/** Azure statuses that mean "this pipeline ran, or tried to, and did not pass". */
function isFailedStatus(status: AzurePolicyEvaluation['status']): boolean {
  return status === 'rejected' || status === 'broken';
}

/**
 * Is this policy one the queue must actually wait on?
 *
 * Azure marking it non-blocking is the usual reason, and is what the pre-diff
 * check already covered. The `ignoredConfigIds` arm is a guard for one narrow
 * case: the waiver list snapshotted onto the entry at enqueue time is built
 * from policies that were non-blocking *then*, so if an admin flips one to
 * blocking while the PR sits in the queue, Azure still merges without it (the
 * PATCHed `autoCompleteIgnoreConfigIds` stands) and the queue must not skip the
 * PR over a check Azure has been told to ignore.
 */
export function isBlockingForQueue(
  evaluation: AzurePolicyEvaluation,
  ignoredConfigIds?: number[],
): boolean {
  if (!evaluation.isBlocking) return false;
  return !ignoredConfigIds?.includes(evaluation.configuration.id);
}

/**
 * Should the queue ask Azure to (re-)run this policy's pipeline right now?
 *
 * "Any pipeline that is not running and not green" — never run, expired for an
 * older commit, failed, or broken. A run already in flight and an approved run
 * are left alone. Failures are only retried while the entry still has budget.
 */
export function shouldAutoRequeue({
  evaluation,
  failureRetries,
  ignoredConfigIds,
}: {
  evaluation: AzurePolicyEvaluation;
  /** Failure re-runs already issued for this policy during this entry's turn. */
  failureRetries: number;
  ignoredConfigIds?: number[];
}): boolean {
  if (!evaluation.configuration.settings.buildDefinitionId) return false;
  if (!isBlockingForQueue(evaluation, ignoredConfigIds)) return false;
  // Azure can leave an expired pipeline in `running` (not only `queued`).
  // Its build belongs to an older commit, so it must be queued again.
  if (
    evaluation.context?.isExpired &&
    (evaluation.status === 'running' || evaluation.status === 'queued')
  ) {
    return true;
  }
  if (isFailedStatus(evaluation.status)) {
    return failureRetries < MAX_AUTO_REQUEUES_PER_POLICY;
  }
  if (evaluation.status !== 'queued') return false;
  // `queued` + a buildId means a run is already in flight — unless Azure
  // flagged it expired, handled above, in which case that build is for an old
  // commit.
  return !evaluation.context?.buildId;
}

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
  hasConfirmedMergeBlocked,
  rejectedPolicyName,
}: {
  pr: AzureDevOpsPullRequestDetails;
  /**
   * Whether a blocking policy has read back as rejected on enough consecutive
   * *fetched* reads to be trusted — see
   * `REJECTED_POLICY_READS_BEFORE_TRUSTED`.
   */
  hasRejectedBlockingPolicy: boolean;
  /** Name of that policy, for a toast the user can act on. */
  rejectedPolicyName?: string;
  /**
   * Whether a fetched PR has actually shown `autoCompleteSetBy` set since we
   * armed it. Guards against a pre-arm GET that was already in flight landing
   * on the shared query cache after our PATCH and masquerading as a cancel.
   */
  hasObservedArmed: boolean;
  /**
   * Whether the blocking `mergeStatus` has been seen on enough consecutive
   * reads to be trusted. A single one is not evidence: it can be a pre-arm read
   * or Azure's transient recompute right after the previous PR merged.
   */
  hasConfirmedMergeBlocked: boolean;
}): Settlement | null {
  if (pr.status === 'completed') {
    return { outcome: 'succeeded', reason: 'merged' };
  }
  if (pr.status === 'abandoned') {
    return { outcome: 'failed', reason: 'PR was abandoned' };
  }
  if (hasConfirmedMergeBlocked && pr.mergeStatus === 'conflicts') {
    return { outcome: 'failed', reason: 'merge conflicts with the target branch' };
  }
  if (hasConfirmedMergeBlocked && pr.mergeStatus === 'failure') {
    return { outcome: 'failed', reason: 'Azure DevOps could not merge the PR' };
  }
  // Azure clears `autoCompleteSetBy` when it gives up on the PR (rejected vote,
  // hard policy failure). Only trust that once we've seen the armed value come
  // back at least once, or a stale pre-arm read would fail the entry instantly.
  if (hasObservedArmed && !pr.autoCompleteSetBy) {
    return { outcome: 'failed', reason: 'auto-complete was cancelled' };
  }
  if (hasRejectedBlockingPolicy) {
    return {
      outcome: 'failed',
      reason: rejectedPolicyName
        ? `required check failed (${rejectedPolicyName})`
        : 'a required check failed',
    };
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

  // `dataUpdatedAt` — not the object identity — is what marks a fetch as new.
  // React Query's structural sharing (on by default) hands back the PREVIOUS
  // object whenever the refetched PR is deeply equal, which is the normal case
  // for a PR sitting in a steady state. Counting identities alone would freeze
  // every read counter at 1 and wedge the entry forever.
  const { data: pr, dataUpdatedAt: prFetchedAt } = usePullRequest(
    projectId,
    prId,
    repoInfo,
  );
  const { data: evaluations = [], dataUpdatedAt: evaluationsFetchedAt } =
    usePullRequestPolicyEvaluations(
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

  const isCurrentQueueHead = useCallback(
    () =>
      isCurrentProjectQueueHead({
        entries: usePrCompletionQueueStore.getState().entries,
        projectId,
        entryId: entry.id,
      }),
    [entry.id, projectId],
  );

  // Arm the head exactly once.
  const armStartedRef = useRef(false);
  useEffect(() => {
    if (entry.status !== 'waiting') return;
    if (armStartedRef.current) return;
    if (!isCurrentQueueHead()) return;

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
    isCurrentQueueHead,
    markJobFailed,
    pr,
    prId,
    projectId,
    remove,
    setJobId,
    setStatus,
  ]);

  // Kick off (or re-run) the required CI the PR still owes, once it is this
  // entry's turn. Azure leaves manual/expired build policies at
  // `status: 'queued'` with no `context.buildId`, and a failed run just sits
  // there as `rejected`; in both cases auto-complete never fires, so the queue
  // either stalls on the head entry or skips a PR whose pipeline only needed
  // running again.
  const requeueMutation = useRequeuePolicyEvaluation(projectId, prId, repoInfo);
  // Tracks evaluations we already asked Azure to run, keyed by *configuration*
  // id — Azure can hand back a new `evaluationId` once a policy is re-run, and
  // a per-evaluation key would reset the retry budget on every attempt.
  // Deliberately NOT a "requeued once, ever" list: the marker is dropped again
  // as soon as the evaluation stops looking like it needs a run, so a policy
  // that re-expires later (a push to the source branch while the PR sits armed)
  // gets run again, and a requeue that errored is retried on the next poll
  // instead of wedging the queue.
  const requeuedConfigIdsRef = useRef<Set<number>>(new Set());
  // Failure retries issued per configuration during this entry's turn.
  //
  // Counts ONLY the `rejected`/`broken` re-runs, never the "start a build
  // nobody started" or "the run expired, redo it" requeues — those are not
  // retries of a failure, and letting them share the budget silently spent it
  // before the first real failure (a manual-trigger policy that gets kicked off
  // and then fails would have had one retry instead of two; two source-branch
  // pushes would have left it none).
  //
  // Never decremented, not even when the PATCH fails. A refund would make the
  // budget infinite: an evaluation Azure always refuses to requeue (deleted
  // build definition, missing queue-builds permission) would be retried on
  // every poll forever, and — because a retryable failure defers settlement —
  // the entry would never settle and the whole project queue would stall behind
  // it.
  const failureRetriesRef = useRef<Map<number, number>>(new Map());
  const requeueRef = useRef(requeueMutation);
  useEffect(() => {
    requeueRef.current = requeueMutation;
  }, [requeueMutation]);
  useEffect(() => {
    if (!isArmed || !isCurrentQueueHead()) return;
    for (const evaluation of evaluations) {
      const configId = evaluation.configuration.id;
      const { evaluationId } = evaluation;
      const retries = failureRetriesRef.current.get(configId) ?? 0;
      if (
        !shouldAutoRequeue({
          evaluation,
          failureRetries: retries,
          ignoredConfigIds: entry.completionOptions?.autoCompleteIgnoreConfigIds,
        })
      ) {
        requeuedConfigIdsRef.current.delete(configId);
        continue;
      }
      if (requeuedConfigIdsRef.current.has(configId)) continue;
      requeuedConfigIdsRef.current.add(configId);
      if (isFailedStatus(evaluation.status)) {
        failureRetriesRef.current.set(configId, retries + 1);
        addToast({
          // The toast store only knows success/error, and this is not a
          // failure the user has to act on — the queue is handling it.
          type: 'success',
          message: `PR !${prId}: re-running failed check "${
            evaluation.configuration.settings.displayName ??
            evaluation.configuration.type.displayName
          }" (run ${retries + 2} of ${MAX_AUTO_REQUEUES_PER_POLICY + 1})`,
        });
      }
      // Use a separate promise for each policy. React Query replaces per-call
      // callbacks when multiple mutate calls share one mutation observer, so a
      // failed earlier PATCH could otherwise leave its marker stuck forever.
      void requeueRef.current
        .mutateAsync({ evaluationId })
        .catch(() => {
          // Only the in-flight marker is rolled back, so the next poll can try
          // again — the spent retry stays spent (see `failureRetriesRef`).
          requeuedConfigIdsRef.current.delete(configId);
        });
    }
  }, [
    addToast,
    entry.completionOptions?.autoCompleteIgnoreConfigIds,
    evaluations,
    isCurrentQueueHead,
    isArmed,
    prId,
  ]);

  // Watch the armed PR for a terminal state.
  const hasObservedArmedRef = useRef(false);
  const unarmedReadsRef = useRef(0);
  const mergeBlockedReadsRef = useRef(0);
  const lastCountedPrRef = useRef<AzureDevOpsPullRequestDetails | undefined>(
    undefined,
  );
  const lastCountedFetchedAtRef = useRef(0);
  const rejectedPolicyReadsRef = useRef(0);
  const lastRejectedEvaluationIdRef = useRef<string | undefined>(undefined);
  const lastCountedEvaluationsFetchedAtRef = useRef(0);
  useEffect(() => {
    if (!isArmed || !pr) return;

    // Count POLLS, not effect runs and not cache writes. Two traps here:
    //
    // 1. `settle` depends on the mutation object, whose identity changes every
    //    render, so this effect re-runs constantly. Counting runs would blow
    //    through the thresholds in milliseconds.
    // 2. Object identity is wrong in BOTH directions. Structural sharing hands
    //    back the previous object for a deeply-equal refetch (so a PR resting in
    //    a steady state would never count a second read and could never settle),
    //    while every sibling mutation sharing this query key — a reviewer's vote,
    //    publish, draft toggle — writes a NEW object through `setQueryData`
    //    carrying the same stale `mergeStatus` it had before.
    //
    // So a read only counts once a poll interval has elapsed since the last
    // counted one. That is the only thing an incidental cache write cannot fake,
    // and the poll timer guarantees it always eventually arrives.
    const isFirstRead = lastCountedPrRef.current === undefined;
    const isNewPoll = isFirstRead
      ? true
      : prFetchedAt > 0
        ? prFetchedAt - lastCountedFetchedAtRef.current >= MIN_COUNTED_READ_GAP_MS
        : pr !== lastCountedPrRef.current;
    if (isNewPoll) {
      lastCountedPrRef.current = pr;
      lastCountedFetchedAtRef.current = prFetchedAt;
      if (pr.autoCompleteSetBy) {
        hasObservedArmedRef.current = true;
        unarmedReadsRef.current = 0;
      } else {
        unarmedReadsRef.current += 1;
      }
      if (pr.mergeStatus === 'conflicts' || pr.mergeStatus === 'failure') {
        mergeBlockedReadsRef.current += 1;
      } else {
        mergeBlockedReadsRef.current = 0;
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

    // Optional and user-waived policies never block the merge on Azure's side,
    // so they can never skip the PR here either.
    //
    // A policy the queue is retrying is deliberately NOT excluded: excluding it
    // coupled settlement to the retry machinery, and every way that machinery
    // can get stuck (a PATCH Azure always refuses, an evaluation that dwells on
    // `rejected` so the in-flight marker is never cleared) became a permanent
    // stall of the entire project queue. Instead the retry buys a bounded grace
    // window in the threshold below — progress is guaranteed either way.
    const rejectedPolicy = evaluations.find(
      (evaluation) =>
        isBlockingForQueue(
          evaluation,
          entry.completionOptions?.autoCompleteIgnoreConfigIds,
        ) &&
        evaluation.status === 'rejected' &&
        !evaluation.context?.isExpired,
    );

    // The count must survive only for ONE specific policy staying rejected.
    // `find` returns whichever blocking rejection Azure lists first, so without
    // this, policy A rejected on poll 1 and an unrelated policy B rejected on
    // poll 2 would add up to a "confirmed" failure neither of them earned.
    // Resetting also happens off-cadence on purpose: a read showing no
    // rejection is proof the check recovered, even if it is too close to the
    // last counted one to count as confirmation.
    const rejectedEvaluationId = rejectedPolicy?.evaluationId;
    if (rejectedEvaluationId !== lastRejectedEvaluationIdRef.current) {
      lastRejectedEvaluationIdRef.current = rejectedEvaluationId;
      rejectedPolicyReadsRef.current = 0;
    }

    // Each re-run the queue issued for this policy widens the window before its
    // rejection is trusted, so a re-run in flight is never mistaken for a
    // settled failure. Bounded, so the entry always settles eventually.
    const rejectedPolicyReadsRequired =
      REJECTED_POLICY_READS_BEFORE_TRUSTED +
      (rejectedPolicy
        ? (failureRetriesRef.current.get(rejectedPolicy.configuration.id) ?? 0) *
          READS_GRANTED_PER_FAILURE_RETRY
        : 0);

    // Same staleness trap as `mergeStatus`, but worse: this query is only
    // *enabled* when the entry arms, so the value present on the first pass is
    // whatever the PR details view left in the cache — possibly minutes old,
    // with no fetch of our own behind it. `dataUpdatedAt` says "the cache was
    // written then", not "this runner saw a poll". So the first read is taken
    // as a BASELINE and never counted; only reads a poll interval past it do.
    if (evaluationsFetchedAt > 0) {
      const isBaselineRead = lastCountedEvaluationsFetchedAtRef.current === 0;
      const isNewEvaluationsPoll =
        evaluationsFetchedAt - lastCountedEvaluationsFetchedAtRef.current >=
        MIN_COUNTED_READ_GAP_MS;
      if (isBaselineRead) {
        lastCountedEvaluationsFetchedAtRef.current = evaluationsFetchedAt;
      } else if (isNewEvaluationsPoll) {
        lastCountedEvaluationsFetchedAtRef.current = evaluationsFetchedAt;
        if (rejectedPolicy) {
          rejectedPolicyReadsRef.current += 1;
          console.warn(
            `[pr-queue] !${prId}: blocking policy "${
              rejectedPolicy.configuration.settings.displayName ??
              rejectedPolicy.configuration.type.displayName
            }" read as rejected (${rejectedPolicyReadsRef.current}/${rejectedPolicyReadsRequired} confirming reads)`,
            rejectedPolicy,
          );
        }
      }
    }
    const hasRejectedBlockingPolicy =
      !!rejectedPolicy &&
      rejectedPolicyReadsRef.current >= rejectedPolicyReadsRequired;

    const settlement = resolveArmedPrSettlement({
      pr,
      hasRejectedBlockingPolicy,
      rejectedPolicyName:
        rejectedPolicy?.configuration.settings.displayName ??
        rejectedPolicy?.configuration.type.displayName,
      hasObservedArmed: trustMissingAutoComplete,
      hasConfirmedMergeBlocked:
        mergeBlockedReadsRef.current >= MERGE_BLOCKED_READS_BEFORE_TRUSTED,
    });
    if (settlement) settle(settlement);
  }, [
    entry.completionOptions?.autoCompleteIgnoreConfigIds,
    evaluations,
    evaluationsFetchedAt,
    isArmed,
    pr,
    prFetchedAt,
    prId,
    settle,
  ]);

  return null;
}
