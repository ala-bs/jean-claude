export type PrWorkspaceDeletionDestination =
  | {
      to: '/all/prs/$projectId/$prId';
      params: { projectId: string; prId: string };
    }
  | {
      to: '/projects/$projectId/prs/$prId';
      params: { projectId: string; prId: string };
    }
  | { to: '/all' }
  | { to: '/projects/$projectId'; params: { projectId: string } };

function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function getPrWorkspaceDeletionDestination({
  pathname,
  deletedTaskIds,
  currentTaskId,
  projectId,
  pullRequestId,
}: {
  pathname: string;
  deletedTaskIds: string[];
  currentTaskId?: string;
  projectId: string;
  pullRequestId: number | string;
}): PrWorkspaceDeletionDestination | null {
  const segments = pathname.split('/').filter(Boolean).map(decodeSegment);
  const deletedTaskIdSet = new Set(deletedTaskIds);
  const prId = String(pullRequestId);

  if (
    segments.length === 2 &&
    segments[0] === 'all' &&
    deletedTaskIdSet.has(segments[1])
  ) {
    return {
      to: '/all/prs/$projectId/$prId',
      params: { projectId, prId },
    };
  }

  if (
    segments.length === 4 &&
    segments[0] === 'projects' &&
    segments[1] === projectId &&
    segments[2] === 'tasks' &&
    deletedTaskIdSet.has(segments[3])
  ) {
    return {
      to: '/projects/$projectId/prs/$prId',
      params: { projectId, prId },
    };
  }

  if (!currentTaskId || !deletedTaskIdSet.has(currentTaskId)) return null;
  if (segments[0] === 'all') return { to: '/all' };
  return {
    to: '/projects/$projectId',
    params: { projectId },
  };
}
