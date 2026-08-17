import { describe, expect, it, vi } from 'vitest';

import {
  getTaskMobilePreviewRuntimeKey,
  openTaskMobilePreviewWorkspace,
} from './utils-mobile-preview-task-action';
import { createMobilePreviewRuntimeKey } from '@/lib/mobile-preview-runtime';
import type { MobilePreviewProjectConfig } from '@shared/types';

const config: MobilePreviewProjectConfig = {
  mode: 'enabled',
  selectedAppPath: 'apps/mobile',
  detectedApps: [
    {
      path: 'apps/mobile',
      stacks: ['expo'],
      confidence: 'high',
      reasons: [],
    },
  ],
  detectionUpdatedAt: null,
};

describe('task mobile preview action', () => {
  it('opens workspace preselected to task and project-selected app', () => {
    const open = vi.fn();
    const runtimeKey = getTaskMobilePreviewRuntimeKey({
      taskId: 'task-1',
      mobilePreviewConfig: config,
    });

    openTaskMobilePreviewWorkspace({ runtimeKey, open });

    const expectedKey = createMobilePreviewRuntimeKey({
      taskId: 'task-1',
      appPath: 'apps/mobile',
    });
    expect(runtimeKey).toBe(expectedKey);
    expect(open).toHaveBeenCalledWith(expectedKey);
  });

  it('does not open for a disabled mobile project', () => {
    const open = vi.fn();
    const runtimeKey = getTaskMobilePreviewRuntimeKey({
      taskId: 'task-1',
      mobilePreviewConfig: { ...config, mode: 'disabled' },
    });

    openTaskMobilePreviewWorkspace({ runtimeKey, open });

    expect(runtimeKey).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it('does not open before mobile project configuration loads', () => {
    const open = vi.fn();
    const runtimeKey = getTaskMobilePreviewRuntimeKey({
      taskId: 'task-1',
      mobilePreviewConfig: undefined,
    });

    openTaskMobilePreviewWorkspace({ runtimeKey, open });

    expect(runtimeKey).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
});
