import {
  getResourceChangeVersion,
  getResourceDeletionVersion,
  isResourceFresh,
  markResourceStale,
  releaseResource,
  retainResource,
  setResourceError,
  setResourceLoading,
  setResourceSuccess,
} from './cache-actions';
import type { ResourceMeta, ResourceResult } from './cache-types';
import { useCallback, useEffect, useMemo } from 'react';
import { cache$ } from './cache-store';
import type { CacheSubscription } from '@shared/cache-events';
import { subscribeCacheResources } from './cache-subscriptions';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { useValue } from '@legendapp/state/react';

// One pending promise per resource key prevents duplicate concurrent loads.
const pendingResources = new Map<string, Promise<unknown>>();

// How long a resource may report loading before we log diagnostics.
const STUCK_LOADING_WARN_MS = 8000;

type ResourceResultMeta = Pick<
  ResourceMeta,
  'error' | 'lastFetchedAt' | 'stale' | 'status'
>;

type SerializedCacheSubscription = [
  resourceKey: string,
  includeChildren: boolean,
];

export function getCacheSubscriptionKey(
  key: string,
  subscriptions?: CacheSubscription[],
) {
  const serializedSubscriptions: SerializedCacheSubscription[] = (
    subscriptions ?? [{ resourceKey: key }]
  )
    .map(
      (subscription): SerializedCacheSubscription => [
        subscription.resourceKey,
        subscription.includeChildren === true,
      ],
    )
    .sort(
      ([leftKey, leftIncludesChildren], [rightKey, rightIncludesChildren]) =>
        leftKey.localeCompare(rightKey) ||
        Number(leftIncludesChildren) - Number(rightIncludesChildren),
    );

  return JSON.stringify(serializedSubscriptions);
}

function getSubscriptionsFromKey(key: string): CacheSubscription[] {
  return (JSON.parse(key) as SerializedCacheSubscription[]).map(
    ([resourceKey, includeChildren]) => ({
      resourceKey,
      ...(includeChildren ? { includeChildren } : {}),
    }),
  );
}

function getRetainedResourceKeys(
  key: string,
  subscriptions?: CacheSubscription[],
) {
  return Array.from(
    new Set([
      key,
      ...(subscriptions ?? []).map((subscription) => subscription.resourceKey),
    ]),
  ).sort();
}

function getRetainedResourceKey(
  key: string,
  subscriptions?: CacheSubscription[],
) {
  return JSON.stringify(getRetainedResourceKeys(key, subscriptions));
}

export type EnsureResourceOptions<T> = {
  key: string;
  staleTime?: number;
  force?: boolean;
  load: () => Promise<T>;
  ingest?: (data: T) => void;
  /** True when the cache already holds renderable data for this resource. */
  hasCachedData?: () => boolean;
};

export function clearPendingResources() {
  pendingResources.clear();
}

export function shouldLoadChangedResource(
  meta: ResourceMeta | ResourceResultMeta | undefined,
) {
  return (
    meta?.stale === true &&
    (meta.status === 'success' || meta.status === 'error')
  );
}

export function isResourceInitialLoading(
  enabled: boolean,
  meta: ResourceMeta | ResourceResultMeta | undefined,
) {
  return (
    enabled &&
    meta?.lastFetchedAt == null &&
    (!meta || meta.status === 'idle' || meta.status === 'loading')
  );
}

// A resource with no data yet is only "not found" once nothing is in flight
// and no reload is pending. Otherwise (first fetch, refetch, or invalidated
// mid-flight and waiting for the reload effect) it is still loading.
export function isResourceLoading({
  enabled,
  meta,
  hasData,
}: {
  enabled: boolean;
  meta: ResourceMeta | ResourceResultMeta | undefined;
  hasData: boolean;
}) {
  // Cached data already available (e.g. entity retained by an index while the
  // per-resource meta was GC'd) - never report loading, just refresh silently.
  if (hasData) {
    return false;
  }

  if (isResourceInitialLoading(enabled, meta)) {
    return true;
  }

  return (
    enabled &&
    !hasData &&
    (meta?.status === 'loading' || shouldLoadChangedResource(meta))
  );
}

export async function ensureResource<T>({
  key,
  staleTime = 0,
  force = false,
  load,
  ingest,
  hasCachedData,
}: EnsureResourceOptions<T>): Promise<T | undefined> {
  const current = cache$.resources[key].get();
  if (!force && isResourceFresh(current, staleTime)) {
    return undefined;
  }

  const pending = pendingResources.get(key) as Promise<T> | undefined;
  if (pending) {
    return pending;
  }

  const changeVersionAtLoadStart = getResourceChangeVersion(key);
  const deletionVersionAtLoadStart = getResourceDeletionVersion(key);

  const promise = Promise.resolve()
    .then(load)
    .then((data) => {
      setResourceSuccess(key);
      if (getResourceChangeVersion(key) !== changeVersionAtLoadStart) {
        // Changed mid-flight: this payload may be older than what the event
        // already applied, so normally we drop it and refetch. But when nothing
        // is cached yet, dropping it leaves `data === undefined` + stale meta,
        // which renders "Loading..." forever for resources that get frequent
        // cache events (e.g. a running task patched every few hundred ms).
        // Showing slightly stale data and refreshing beats an endless spinner.
        // Never rescue across a delete: the delete path empties the cache too,
        // so it looks exactly like "nothing cached yet" and would resurrect a
        // deleted entity from a pre-delete payload.
        const deletedDuringLoad =
          getResourceDeletionVersion(key) !== deletionVersionAtLoadStart;
        if (!deletedDuringLoad && data != null && hasCachedData?.() === false) {
          ingest?.(data);
        }
        markResourceStale(key);
      } else {
        ingest?.(data);
      }
      return data;
    })
    .catch((error: unknown) => {
      setResourceError(key, error);
      if (getResourceChangeVersion(key) !== changeVersionAtLoadStart) {
        markResourceStale(key);
      }
      throw error;
    })
    .finally(() => {
      pendingResources.delete(key);
    });

  pendingResources.set(key, promise);
  setResourceLoading(key);

  return promise;
}

