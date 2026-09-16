// @vitest-environment happy-dom
/* eslint-disable sort-imports */

// Integration coverage for the driver's EFFECT ORCHESTRATION — the arm/settle/
// promote cycle. `index.test.ts` only covers the pure settlement decision; every
// bug found in review so far lived in this async wiring instead, so it is
// exercised here against the real queue store with the Azure hooks mocked.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AzureDevOpsPullRequestDetails } from '@/lib/api';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

/** Mutable state the mocked hooks read from, keyed by PR id. */
const prs = new Map<number, AzureDevOpsPullRequestDetails>();
/**
 * `dataUpdatedAt` per PR, as react-query reports it.
 *
 * Mirrors structural sharing: a refetch that returns deeply-equal data hands
 * back the PREVIOUS object, so only this timestamp marks the read as new. Tests
 * that want a fresh read must go through `setPr`, never `prs.set`.
 */
const prFetchedAt = new Map<number, number>();
/**
 * Wall clock the fake `dataUpdatedAt` stamps come from. Advanced by a full poll
 * interval per fetch, because the driver only counts reads that are a poll
 * apart — a test clock ticking by 1ms would count none of them.
 */
let fetchClock = 1_000_000;

/** Record a poll of `pr`, bumping its `dataUpdatedAt` like react-query does. */
function setPr(prId: number, pr: AzureDevOpsPullRequestDetails) {
  fetchClock += POLL_INTERVAL_MS;
  prs.set(prId, pr);
  prFetchedAt.set(prId, fetchClock);
}

/**
 * A cache write from a sibling mutation on the SAME query key — a reviewer's
 * vote, a publish — which re-stamps `dataUpdatedAt` with a new object carrying
 * the same PR state, without any poll having happened.
 */
function cacheWriteSamePr(prId: number, pr: AzureDevOpsPullRequestDetails) {
  fetchClock += 50;
  prs.set(prId, pr);
  prFetchedAt.set(prId, fetchClock);
}

/**
 * A refetch that returned deeply-equal data: react-query's structural sharing
 * keeps the previous object, so ONLY `dataUpdatedAt` moves. This is the normal
 * case for a PR resting in a steady state, and the shape that wedges any read
 * counter keyed on object identity.
 */
function refetchSamePr(prId: number) {
  fetchClock += POLL_INTERVAL_MS;
  prFetchedAt.set(prId, fetchClock);
}
let queueEnabled = true;
const setAutoComplete = vi.fn();
const invalidatePr = vi.fn();
const requeueCi = vi.fn();
/** Policy evaluations the mocked hook serves to the armed entry's runner. */
let policyEvaluations: unknown[] = [];
/** Resolver for the in-flight arm PATCH, so tests control its timing. */
let armDeferred: {
  resolve: (pr: AzureDevOpsPullRequestDetails) => void;
  reject: (error: Error) => void;
} | null = null;

vi.mock('@/hooks/use-pull-requests', () => ({
  useSetAutoComplete: (_projectId: string, prId: number) => ({
    mutate: (params: { enabled: boolean }) => {
      setAutoComplete({ prId, ...params });
    },
    mutateAsync: (params: { enabled: boolean }) => {
      setAutoComplete({ prId, ...params });
      return new Promise<AzureDevOpsPullRequestDetails>((resolve, reject) => {
        armDeferred = { resolve, reject };
      });
    },
    isAnyPending: false,
  }),
  usePullRequest: (_projectId: string, prId: number) => ({
    data: prs.get(prId),
    dataUpdatedAt: prFetchedAt.get(prId) ?? 0,
  }),
  usePullRequestPolicyEvaluations: () => ({ data: policyEvaluations }),
  useRequeuePolicyEvaluation: () => ({
    // Mirrors react-query: a rejected mutation surfaces through `onError`
    // rather than throwing out of the caller.
    mutate: (
      params: { evaluationId: string },
      options?: { onError?: (error: unknown) => void },
    ) => {
      try {
        requeueCi(params.evaluationId);
      } catch (error) {
        options?.onError?.(error);
      }
    },
    isPending: false,
  }),
  // The real hook returns a NEW function identity on every render (its resolved
  // repo info is a fresh object literal). Mirrored here so the poll-interval
  // test exercises that, while calls land on one shared spy.
  useInvalidatePullRequestDetails: () => () => invalidatePr(),
}));

vi.mock('@/hooks/use-projects', () => ({
  useProject: () => ({ data: { queuePrAutoComplete: queueEnabled } }),
}));

const {
  PrCompletionQueueDriver,
  POLL_INTERVAL_MS,
  UNARMED_READS_BEFORE_TRUSTED,
} = await import('.');
const { usePrCompletionQueueStore } = await import(
  '@/stores/pr-completion-queue'
);
const { useBackgroundJobsStore } = await import('@/stores/background-jobs');

