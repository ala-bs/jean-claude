import type { RefObject } from 'react';

import { Button } from '@/common/ui/button';
import { cleanPreviewError } from '../utils-preview-error';
import { EmptyState } from '../ui-common';
import { Select } from '@/common/ui/select';

type DevToolsTarget = {
  id: string;
  title?: string | null;
  deviceName?: string | null;
  appId?: string | null;
};

export function DevToolsTab({
  metroBaseUrl,
  effectiveDevServerPort,
  devToolsTargets,
  devToolsTarget,
  devToolsError,
  devToolsFrontendUrl,
  devToolsViewRef,
  isFetching,
  isLoading,
  onRefresh,
  setSelectedDevToolsTargetId,
  handleDevToolsTargetMenuOpenChange,
}: {
  metroBaseUrl: string | null;
  effectiveDevServerPort: number;
  devToolsTargets: DevToolsTarget[];
  devToolsTarget: DevToolsTarget | null;
  devToolsError: string | null;
  devToolsFrontendUrl: string | null;
  devToolsViewRef: RefObject<HTMLDivElement | null>;
  isFetching: boolean;
  isLoading: boolean;
  onRefresh: () => void;
  setSelectedDevToolsTargetId: (targetId: string) => void;
  handleDevToolsTargetMenuOpenChange: (open: boolean) => void;
}) {
  return (
    <div className="bg-bg-0 flex h-full min-h-0 flex-col">
      <div className="border-line bg-bg-1 flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-ink-1 text-sm font-medium">React Native DevTools</div>
          <div className="text-ink-3 truncate text-xs">
            Metro {metroBaseUrl ?? `http://localhost:${effectiveDevServerPort}`} · Console
          </div>
          <div className="text-ink-4 mt-1 font-mono text-[10px]">
            {devToolsTargets.length} target
            {devToolsTargets.length === 1 ? '' : 's'}
          </div>
        </div>
        {devToolsTargets.length > 1 ? (
          <Select
            value={devToolsTarget?.id ?? ''}
            options={devToolsTargets.map((target) => ({
              value: target.id,
              label: target.title || target.deviceName || target.id,
              description: target.deviceName ?? target.appId ?? undefined,
            }))}
            onChange={setSelectedDevToolsTargetId}
            onOpenChange={handleDevToolsTargetMenuOpenChange}
            className="max-w-[260px]"
          />
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          loading={isFetching}
          onClick={onRefresh}
        >
          Refresh
        </Button>
      </div>
      {devToolsError ? (
        <div className="border-status-warn/30 bg-status-warn/10 text-status-warn border-b px-3 py-1.5 text-xs">
          {cleanPreviewError(devToolsError)}
        </div>
      ) : null}
      {isLoading ? (
        <EmptyState title="Finding DevTools target" detail="Checking Metro inspector" />
      ) : devToolsFrontendUrl ? (
        <div className="bg-bg-0 min-h-0 flex-1">
          <div
            ref={devToolsViewRef}
            className="bg-bg-0 h-full min-h-[360px] w-full"
          />
        </div>
      ) : (
        <EmptyState
          title="No RN DevTools target"
          detail="Start Metro, launch app, make sure Hermes debug build is running"
        />
      )}
    </div>
  );
}
