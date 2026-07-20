import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useEffect } from 'react';

import { useLastTaskForProject } from '@/stores/navigation';
import { useProjectTasks } from '@/hooks/use-tasks';


export const Route = createFileRoute('/projects/$projectId/')({
  component: ProjectIndex,
});

function ProjectIndex() {
  const { projectId } = Route.useParams();
  const { data: tasks, error, isError, isLoading } = useProjectTasks(projectId);
  const { lastTaskId, clearTaskNavHistoryState } =
    useLastTaskForProject(projectId);

  const lastTaskNotFound = lastTaskId
    ? !!tasks && !tasks.some((t) => t.id === lastTaskId)
    : false;

  useEffect(() => {
    if (lastTaskNotFound) {
      clearTaskNavHistoryState(lastTaskId);
    }
  }, [clearTaskNavHistoryState, lastTaskId, lastTaskNotFound]);

  if (isLoading) {
    return (
      <div className="text-ink-3 flex h-full w-full flex-1 items-center justify-center">
        Loading...
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-ink-3 flex h-full w-full flex-1 items-center justify-center">
        <div className="space-y-2 text-center">
          <p>Failed to load tasks</p>
          {error?.message && <p className="text-ink-4 text-sm">{error.message}</p>}
        </div>
      </div>
    );
  }

  // Redirect to last viewed task or first task if any exist
  if (tasks && tasks.length > 0) {
    // Check if lastTaskId is valid for this project
    const lastTask = lastTaskId ? tasks.find((t) => t.id === lastTaskId) : null;

    const targetTaskId = lastTask?.id ?? tasks[0].id;

    return (
      <Navigate
        to="/projects/$projectId/tasks/$taskId"
        params={{ projectId, taskId: targetTaskId }}
        replace
      />
    );
  }

  // Empty state
  return (
    <div className="text-ink-3 flex h-full flex-col items-center justify-center">
      <p className="mb-2 text-lg">No tasks yet</p>
      <p className="text-sm">Create a new task to get started</p>
    </div>
  );
}