function makePr(
  id: number,
  overrides: Partial<AzureDevOpsPullRequestDetails> = {},
): AzureDevOpsPullRequestDetails {
  return {
    id,
    title: `PR ${id}`,
    status: 'active',
    isDraft: false,
    createdBy: { id: 'u1', displayName: 'Dev', uniqueName: 'dev@x' },
    creationDate: '2026-01-01T00:00:00Z',
    sourceRefName: 'refs/heads/feature',
    targetRefName: 'refs/heads/main',
    url: `https://example.test/pr/${id}`,
    mergeStatus: 'succeeded',
    reviewers: [],
    description: '',
    autoCompleteSetBy: undefined,
    ...overrides,
  };
}

function enqueue(prId: number, projectId = 'p1') {
  return usePrCompletionQueueStore.getState().enqueue({
    projectId,
    prId,
    prTitle: `PR ${prId}`,
    targetBranch: 'main',
    completionOptions: {
      mergeStrategy: 'squash',
      deleteSourceBranch: true,
      transitionWorkItems: false,
    },
  });
}

function statusOf(prId: number) {
  return usePrCompletionQueueStore
    .getState()
    .entries.find((e) => e.prId === prId)?.status;
}

function queuedPrIds() {
  return usePrCompletionQueueStore.getState().entries.map((e) => e.prId);
}

