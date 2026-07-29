import { useEffect } from 'react';
import { useRouterState } from '@tanstack/react-router';

import { Modal } from '@/common/ui/modal';
import { ModalArbitrationScope } from '@/common/context/modal-arbitration';
import { useWorkItemModalStore } from '@/stores/work-item-modal';
import { WorkItemDetails } from '@/features/feed/ui-work-item-details';

export function WorkItemModal() {
  const target = useWorkItemModalStore((state) => state.target);
  const close = useWorkItemModalStore((state) => state.close);

  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    close();
  }, [pathname, close]);

  if (!target) return null;

  return (
    <Modal
      isOpen
      onClose={close}
      title={`Work Item #${target.workItemId}`}
      size="xl"
      contentClassName="min-h-0 overflow-hidden p-0"
      panelClassName="h-[85vh]"
    >
      <ModalArbitrationScope>
        <WorkItemDetails
          projectId={target.projectId}
          workItemId={target.workItemId}
        />
      </ModalArbitrationScope>
    </Modal>
  );
}
