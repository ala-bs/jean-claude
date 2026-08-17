import type { FeedItem } from '@shared/feed-types';

export function getPrStateColor({
  status,
  isDraft,
  hasConflicts,
  hasOpenComments,
}: {
  status: FeedItem['workItemPrStatus'];
  isDraft: boolean | undefined;
  hasConflicts: boolean;
  hasOpenComments: boolean;
}) {
  if (status === 'completed') return 'var(--color-status-done)';
  if (status === 'abandoned') return 'var(--color-ink-4)';
  if (hasConflicts) return 'var(--color-status-fail)';
  if (hasOpenComments) return 'var(--color-status-run)';
  if (isDraft) return 'var(--color-ink-3)';
  return 'var(--color-status-azure)';
}

export function resolvePrStatus({
  cachedStatus,
  feedStatus,
}: {
  cachedStatus: FeedItem['workItemPrStatus'];
  feedStatus: FeedItem['workItemPrStatus'];
}) {
  return feedStatus ?? cachedStatus;
}

export function getPrStatusLabel(status: FeedItem['workItemPrStatus']) {
  if (status === 'completed') return 'merged';
  if (status === 'abandoned') return 'abandoned';
  return 'open';
}
