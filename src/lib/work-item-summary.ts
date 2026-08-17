export function canShowWorkItemSummary({
  projectId,
  providerId,
  projectName,
  workItemId,
}: {
  projectId?: string | null;
  providerId?: string | null;
  projectName?: string | null;
  workItemId?: number | null;
}): boolean {
  return !!projectId && !!providerId && !!projectName && !!workItemId;
}
