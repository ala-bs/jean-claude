import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef } from 'react';

import {
  type StreamListStore,
  useStreamListStoreWhen,
} from '@/hooks/utils-stream-list-store';

import type { MobilePreviewNetworkRequest } from '@shared/mobile-simulator-types';

import {
  getNetworkFacets,
  getNetworkHostname,
  getNetworkPath,
  getNetworkStatusLabel,
  logNetworkFilterDebug,
  matchesNetworkFilter,
  matchesNetworkFilterToken,
  matchesNetworkPreset,
  type NetworkFilterToken,
  type NetworkPresetFilter,
} from './utils-network';

/**
 * Derivation layer for the network inspector tab. The owning state stays in the
 * pane component (it must survive tab switches), so it is passed in here and
 * this hook is called unconditionally.
 */
export function useNetworkInspector({
  isNetworkTabVisible,
  requestsStore,
  showTunneledNetworkRequests,
  networkPreset,
  networkFilter,
  networkFacet,
  selectedNetworkRequestId,
  setSelectedNetworkRequestId,
  setNetworkFacet,
}: {
  isNetworkTabVisible: boolean;
  requestsStore: StreamListStore<MobilePreviewNetworkRequest>;
  showTunneledNetworkRequests: boolean;
  networkPreset: NetworkPresetFilter;
  networkFilter: NetworkFilterToken[];
  networkFacet: string;
  selectedNetworkRequestId: string | null;
  setSelectedNetworkRequestId: Dispatch<SetStateAction<string | null>>;
  setNetworkFacet: Dispatch<SetStateAction<string>>;
}) {
  const hasAutoSelectedNetworkRequestRef = useRef(false);
  const pendingNetworkContextMenuRef = useRef<HTMLElement | null>(null);
  const suppressNetworkClickRef = useRef(false);

  const capturedNetworkRequests = useStreamListStoreWhen(
    requestsStore,
    isNetworkTabVisible,
  );
  const networkRequests = useMemo(
    () =>
      [...capturedNetworkRequests].sort(
        (firstRequest, secondRequest) =>
          Date.parse(secondRequest.startedAt) -
          Date.parse(firstRequest.startedAt),
      ),
    [capturedNetworkRequests],
  );
  const displayedNetworkRequests = useMemo(
    () =>
      showTunneledNetworkRequests
        ? networkRequests
        : networkRequests.filter((request) => !request.tunnelOnly),
    [networkRequests, showTunneledNetworkRequests],
  );
  const visibleNetworkRequests = useMemo(
    () =>
      displayedNetworkRequests
        .filter((request) => matchesNetworkPreset(request, networkPreset))
        .filter(
          (request) =>
            networkFacet === 'all' || getNetworkPath(request.url) === networkFacet,
        )
        .filter((request) => matchesNetworkFilter(request, networkFilter)),
    [displayedNetworkRequests, networkFacet, networkFilter, networkPreset],
  );
  const networkFacets = useMemo(
    () => getNetworkFacets(displayedNetworkRequests),
    [displayedNetworkRequests],
  );
  const selectedNetworkRequest =
    visibleNetworkRequests.find(
      (request) => request.id === selectedNetworkRequestId,
    ) ?? null;

  useEffect(() => {
    if (networkFilter.length === 0) return;
    logNetworkFilterDebug('filter-applied', {
      tokens: networkFilter,
      displayedCount: displayedNetworkRequests.length,
      visibleCount: visibleNetworkRequests.length,
      hiddenSamples: displayedNetworkRequests
        .filter(
          (request) =>
            matchesNetworkPreset(request, networkPreset) &&
            (networkFacet === 'all' || getNetworkPath(request.url) === networkFacet) &&
            !matchesNetworkFilter(request, networkFilter),
        )
        .slice(0, 8)
        .map((request) => ({
          method: request.method,
          status: getNetworkStatusLabel(request),
          host: getNetworkHostname(request.url),
          path: getNetworkPath(request.url),
          tokenResults: networkFilter.map((token) => ({
            token,
            matches: matchesNetworkFilterToken(request, token),
          })),
        })),
      visibleSamples: visibleNetworkRequests.slice(0, 5).map((request) => ({
        host: getNetworkHostname(request.url),
        path: getNetworkPath(request.url),
      })),
    });
  }, [
    displayedNetworkRequests,
    networkFacet,
    networkFilter,
    networkPreset,
    visibleNetworkRequests,
  ]);

  // These three reconcile the selection/facet against the visible requests. They
  // must not run while the network tab is hidden: the request buffer is
  // unsubscribed then, so the derived lists are empty and would otherwise clear
  // the user's selected request and endpoint filter.
  useEffect(() => {
    if (!isNetworkTabVisible) return;
    if (hasAutoSelectedNetworkRequestRef.current) return;
    const firstRequest = visibleNetworkRequests[0];
    if (!firstRequest) return;
    hasAutoSelectedNetworkRequestRef.current = true;
    queueMicrotask(() => setSelectedNetworkRequestId(firstRequest.id));
  }, [isNetworkTabVisible, setSelectedNetworkRequestId, visibleNetworkRequests]);

  useEffect(() => {
    if (!isNetworkTabVisible) return;
    if (!selectedNetworkRequestId) return;
    if (
      visibleNetworkRequests.some(
        (request) => request.id === selectedNetworkRequestId,
      )
    ) {
      return;
    }

    queueMicrotask(() =>
      setSelectedNetworkRequestId(visibleNetworkRequests[0]?.id ?? null),
    );
  }, [
    isNetworkTabVisible,
    selectedNetworkRequestId,
    setSelectedNetworkRequestId,
    visibleNetworkRequests,
  ]);

  useEffect(() => {
    if (!isNetworkTabVisible) return;
    if (networkFacet === 'all') return;
    if (networkFacets.some((facet) => facet.path === networkFacet)) return;
    queueMicrotask(() => setNetworkFacet('all'));
  }, [isNetworkTabVisible, networkFacet, networkFacets, setNetworkFacet]);

  return {
    pendingNetworkContextMenuRef,
    suppressNetworkClickRef,
    networkRequests,
    displayedNetworkRequests,
    visibleNetworkRequests,
    networkFacets,
    selectedNetworkRequest,
  };
}
