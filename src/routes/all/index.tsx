import { createFileRoute, Navigate } from '@tanstack/react-router';

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

  if (activeTasks.length > 0) {
    return (
      <Navigate
        to="/all/$taskId"
        params={{ taskId: activeTasks[0].id }}
        replace
      />
    );
  }

  return <Navigate to="/projects/new" replace />;
}
