import { createFileRoute } from '@tanstack/react-router';

import { ProjectPanel } from '@/features/project/ui-project-panel';
import { useDebouncedValue } from '@/hooks/use-debounced-value';

const FEED_NAVIGATION_DEBOUNCE_MS = 100;

export const Route = createFileRoute('/all/projects/$projectId')({
  component: AllProjectPanel,
});

function AllProjectPanel() {
  const { projectId } = Route.useParams();
  const debouncedProjectId = useDebouncedValue(
    projectId,
    FEED_NAVIGATION_DEBOUNCE_MS,
  );

  return (
    <ProjectPanel key={debouncedProjectId} projectId={debouncedProjectId} />
  );
}
