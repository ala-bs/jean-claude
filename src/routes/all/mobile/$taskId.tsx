import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';

import { MobilePreviewWorkspace } from '@/features/mobile-preview/ui-mobile-preview-workspace';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useMobilePreviewWorkspaceStore } from '@/stores/mobile-preview-workspace';

const FEED_NAVIGATION_DEBOUNCE_MS = 100;

export const Route = createFileRoute('/all/mobile/$taskId')({
  component: AllMobilePreview,
});

function AllMobilePreview() {
  const { taskId } = Route.useParams();
  const navigate = useNavigate();
  const closeMobileMode = useMobilePreviewWorkspaceStore(
    (state) => state.close,
  );
  const debouncedTaskId = useDebouncedValue(
    taskId,
    FEED_NAVIGATION_DEBOUNCE_MS,
  );

  // Leaving mobile mode explicitly (Escape / close) turns sticky mode off.
  // Navigate with the live param, not the debounced one, so a close right after
  // a feed move does not send you back to the previous task.
  const handleClose = useCallback(() => {
    closeMobileMode();
    void navigate({ to: '/all/$taskId', params: { taskId } });
  }, [closeMobileMode, navigate, taskId]);

  return (
    <MobilePreviewWorkspace
      key={debouncedTaskId}
      taskId={debouncedTaskId}
      onClose={handleClose}
    />
  );
}
