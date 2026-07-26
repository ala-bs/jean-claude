import {
  isMobilePreviewProjectEnabled,
  type MobilePreviewProjectConfig,
} from '@shared/types';

import { createMobilePreviewRuntimeKey } from '@/lib/mobile-preview-runtime';
import { getMobilePreviewAppPath } from './utils-mobile-preview-runtimes';

export function getTaskMobilePreviewRuntimeKey({
  taskId,
  mobilePreviewConfig,
}: {
  taskId: string;
  mobilePreviewConfig: MobilePreviewProjectConfig | null | undefined;
}) {
  if (
    !mobilePreviewConfig ||
    !isMobilePreviewProjectEnabled(mobilePreviewConfig)
  ) {
    return null;
  }
  return createMobilePreviewRuntimeKey({
    taskId,
    appPath: getMobilePreviewAppPath(mobilePreviewConfig),
  });
}

export function openTaskMobilePreviewWorkspace({
  runtimeKey,
  open,
}: {
  runtimeKey: string | null;
  open: (runtimeKey: string) => void;
}) {
  if (runtimeKey) open(runtimeKey);
}
