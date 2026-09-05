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
let queueEnabled = true;
const setAutoComplete = vi.fn();
const invalidatePr = vi.fn();
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
  }),
  usePullRequestPolicyEvaluations: () => ({ data: [] }),
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
    prs.set(101, makePr(101));
    prs.set(102, makePr(102));
    queueEnabled = true;
    armDeferred = null;
    setAutoComplete.mockClear();
    invalidatePr.mockClear();
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
    prs.set(prId, armed);
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

    prs.set(
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

    prs.set(
      101,
      makePr(101, {
        mergeStatus: 'conflicts',
        autoCompleteSetBy: { id: 'u1', displayName: 'Dev' },
      }),
    );
    await render();

    // The conflicted PR keeps auto-complete at Azure unless we clear it, and a
    // second armed PR is exactly the pileup this queue exists to prevent.
    expect(setAutoComplete).toHaveBeenCalledWith({ prId: 101, enabled: false });
    expect(queuedPrIds()).toEqual([102]);
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
    prs.set(101, makePr(101, { autoCompleteSetBy: undefined }));
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
      prs.set(101, makePr(101, { autoCompleteSetBy: undefined }));
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
    prs.set(101, makePr(101, { status: 'completed' }));
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
