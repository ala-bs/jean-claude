import {
  type CacheEvent,
  type CacheSubscription,
  getCacheEventResourceKeys,
  matchesCacheSubscription,
} from '@shared/cache-events';
import { api } from '@/lib/api';


import { cache$ } from './cache-store';

const subscriptionCounts = new Map<
  string,
  { subscription: CacheSubscription; count: number }
>();
let subscriptionRevision = 0;

function subscriptionId(subscription: CacheSubscription) {
  return `${subscription.resourceKey}:${subscription.includeChildren === true ? 'children' : 'exact'}`;
}

function flushSubscriptions() {
  subscriptionRevision += 1;
  return api.cache.setSubscriptions({
    revision: subscriptionRevision,
    subscriptions: Array.from(subscriptionCounts.values()).map(
      ({ subscription }) => subscription,
    ),
  });
}

export function subscribeCacheResources(subscriptions: CacheSubscription[]) {
  for (const subscription of subscriptions) {
    const id = subscriptionId(subscription);
    const current = subscriptionCounts.get(id);

    if (current) {
      current.count += 1;
    } else {
      subscriptionCounts.set(id, { subscription, count: 1 });
    }
  }

  void flushSubscriptions();

  return () => {
    for (const subscription of subscriptions) {
      const id = subscriptionId(subscription);
      const current = subscriptionCounts.get(id);

      if (!current) {
        continue;
      }

      if (current.count <= 1) {
        subscriptionCounts.delete(id);
      } else {
        current.count -= 1;
      }
    }

    void flushSubscriptions();
  };
}

export async function subscribeCacheResourcesAndWait(
  subscriptions: CacheSubscription[],
) {
  for (const subscription of subscriptions) {
    const id = subscriptionId(subscription);
    const current = subscriptionCounts.get(id);
    if (current) {
      current.count += 1;
    } else {
      subscriptionCounts.set(id, { subscription, count: 1 });
    }
  }

  const release = () => {
    for (const subscription of subscriptions) {
      const id = subscriptionId(subscription);
      const current = subscriptionCounts.get(id);
      if (!current) continue;
      if (current.count <= 1) {
        subscriptionCounts.delete(id);
      } else {
        current.count -= 1;
      }
    }
    void flushSubscriptions();
  };

  try {
    await flushSubscriptions();
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

export function shouldApplyCacheEvent(event: CacheEvent) {
  const resourceKeys = getCacheEventResourceKeys(event);
  const subscriptions = Array.from(subscriptionCounts.values()).map(
    ({ subscription }) => subscription,
  );

  return resourceKeys.some((resourceKey) => {
    const retainedResource = cache$.resources[resourceKey].get();

    return (
      (retainedResource?.observerCount ?? 0) > 0 ||
      subscriptions.some((subscription) =>
        matchesCacheSubscription(subscription, resourceKey),
      )
    );
  });
}

export function resetCacheResourceSubscriptionsForTests() {
  subscriptionCounts.clear();
  subscriptionRevision = 0;
  void flushSubscriptions();
}