export function useCacheResource<TData, TSelected = TData>({
  key,
  enabled = true,
  staleTime = 0,
  load,
  ingest,
  select,
  subscriptions,
}: {
  key: string;
  enabled?: boolean;
  staleTime?: number;
  load: () => Promise<TData>;
  ingest?: (data: TData) => void;
  select?: () => TSelected | undefined;
  subscriptions?: CacheSubscription[];
}): ResourceResult<TSelected> {
  const loadRef = useLatestRef(load);
  const ingestRef = useLatestRef(ingest);

  const subscriptionKey = getCacheSubscriptionKey(key, subscriptions);
  const retainedResourceKey = getRetainedResourceKey(key, subscriptions);

  const metaStatus = useValue(() => cache$.resources[key].status.get());
  const metaError = useValue(() => cache$.resources[key].error.get());
  const metaLastFetchedAt = useValue(() =>
    cache$.resources[key].lastFetchedAt.get(),
  );
  const metaStale = useValue(() => cache$.resources[key].stale.get());
  const meta = useMemo<ResourceResultMeta | undefined>(
    () =>
      metaStatus === undefined
        ? undefined
        : {
            status: metaStatus,
            error: metaError ?? null,
            lastFetchedAt: metaLastFetchedAt ?? null,
            stale: metaStale ?? true,
          },
    [metaError, metaLastFetchedAt, metaStale, metaStatus],
  );
  const data = useValue(() => {
    if (select) {
      return select();
    }

    return cache$.documents[key].data.get() as TSelected | undefined;
  });

  const selectRef = useLatestRef(select);
  const hasCachedData = useCallback(() => {
    const selector = selectRef.current;
    return selector
      ? selector() !== undefined
      : cache$.documents[key].data.get() !== undefined;
  }, [key, selectRef]);

  const loadResource = useCallback(() => {
    return ensureResource({
      key,
      staleTime,
      load: () => loadRef.current(),
      ingest: (loadedData) => ingestRef.current?.(loadedData),
      hasCachedData,
    });
  }, [hasCachedData, ingestRef, key, loadRef, staleTime]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const resourceKeys = JSON.parse(retainedResourceKey) as string[];
    for (const resourceKey of resourceKeys) {
      retainResource(resourceKey);
    }

    return () => {
      for (const resourceKey of resourceKeys) {
        releaseResource(resourceKey);
      }
    };
  }, [enabled, retainedResourceKey]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const unsubscribe = subscribeCacheResources(
      getSubscriptionsFromKey(subscriptionKey),
    );

    return unsubscribe;
  }, [enabled, subscriptionKey]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    void loadResource().catch(() => {});
  }, [enabled, loadResource]);

  useEffect(() => {
    if (!enabled || !shouldLoadChangedResource(meta)) {
      return;
    }

    void loadResource().catch(() => {});
  }, [enabled, loadResource, meta]);


  const refetch = useCallback(async () => {
    await ensureResource({
      key,
      staleTime,
      force: true,
      load: () => loadRef.current(),
      ingest: (loadedData) => ingestRef.current?.(loadedData),
      hasCachedData,
    });
  }, [hasCachedData, ingestRef, key, loadRef, staleTime]);

  const error = metaError ? new Error(metaError) : null;
  const isLoading = isResourceLoading({
    enabled,
    meta,
    hasData: data !== undefined,
  });

  // Watchdog: a resource should never stay loading for long. Log enough state
  // to diagnose the remaining stuck-loading reports instead of guessing.
  // Meta is read through a ref so a reload loop (which mutates meta on every
  // iteration) can't keep resetting the timer — that loop is what we're hunting.
  const metaRef = useLatestRef(meta);
  useEffect(() => {
    if (!isLoading) return;
    const timer = setTimeout(() => {
      console.warn('[cache] resource stuck loading', {
        key,
        meta: metaRef.current,
        hasPending: pendingResources.has(key),
      });
    }, STUCK_LOADING_WARN_MS);
    return () => clearTimeout(timer);
  }, [isLoading, key, metaRef]);

  return {
    data,
    isLoading,
    isFetching: enabled && metaStatus === 'loading',
    isError: metaStatus === 'error',
    error,
    refetch,
  };
}
