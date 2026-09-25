import type { FeedItem } from '@shared/feed-types';

/** Match titles and work-item IDs, including IDs on nested task children. */
export function matchesFeedSearch(item: FeedItem, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;

  const workItemIds = [
    item.workItemId == null ? null : String(item.workItemId),
    ...(item.workItemIds ?? []),
  ];
  if (
    [item.title, ...workItemIds].some((value) =>
      value?.toLocaleLowerCase().includes(normalizedQuery),
    )
  ) {
    return true;
  }

  return item.children?.some((child) => matchesFeedSearch(child, query)) ?? false;
}
