import { createFileRoute } from '@tanstack/react-router';

import { WorkItemDetails } from '@/features/feed/ui-work-item-details';

export const Route = createFileRoute('/all/work-items/$projectId/$workItemId')({
  component: WorkItemPage,
});

function WorkItemPage() {
  const { projectId, workItemId } = Route.useParams();

  return (
    <WorkItemDetails projectId={projectId} workItemId={Number(workItemId)} />
  );
}
