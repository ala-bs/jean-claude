import { createFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createFileRoute('/projects/$projectId/')({
  component: ProjectIndex,
});

// The legacy per-project task list was removed: the feed list is the main view.
function ProjectIndex() {
  return <Navigate to="/all" replace />;
}
