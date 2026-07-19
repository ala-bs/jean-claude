import { createFileRoute, Navigate, Outlet } from '@tanstack/react-router';

import { useProject } from '@/hooks/use-projects';

export const Route = createFileRoute('/projects/$projectId')({
  component: ProjectLayout,
});

function ProjectLayout() {
  const { projectId } = Route.useParams();
  const { data: project, error, isError, isLoading } = useProject(projectId);

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
          <p>Failed to load project</p>
          {error?.message && <p className="text-ink-4 text-sm">{error.message}</p>}
        </div>
      </div>
    );
  }

  if (!project) {
    return <Navigate to="/all" replace />;
  }

  if (project?.archivedAt) {
    return <Navigate to="/all" replace />;
  }

  return <Outlet />;
}
