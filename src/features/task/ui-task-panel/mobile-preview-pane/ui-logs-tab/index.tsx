import type { MobilePlatform } from '@shared/mobile-simulator-types';
import type { MobilePreviewNativeLogEvent } from '@shared/mobile-simulator-types';
import type { StreamListStore } from '@/hooks/utils-stream-list-store';
import { Button } from '@/common/ui/button';
import { EmptyState } from '../ui-common';
import { NativeLogsList } from '../ui-stream-readouts';
import { formatError } from '../utils-preview-error';

export function LogsTab({
  platform,
  deviceId,
  nativeLogStatus,
  nativeLogCommand,
  nativeLogSessionError,
  nativeLogError,
  logsStore,
  onStartStopNativeLogs,
  isNativeLogBusy,
}: {
  platform: MobilePlatform;
  deviceId: string | null;
  nativeLogStatus: string;
  nativeLogCommand: string | null;
  nativeLogSessionError: string | null;
  nativeLogError: unknown;
  logsStore: StreamListStore<MobilePreviewNativeLogEvent>;
  onStartStopNativeLogs: () => void;
  isNativeLogBusy: boolean;
}) {
  const isRunning = nativeLogStatus === 'running';
  return (
    <div className="bg-bg-0 flex h-full min-h-0 flex-col">
      <div className="border-line bg-bg-1 flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <div className="text-ink-1 text-sm font-medium">
            Device logs {nativeLogStatus}
          </div>
          <div className="text-ink-3 truncate text-xs">
            {nativeLogCommand ??
              (platform === 'ios' ? 'xcrun simctl log stream' : 'adb logcat')}
          </div>
        </div>
        <Button
          size="xs"
          variant={isRunning ? 'secondary' : 'primary'}
          disabled={!deviceId || isNativeLogBusy}
          loading={isNativeLogBusy}
          onClick={onStartStopNativeLogs}
        >
          {isRunning ? 'Stop' : 'Start'}
        </Button>
      </div>
      {nativeLogError || nativeLogSessionError ? (
        <div className="border-status-fail/30 bg-status-fail/10 text-status-fail border-b px-3 py-1.5 text-xs">
          {formatError(nativeLogError) ?? nativeLogSessionError}
        </div>
      ) : null}
      {!deviceId ? (
        <EmptyState title="No device selected" detail="Select a device first" />
      ) : (
        <NativeLogsList store={logsStore} />
      )}
    </div>
  );
}
