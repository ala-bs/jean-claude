import { useParams } from '@tanstack/react-router';

import { useCurrentVisibleProject } from '@/stores/navigation';
import { useOverlaysStore } from '@/stores/overlays';
import { useProjects } from '@/hooks/use-projects';
import { useTask } from '@/hooks/use-tasks';


export function useCurrentSettingsProject({
  overrideProjectId,
}: { overrideProjectId?: string | null } = {}) {
  const routeParams = useParams({ strict: false });
  const routeTaskId =
    typeof routeParams.taskId === 'string' ? routeParams.taskId : '';
  const { projectId: visibleProjectId } = useCurrentVisibleProject();
  const { data: currentTask } = useTask(routeTaskId);
  const { data: projects = [] } = useProjects();
  // Set when settings was opened for a specific project (e.g. from the
  // activity center), which the route can no longer convey now that the
  // feed list is the main view.
  const settingsProjectTarget = useOverlaysStore((s) => s.settingsProjectTarget);

  const inferredProjectId =
    visibleProjectId === 'all'
      ? (settingsProjectTarget ?? currentTask?.projectId ?? 'all')
      : visibleProjectId;

  const projectId = overrideProjectId ?? inferredProjectId;
  const focusKey = routeTaskId
    ? `task:${routeTaskId}`
    : `project:${inferredProjectId}`;

  const currentProject =
    projectId !== 'all'
      ? (projects.find((project) => project.id === projectId) ?? null)
      : null;

  return { currentProject, projects, focusKey };
}
