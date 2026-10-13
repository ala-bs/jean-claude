import { describe, expect, it } from 'vitest';

import {
  isCurrentProjectQueueHead,
  resolveArmedPrSettlement,
  shouldAutoRequeue,
} from './index';
import type { AzureDevOpsPullRequestDetails } from '@/lib/api';
import type { PrCompletionQueueEntry } from '@/stores/pr-completion-queue';

function makePr(
  overrides: Partial<AzureDevOpsPullRequestDetails> = {},
): AzureDevOpsPullRequestDetails {
  return {
    id: 42,
    title: 'PR',
    status: 'active',
    isDraft: false,
    createdBy: { id: 'u1', displayName: 'Dev', uniqueName: 'dev@x' },
    creationDate: '2026-01-01T00:00:00Z',
    sourceRefName: 'refs/heads/feature',
    targetRefName: 'refs/heads/main',
    url: 'https://example.test/pr/42',
    mergeStatus: 'succeeded',
    reviewers: [],
    description: '',
    autoCompleteSetBy: { id: 'u1', displayName: 'Dev' },
    ...overrides,
  };
}

describe('resolveArmedPrSettlement', () => {
  it('stays pending while the PR is active and armed', () => {
    expect(
      resolveArmedPrSettlement({
        pr: makePr(),
        hasRejectedBlockingPolicy: false,
        hasObservedArmed: true,
        hasConfirmedMergeBlocked: true,
      }),
    ).toBeNull();
  });

  it('succeeds once the PR is completed', () => {
    expect(
      resolveArmedPrSettlement({
        pr: makePr({ status: 'completed' }),
        hasRejectedBlockingPolicy: false,
        hasObservedArmed: true,
        hasConfirmedMergeBlocked: true,
      }),
    ).toEqual({ outcome: 'succeeded', reason: 'merged' });
  });

  it('reports a merged PR as merged even if a stale policy looks rejected', () => {
    expect(
      resolveArmedPrSettlement({
        pr: makePr({ status: 'completed' }),
        hasRejectedBlockingPolicy: true,
        hasObservedArmed: true,
        hasConfirmedMergeBlocked: true,
      })?.outcome,
    ).toBe('succeeded');
  });

  it('fails on abandon, conflicts and merge failure', () => {
    expect(
      resolveArmedPrSettlement({
        pr: makePr({ status: 'abandoned' }),
        hasRejectedBlockingPolicy: false,
        hasObservedArmed: true,
        hasConfirmedMergeBlocked: true,
      })?.outcome,
    ).toBe('failed');
    expect(
      resolveArmedPrSettlement({
        pr: makePr({ mergeStatus: 'conflicts' }),
        hasRejectedBlockingPolicy: false,
        hasObservedArmed: true,
        hasConfirmedMergeBlocked: true,
      })?.outcome,
    ).toBe('failed');
    expect(
      resolveArmedPrSettlement({
        pr: makePr({ mergeStatus: 'failure' }),
        hasRejectedBlockingPolicy: false,
        hasObservedArmed: true,
        hasConfirmedMergeBlocked: true,
      })?.outcome,
    ).toBe('failed');
  });

  it('ignores an unconfirmed blocking mergeStatus', () => {
    // One conflicted read can be a pre-arm read, or Azure recomputing the merge
    // right after the previous queued PR moved the target branch. Acting on it
    // dropped every remaining entry, one per promotion.
    expect(
      resolveArmedPrSettlement({
        pr: makePr({ mergeStatus: 'conflicts' }),
        hasRejectedBlockingPolicy: false,
        hasObservedArmed: true,
        hasConfirmedMergeBlocked: false,
      }),
    ).toBeNull();
    // Same guard on the sibling branch, so the two cannot drift apart.
    expect(
      resolveArmedPrSettlement({
        pr: makePr({ mergeStatus: 'failure' }),
        hasRejectedBlockingPolicy: false,
        hasObservedArmed: true,
        hasConfirmedMergeBlocked: false,
      }),
    ).toBeNull();
  });

  it('ignores a missing autoCompleteSetBy until the armed value was seen once', () => {
    // A GET that was already in flight when we armed can land afterwards and
    // overwrite the shared cache with the pre-arm PR. That must not be read as
    // Azure cancelling, or the entry fails instantly and the next PR arms too.
    expect(
      resolveArmedPrSettlement({
        pr: makePr({ autoCompleteSetBy: undefined }),
        hasRejectedBlockingPolicy: false,
        hasObservedArmed: false,
        hasConfirmedMergeBlocked: true,
      }),
    ).toBeNull();
  });

  it('fails when Azure cleared auto-complete behind our back', () => {
    expect(
      resolveArmedPrSettlement({
        pr: makePr({ autoCompleteSetBy: undefined }),
        hasRejectedBlockingPolicy: false,
        hasObservedArmed: true,
        hasConfirmedMergeBlocked: true,
      }),
    ).toEqual({ outcome: 'failed', reason: 'auto-complete was cancelled' });
  });

  it('fails when a required check is rejected', () => {
    expect(
      resolveArmedPrSettlement({
        pr: makePr(),
        hasRejectedBlockingPolicy: true,
        hasObservedArmed: true,
        hasConfirmedMergeBlocked: true,
      }),
    ).toEqual({ outcome: 'failed', reason: 'a required check failed' });
  });

  it('names the failing check when we know it', () => {
    expect(
      resolveArmedPrSettlement({
        pr: makePr(),
        hasRejectedBlockingPolicy: true,
        rejectedPolicyName: 'CI / build',
        hasObservedArmed: true,
        hasConfirmedMergeBlocked: true,
      }),
    ).toEqual({
      outcome: 'failed',
      reason: 'required check failed (CI / build)',
    });
  });

  it('stays pending while a rejected check is still unconfirmed', () => {
    // The first policy read a promoted entry sees is usually a cached snapshot
    // from before it armed — a build that failed on an older iteration must not
    // skip the PR instantly.
    expect(
      resolveArmedPrSettlement({
        pr: makePr(),
        hasRejectedBlockingPolicy: false,
        rejectedPolicyName: 'CI / build',
        hasObservedArmed: true,
        hasConfirmedMergeBlocked: true,
      }),
    ).toBeNull();
  });
});

