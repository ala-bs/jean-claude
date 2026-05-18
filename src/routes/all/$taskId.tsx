import { createFileRoute } from '@tanstack/react-router';

import { TaskPanel } from '@/features/task/ui-task-panel';
import { useDebouncedValue } from '@/hooks/use-debounced-value';

const FEED_NAVIGATION_DEBOUNCE_MS = 100;

export const Route = createFileRoute('/all/$taskId')({
  component: AllTaskPanel,
});

function AllTaskPanel() {
  const { taskId } = Route.useParams();
  const debouncedTaskId = useDebouncedValue(
    taskId,
    FEED_NAVIGATION_DEBOUNCE_MS,
  );

  return <TaskPanel taskId={debouncedTaskId} />;
}
