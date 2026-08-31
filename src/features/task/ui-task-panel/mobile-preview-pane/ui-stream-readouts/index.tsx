import { memo, useSyncExternalStore } from 'react';
import clsx from 'clsx';

import {
  type StreamListStore,
  useStreamListStore,
} from '@/hooks/utils-stream-list-store';
import { EmptyState } from '../ui-common';
import type { MobilePreviewNativeLogEvent } from '@shared/mobile-simulator-types';
import type { PreviewFpsStore } from '../preview-fps-store';

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
            entry.stream === 'stderr' ? 'text-status-run' : 'text-ink-1',
            entry.stream === 'system' && 'text-status-azure',
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
