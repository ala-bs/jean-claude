import { useEffect, useRef, useState } from 'react';

import type { MobilePreviewDevice } from '@shared/mobile-simulator-types';

import {
  getMobilePreviewAutoLaunchDecision,
  type MobilePreviewAutoLaunchDecision,
} from './utils-mobile-preview-auto-launch';
import { api } from '@/lib/api';

export type MobilePreviewRuntimeLaunchState =
  | MobilePreviewAutoLaunchDecision
  | { status: 'error'; message: string };

let nextRequestId = 0;

function createRequestId(): string {
  nextRequestId += 1;
  return `mobile-preview-expo:${Date.now()}:${nextRequestId}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useMobilePreviewExpoLaunch({
  isRunningRuntime,
  isLoadingDevices,
  selectedDevice,
  isExpoApp,
  taskId,
  projectId,
  appPath,
  metroPort,
  retryGeneration,
  isSelectedDeviceReady,
}: {
  isRunningRuntime: boolean;
  isLoadingDevices: boolean;
  selectedDevice: Pick<
    MobilePreviewDevice,
    'id' | 'platform' | 'state'
  > | null;
  isExpoApp: boolean;
  taskId: string;
  projectId: string;
  appPath: string;
  metroPort: number;
  retryGeneration: number;
  isSelectedDeviceReady: boolean;
}) {
  const [state, setState] = useState<MobilePreviewRuntimeLaunchState>({
    status: 'idle',
  });
  const completedOwnerKeyRef = useRef<string | null>(null);
  const selectedDeviceId = selectedDevice?.id ?? null;
  const selectedDevicePlatform = selectedDevice?.platform ?? null;
  const selectedDeviceState = selectedDevice?.state ?? null;

  useEffect(() => {
    let active = true;
    const decision = getMobilePreviewAutoLaunchDecision({
      isRunningRuntime,
      isLoadingDevices,
      selectedDevice:
        selectedDeviceId && selectedDevicePlatform && selectedDeviceState
          ? {
              id: selectedDeviceId,
              platform: selectedDevicePlatform,
              state: selectedDeviceState,
            }
          : null,
      isExpoApp,
      taskId,
      projectId,
      appPath,
      metroPort,
      completedOwnerKey: completedOwnerKeyRef.current,
      isSelectedDeviceReady,
    });
    if (decision.status === 'idle') {
      completedOwnerKeyRef.current = null;
    }
    queueMicrotask(() => {
      if (active) setState(decision);
    });
    if (decision.status !== 'launching') {
      return () => {
        active = false;
      };
    }

    const requestId = createRequestId();
    void api.mobilePreview
      .launchExpo({ ...decision.params, requestId })
      .then(() => {
        if (!active) return;
        completedOwnerKeyRef.current = decision.ownerKey;
        setState({
          status: 'ready',
          message: `Expo attached on :${metroPort}`,
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          status: 'error',
          message: formatError(error) || 'Failed to launch Expo',
        });
      });

    return () => {
      active = false;
      void api.mobilePreview.cancelExpoLaunch(requestId).catch(() => {});
    };
  }, [
    appPath,
    isExpoApp,
    isLoadingDevices,
    isRunningRuntime,
    isSelectedDeviceReady,
    metroPort,
    projectId,
    retryGeneration,
    selectedDeviceId,
    selectedDevicePlatform,
    selectedDeviceState,
    taskId,
  ]);

  return state;
}
