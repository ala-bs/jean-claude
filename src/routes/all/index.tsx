import { createFileRoute, Navigate } from '@tanstack/react-router';

import { useActiveProjects } from '@/hooks/use-projects';
import { useAllActiveTasks } from '@/hooks/use-tasks';

export const Route = createFileRoute('/all/')({
  component: AllIndex,
});

function AllIndex() {
  const {
    data: activeTasks = [],
    error,
    isError,
    isLoading,
  } = useAllActiveTasks();
  const { data: projects = [], isLoading: isLoadingProjects } =
    useActiveProjects();

  if (isLoading || isLoadingProjects) {
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

  if (activeTasks.length > 0) {
    return (
      <Navigate
        to="/all/$taskId"
        params={{ taskId: activeTasks[0].id }}
        replace
      />
    );
  }

  // Only send the user to project creation when there is genuinely no project
  // yet. With projects but no active tasks, stay here so the feed list stays
  // visible instead of forcing the "new project" form.
  if (projects.length === 0) {
    return <Navigate to="/projects/new" replace />;
  }

  return (
    <div className="text-ink-3 flex h-full flex-col items-center justify-center">
      <p className="mb-2 text-lg">No active tasks</p>
      <p className="text-sm">Create a new task to get started</p>
    </div>
  );
}
