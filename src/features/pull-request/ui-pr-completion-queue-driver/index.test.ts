import { describe, expect, it } from 'vitest';

import type { AzureDevOpsPullRequestDetails } from '@/lib/api';
import { resolveArmedPrSettlement } from './index';

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
      }),
    ).toBeNull();
  });

  it('succeeds once the PR is completed', () => {
    expect(
      resolveArmedPrSettlement({
        pr: makePr({ status: 'completed' }),
        hasRejectedBlockingPolicy: false,
        hasObservedArmed: true,
      }),
    ).toEqual({ outcome: 'succeeded', reason: 'merged' });
  });

  it('reports a merged PR as merged even if a stale policy looks rejected', () => {
    expect(
      resolveArmedPrSettlement({
        pr: makePr({ status: 'completed' }),
        hasRejectedBlockingPolicy: true,
        hasObservedArmed: true,
      })?.outcome,
    ).toBe('succeeded');
  });

  it('fails on abandon, conflicts and merge failure', () => {
    expect(
      resolveArmedPrSettlement({
        pr: makePr({ status: 'abandoned' }),
        hasRejectedBlockingPolicy: false,
        hasObservedArmed: true,
      })?.outcome,
    ).toBe('failed');
    expect(
      resolveArmedPrSettlement({
        pr: makePr({ mergeStatus: 'conflicts' }),
        hasRejectedBlockingPolicy: false,
        hasObservedArmed: true,
      })?.outcome,
    ).toBe('failed');
    expect(
      resolveArmedPrSettlement({
        pr: makePr({ mergeStatus: 'failure' }),
        hasRejectedBlockingPolicy: false,
        hasObservedArmed: true,
      })?.outcome,
    ).toBe('failed');
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
      }),
    ).toBeNull();
  });

  it('fails when Azure cleared auto-complete behind our back', () => {
    expect(
      resolveArmedPrSettlement({
        pr: makePr({ autoCompleteSetBy: undefined }),
        hasRejectedBlockingPolicy: false,
        hasObservedArmed: true,
      }),
    ).toEqual({ outcome: 'failed', reason: 'auto-complete was cancelled' });
  });

  it('fails when a required check is rejected', () => {
    expect(
      resolveArmedPrSettlement({
        pr: makePr(),
        hasRejectedBlockingPolicy: true,
        hasObservedArmed: true,
      }),
    ).toEqual({ outcome: 'failed', reason: 'a required check failed' });
  });
});
