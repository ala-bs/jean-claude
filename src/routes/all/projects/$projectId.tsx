import { createFileRoute } from '@tanstack/react-router';

import { ProjectPanel } from '@/features/project/ui-project-panel';
import { useDebouncedValue } from '@/hooks/use-debounced-value';

const FEED_NAVIGATION_DEBOUNCE_MS = 100;

export const Route = createFileRoute('/all/projects/$projectId')({
  component: AllProjectPanel,
  // `fromTaskId` is set when the panel is opened from a task's overflow menu,
  // so the panel can offer a way back to that exact task.
  validateSearch: (
    search: Record<string, unknown>,
  ): { fromTaskId?: string } =>
    typeof search.fromTaskId === 'string'
      ? { fromTaskId: search.fromTaskId }
      : {},
});

function AllProjectPanel() {
  const { projectId } = Route.useParams();
  const { fromTaskId } = Route.useSearch();
  const debouncedProjectId = useDebouncedValue(
    projectId,
    FEED_NAVIGATION_DEBOUNCE_MS,
  );

  return (
    <ProjectPanel
      key={debouncedProjectId}
      projectId={debouncedProjectId}
      backToTaskId={fromTaskId}
    />
  );
}