describe('shouldAutoRequeue', () => {
  const expiredRunningEvaluation = {
    evaluationId: 'e1',
    status: 'running' as const,
    isBlocking: true,
    configuration: {
      id: 1,
      isEnabled: true,
      isBlocking: true,
      type: { id: 'build', displayName: 'Build' },
      settings: { buildDefinitionId: 42 },
    },
    context: { buildId: 7, isExpired: true },
  };

  it('requeues an expired pipeline even when Azure still reports it running', () => {
    expect(
      shouldAutoRequeue({
        evaluation: expiredRunningEvaluation,
        failureRetries: 0,
      }),
    ).toBe(true);
  });
});

describe('isCurrentProjectQueueHead', () => {
  const entries = [
    { id: 'first', projectId: 'project-a' },
    { id: 'second', projectId: 'project-a' },
    { id: 'other-project', projectId: 'project-b' },
  ] as PrCompletionQueueEntry[];

  it('accepts only the first entry for the project', () => {
    expect(
      isCurrentProjectQueueHead({
        entries,
        projectId: 'project-a',
        entryId: 'first',
      }),
    ).toBe(true);
    expect(
      isCurrentProjectQueueHead({
        entries,
        projectId: 'project-a',
        entryId: 'second',
      }),
    ).toBe(false);
  });

  it('does not let another project affect the head check', () => {
    expect(
      isCurrentProjectQueueHead({
        entries,
        projectId: 'project-b',
        entryId: 'other-project',
      }),
    ).toBe(true);
  });
});