describe('PrCompletionQueueDriver', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    prs.clear();
    prFetchedAt.clear();
    fetchClock = 1_000_000;
    setPr(101, makePr(101));
    setPr(102, makePr(102));
    queueEnabled = true;
    armDeferred = null;
    setAutoComplete.mockClear();
    invalidatePr.mockClear();
    requeueCi.mockClear();
    policyEvaluations = [];
    usePrCompletionQueueStore.setState({ entries: [] });

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
  });

  /** Render (or re-render) so mocked hooks re-read the mutable PR state. */
  async function render() {
    await act(async () => {
      root.render(<PrCompletionQueueDriver />);
    });
  }

  /** Resolve the pending arm PATCH as Azure accepting it. */
  async function acceptArm(prId: number) {
    const pending = armDeferred;
    armDeferred = null;
    const armed = makePr(prId, {
      autoCompleteSetBy: { id: 'u1', displayName: 'Dev' },
    });
    setPr(prId, armed);
    await act(async () => {
      pending?.resolve(armed);
    });
  }

  it('arms only the head and leaves the rest waiting', async () => {
    enqueue(101);
    enqueue(102);
    await render();

    expect(setAutoComplete).toHaveBeenCalledTimes(1);
    expect(setAutoComplete).toHaveBeenCalledWith(
      expect.objectContaining({ prId: 101, enabled: true }),
    );
    expect(statusOf(102)).toBe('waiting');
  });

  it('promotes the next PR once the armed one merges', async () => {
    enqueue(101);
    enqueue(102);
    await render();
    await acceptArm(101);
    expect(statusOf(101)).toBe('armed');

    setPr(
      101,
      makePr(101, {
        status: 'completed',
        autoCompleteSetBy: { id: 'u1', displayName: 'Dev' },
      }),
    );
    await render();

    expect(queuedPrIds()).toEqual([102]);
    expect(setAutoComplete).toHaveBeenCalledWith(
      expect.objectContaining({ prId: 102, enabled: true }),
    );
  });

  it('disarms a conflicted PR before moving on, so two are never armed at once', async () => {
    enqueue(101);
    enqueue(102);
    await render();
    await acceptArm(101);

    // One conflicted read is not evidence — it may be Azure recomputing the
    // merge after the previous PR moved the target branch.
    setPr(
      101,
      makePr(101, {
        mergeStatus: 'conflicts',
        autoCompleteSetBy: { id: 'u1', displayName: 'Dev' },
      }),
    );
    await render();
    // The confirming poll returns deeply-equal data, so react-query hands back
    // the SAME object — the conflict must still be confirmed off that read.
    refetchSamePr(101);
    await render();

    // The conflicted PR keeps auto-complete at Azure unless we clear it, and a
    // second armed PR is exactly the pileup this queue exists to prevent.
    expect(setAutoComplete).toHaveBeenCalledWith({ prId: 101, enabled: false });
    expect(queuedPrIds()).toEqual([102]);
  });

  it('does not drop an entry on a single transient conflicted read', async () => {
    enqueue(101);
    enqueue(102);
    await render();
    await acceptArm(101);

    // Azure briefly reports conflicts while it recomputes the merge against the
    // just-moved target branch, then settles back to a clean merge.
    setPr(
      101,
      makePr(101, {
        mergeStatus: 'conflicts',
        autoCompleteSetBy: { id: 'u1', displayName: 'Dev' },
      }),
    );
    await render();
    expect(queuedPrIds()).toEqual([101, 102]);

    setPr(
      101,
      makePr(101, {
        mergeStatus: 'succeeded',
        autoCompleteSetBy: { id: 'u1', displayName: 'Dev' },
      }),
    );
    await render();
    expect(queuedPrIds()).toEqual([101, 102]);
    expect(setAutoComplete).not.toHaveBeenCalledWith({
      prId: 101,
      enabled: false,
    });
  });

  it('does not let a sibling cache write stand in for a confirming poll', async () => {
    enqueue(101);
    enqueue(102);
    await render();
    await acceptArm(101);

    const conflicted = makePr(101, {
      mergeStatus: 'conflicts',
      autoCompleteSetBy: { id: 'u1', displayName: 'Dev' },
    });
    setPr(101, conflicted);
    await render();

    // The author retitles the armed PR. `useUpdatePullRequest` writes the same
    // query key through `setQueryData`, producing a fresh object that still
    // carries the pre-poll `mergeStatus`. It re-stamps the cache, it does not
    // re-check Azure — so it must not confirm the conflict.
    cacheWriteSamePr(
      101,
      makePr(101, {
        mergeStatus: 'conflicts',
        autoCompleteSetBy: { id: 'u1', displayName: 'Dev' },
        title: 'PR 101 (retitled by its author)',
      }),
    );
    await render();

    expect(queuedPrIds()).toEqual([101, 102]);
    expect(setAutoComplete).not.toHaveBeenCalledWith({
      prId: 101,
      enabled: false,
    });

    // The next real poll still confirms it.
    refetchSamePr(101);
    await render();
    expect(queuedPrIds()).toEqual([102]);
  });

  /** A required build policy that Azure has not actually run yet. */
  function pendingBuildPolicy(
    evaluationId: string,
    configId: number,
    context?: { buildId?: number; isExpired?: boolean },
  ) {
    return {
      evaluationId,
      status: 'queued',
      isBlocking: true,
      configuration: {
        id: configId,
        isEnabled: true,
        isBlocking: true,
        type: { id: 'build', displayName: 'Build' },
        settings: { buildDefinitionId: 42 },
      },
      context,
    };
  }

  it('re-runs a policy that expires again after a push, but not one already running', async () => {
    policyEvaluations = [pendingBuildPolicy('e1', 1)];
    enqueue(101);
    await render();
    await acceptArm(101);
    expect(requeueCi.mock.calls.map(([id]) => id)).toEqual(['e1']);

    // The build starts: same evaluation, now actually running. Fresh array so
    // the effect re-runs — a still-pending policy must not be re-triggered.
    policyEvaluations = [pendingBuildPolicy('e1', 1, { buildId: 7 })];
    await render();
    expect(requeueCi).toHaveBeenCalledTimes(1);

    // Someone pushes to the source branch: Azure expires that same run. The PR
    // is still armed and will never merge until it is run again.
    policyEvaluations = [
      pendingBuildPolicy('e1', 1, { buildId: 7, isExpired: true }),
    ];
    await render();
    expect(requeueCi.mock.calls.map(([id]) => id)).toEqual(['e1', 'e1']);
  });

  it('retries a requeue that Azure rejected instead of wedging the queue', async () => {
    requeueCi.mockImplementationOnce(() => {
      throw new Error('nope');
    });
    policyEvaluations = [pendingBuildPolicy('e1', 1)];
    enqueue(101);
    await render();
    await acceptArm(101);
    expect(requeueCi).toHaveBeenCalledTimes(1);

    // Next poll: the policy is still pending, so the failed attempt must not
    // count as "already asked" — otherwise the head entry blocks forever.
    policyEvaluations = [pendingBuildPolicy('e1', 1)];
    await render();
    expect(requeueCi).toHaveBeenCalledTimes(2);
  });

  it('runs the armed PR required CI, once per policy, and ignores the rest', async () => {
    policyEvaluations = [
      pendingBuildPolicy('e1', 1),
      // Already running — must not be re-triggered.
      pendingBuildPolicy('e2', 2, { buildId: 7 }),
      // Stale run for an older commit — must be re-triggered.
      pendingBuildPolicy('e3', 3, { buildId: 8, isExpired: true }),
      // Optional policy — the queue only owes the required ones.
      {
        ...pendingBuildPolicy('e4', 4),
        isBlocking: false,
        configuration: {
          ...pendingBuildPolicy('e4', 4).configuration,
          isBlocking: false,
        },
      },
    ];
    enqueue(101);
    await render();
    await acceptArm(101);
    // A second poll must not double-trigger the same policies. Rebuilt as a
    // fresh array (a new query result identity) so the effect really re-runs.
    policyEvaluations = [...policyEvaluations];
    await render();

    expect(requeueCi.mock.calls.map(([id]) => id).sort()).toEqual(['e1', 'e3']);
  });

  it('does not run CI for an entry that is still waiting in line', async () => {
    policyEvaluations = [pendingBuildPolicy('e1', 1)];
    enqueue(101);
    await render();

    // 101 is only `arming` here — nothing armed yet, so no CI should fire.
    expect(requeueCi).not.toHaveBeenCalled();
  });

  it('does not fail the entry on a stale pre-arm read', async () => {
    enqueue(101);
    await render();

    // Azure accepts the PATCH, but a GET that was already in flight lands
    // afterwards and overwrites the cache with the pre-arm PR — so we never see
    // `autoCompleteSetBy`. That must not read as a cancellation.
    const pending = armDeferred;
    armDeferred = null;
    await act(async () => {
      pending?.resolve(makePr(101, { autoCompleteSetBy: undefined }));
    });
    setPr(101, makePr(101, { autoCompleteSetBy: undefined }));
    await render();

    expect(queuedPrIds()).toEqual([101]);
    expect(setAutoComplete).not.toHaveBeenCalledWith({
      prId: 101,
      enabled: false,
    });
  });

  it('does not count re-renders as polls when deciding a PR was cancelled', async () => {
    enqueue(101);
    enqueue(102);
    await render();

    const pending = armDeferred;
    armDeferred = null;
    await act(async () => {
      pending?.resolve(makePr(101, { autoCompleteSetBy: undefined }));
    });

    // The watch effect re-runs on EVERY render (its `settle` dep depends on the
    // mutation object, whose identity changes each time). Re-rendering without
    // any new network data must not advance the "it really is unarmed" count,
    // or unrelated renders would fail a perfectly healthy entry in milliseconds.
    for (let i = 0; i < UNARMED_READS_BEFORE_TRUSTED + 2; i++) {
      await render();
    }

    expect(queuedPrIds()).toEqual([101, 102]);
  });

  it('eventually trusts a persistently unarmed PR instead of stalling forever', async () => {
    enqueue(101);
    enqueue(102);
    await render();

    const pending = armDeferred;
    armDeferred = null;
    await act(async () => {
      pending?.resolve(makePr(101, { autoCompleteSetBy: undefined }));
    });

    // Repeated *distinct* polls all showing no auto-complete are not a stale
    // cache artifact — the user cancelled in the Azure UI. Without a bound here
    // the entry would hold the head slot forever and block the whole project.
    for (let i = 0; i < UNARMED_READS_BEFORE_TRUSTED; i++) {
      // Deeply-equal refetches: identity never changes, only `dataUpdatedAt`.
      refetchSamePr(101);
      await render();
    }

    expect(queuedPrIds()).toEqual([102]);
  });

  it('disarms defensively and moves on when the arm PATCH fails', async () => {
    enqueue(101);
    enqueue(102);
    await render();

    const pending = armDeferred;
    armDeferred = null;
    await act(async () => {
      pending?.reject(new Error('network down'));
    });

    // Azure may have applied the PATCH and lost the response.
    expect(setAutoComplete).toHaveBeenCalledWith({ prId: 101, enabled: false });
    expect(queuedPrIds()).toEqual([102]);
  });

  it('skips a PR that was already merged while it waited in line', async () => {
    enqueue(101);
    enqueue(102);
    setPr(101, makePr(101, { status: 'completed' }));
    await render();

    // Arming a completed PR would just make Azure error.
    expect(setAutoComplete).not.toHaveBeenCalledWith(
      expect.objectContaining({ prId: 101, enabled: true }),
    );
    expect(queuedPrIds()).toEqual([102]);
  });

  it('keeps polling the armed PR across re-renders', async () => {
    vi.useFakeTimers();
    try {
      enqueue(101);
      await render();
      await acceptArm(101);
      invalidatePr.mockClear();

      // Re-renders must not restart the interval. They used to, and since the
      // runner re-renders several times per poll the refetch never fired at all
      // — merges were only noticed via unrelated invalidations elsewhere.
      for (let i = 0; i < 5; i++) await render();
      await act(async () => {
        vi.advanceTimersByTime(POLL_INTERVAL_MS + 1_000);
      });

      expect(invalidatePr).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains the queue and resolves its jobs when the setting is turned off', async () => {
    enqueue(101);
    enqueue(102);
    await render();
    const jobId = usePrCompletionQueueStore
      .getState()
      .entries.find((e) => e.prId === 101)?.jobId;

    queueEnabled = false;
    await render();

    expect(queuedPrIds()).toEqual([]);
    // Running jobs are never pruned from localStorage and the queue resets on
    // restart, so an unresolved job here would hang in the UI forever.
    const job = useBackgroundJobsStore
      .getState()
      .jobs.find((j) => j.id === jobId);
    expect(job?.status).toBe('failed');
  });
});
