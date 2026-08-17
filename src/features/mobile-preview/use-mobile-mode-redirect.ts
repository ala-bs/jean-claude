import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';

import { getTaskMobilePreviewRuntimeKey } from './utils-mobile-preview-task-action';
import { useMobilePreviewWorkspaceStore } from '@/stores/mobile-preview-workspace';
import { useProject } from '@/hooks/use-projects';
import { useTask } from '@/hooks/use-tasks';

/**
 * Sticky mobile mode: whenever task details render while mobile mode is on and
 * the task's project has mobile preview enabled, swap to the mobile route.
 * Redirecting here (instead of at every navigation call site) makes feed
 * clicks, keyboard nav, notifications and deep links all behave the same.
 */
export function useMobileModeRedirect(taskId: string) {
  const navigate = useNavigate();
  const isMobileMode = useMobilePreviewWorkspaceStore((state) => state.isOpen);
  const { data: task, isLoading: isLoadingTask } = useTask(taskId);
  const { data: project, isLoading: isLoadingProject } = useProject(
    task?.projectId ?? '',
  );
  const runtimeKey = getTaskMobilePreviewRuntimeKey({
    taskId,
    mobilePreviewConfig: project?.mobilePreviewConfig,
  });
  // Completed tasks have no derived runtime, so redirecting them would bounce
  // back from the mobile route and loop.
  const shouldRedirect =
    isMobileMode && runtimeKey !== null && task?.userCompleted === false;

  useEffect(() => {
    if (!shouldRedirect) return;
    void navigate({
      to: '/all/mobile/$taskId',
      params: { taskId },
      replace: true,
    });
  }, [navigate, shouldRedirect, taskId]);

  // Also hold rendering while metadata loads, otherwise task details mount and
  // immediately unmount on a cold cache or a deep link.
  return shouldRedirect || (isMobileMode && (isLoadingTask || isLoadingProject));
}
