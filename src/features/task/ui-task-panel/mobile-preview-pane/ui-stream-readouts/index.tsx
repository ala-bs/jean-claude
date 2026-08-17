import { memo, useSyncExternalStore } from 'react';
import clsx from 'clsx';

import type {
  MobilePreviewNativeLogEvent,
  MobilePreviewNetworkRequest,
} from '@shared/mobile-simulator-types';
import {
  type StreamListStore,
  useStreamListStore,
} from '@/hooks/utils-stream-list-store';
import type { PreviewFpsStore } from '../preview-fps-store';
import { getNetworkStats } from '../utils-network';
import { EmptyState } from '../ui-common';

// Subscribes to the device-log buffer so streaming logs re-render this list
// only, never the preview surface or the other tabs.
export const NativeLogsList = memo(function NativeLogsList({
  store,
}: {
  store: StreamListStore<MobilePreviewNativeLogEvent>;
}) {
  const logs = useStreamListStore(store);

  if (logs.length === 0) {
    return (
      <EmptyState
        title="No device logs"
        detail="Start logs to stream native output"
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed">
      {logs.map((entry, index) => (
        <div
          key={`${entry.timestamp}-${index}`}
          className={clsx(
            'whitespace-pre-wrap',
            entry.stream === 'stderr' ? 'text-amber-200' : 'text-zinc-200',
            entry.stream === 'system' && 'text-sky-200',
          )}
        >
          {entry.text}
        </div>
      ))}
    </div>
  );
});

export const NativeLogsTabLabel = memo(function NativeLogsTabLabel({
  store,
}: {
  store: StreamListStore<MobilePreviewNativeLogEvent>;
}) {
  const logs = useStreamListStore(store);
  return <>Logs {logs.length ? logs.length : ''}</>;
});

// Rendered inside the Setup checklist, which is visible while the network tab
// is not. It subscribes to the request buffer itself so the pane does not have
// to (a pane-level subscription would re-render the preview on every request).
export const NetworkRequestCountDetail = memo(
  function NetworkRequestCountDetail({
    store,
    showTunneled,
  }: {
    store: StreamListStore<MobilePreviewNetworkRequest>;
    showTunneled: boolean;
  }) {
    const requests = useStreamListStore(store);
    const total = getNetworkStats(
      showTunneled
        ? [...requests]
        : requests.filter((request) => !request.tunnelOnly),
    ).total;
    return <>{total} requests · decrypt on</>;
  },
);

export const NetworkTabLabel = memo(function NetworkTabLabel({
  store,
  showTunneled,
}: {
  store: StreamListStore<MobilePreviewNetworkRequest>;
  showTunneled: boolean;
}) {
  const requests = useStreamListStore(store);
  const failed = getNetworkStats(
    showTunneled
      ? [...requests]
      : requests.filter((request) => !request.tunnelOnly),
  ).failed;
  return <>Network {failed || ''}</>;
});

export const PreviewStatusText = memo(function PreviewStatusText({
  methodText,
  showFps,
  fpsStore,
}: {
  methodText: string | null;
  showFps: boolean;
  fpsStore: PreviewFpsStore;
}) {
  const fps = useSyncExternalStore(fpsStore.subscribe, fpsStore.get, fpsStore.get);
  return (
    <span className="text-ink-4 font-mono text-[10px]">
      {methodText ?? 'stream idle'}
      {showFps ? ` · ${fps} fps` : ''}
    </span>
  );
});
