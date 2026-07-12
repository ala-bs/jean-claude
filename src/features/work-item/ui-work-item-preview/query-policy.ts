export function getWorkItemPreviewQueryPolicy({
  variant,
  showCommentsAside,
  commentsTabActive,
  workItemId,
  openedCommentsWorkItemIds,
}: {
  variant: 'default' | 'editorial';
  showCommentsAside: boolean;
  commentsTabActive: boolean;
  workItemId: number | null;
  openedCommentsWorkItemIds: ReadonlySet<number>;
}) {
  return {
    comments:
      showCommentsAside ||
      commentsTabActive ||
      (workItemId !== null && openedCommentsWorkItemIds.has(workItemId)),
    relatedTestCases: variant !== 'editorial',
  };
}

export function addOpenedCommentsWorkItemId(
  openedCommentsWorkItemIds: Set<number>,
  workItemId: number,
): Set<number> {
  if (openedCommentsWorkItemIds.has(workItemId)) {
    return openedCommentsWorkItemIds;
  }
  return new Set([...openedCommentsWorkItemIds, workItemId]);
}

export type MetadataEditLifecycle = {
  generation: number;
  cancelled: boolean;
  inFlight: boolean;
};

export function beginMetadataEdit(lifecycle: MetadataEditLifecycle) {
  lifecycle.generation += 1;
  lifecycle.cancelled = false;
  lifecycle.inFlight = false;
}

export function cancelMetadataEdit(lifecycle: MetadataEditLifecycle) {
  lifecycle.generation += 1;
  lifecycle.cancelled = true;
  lifecycle.inFlight = false;
}

export function beginMetadataSave(lifecycle: MetadataEditLifecycle) {
  if (lifecycle.cancelled || lifecycle.inFlight) return null;
  lifecycle.inFlight = true;
  return lifecycle.generation;
}

export function finishMetadataSave(
  lifecycle: MetadataEditLifecycle,
  generation: number,
) {
  if (lifecycle.generation !== generation || lifecycle.cancelled) return false;
  lifecycle.inFlight = false;
  return true;
}
