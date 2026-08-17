import { useEffect } from 'react';
import { useRouterState } from '@tanstack/react-router';

import {
  KeyboardLayerProvider,
  useKeyboardLayer,
} from '@/common/context/keyboard-bindings';
import { Modal } from '@/common/ui/modal';
import { ModalArbitrationScope } from '@/common/context/modal-arbitration';
import { useWorkItemModalStore } from '@/stores/work-item-modal';
import { WorkItemDetails } from '@/features/feed/ui-work-item-details';

export function WorkItemModal() {
  const target = useWorkItemModalStore((state) => state.target);
  const close = useWorkItemModalStore((state) => state.close);

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const layer = useKeyboardLayer('dialog', { exclusive: !!target });

  useEffect(() => {
    close();
  }, [pathname, close]);

  if (!target) return null;

  return (
    <KeyboardLayerProvider layer={layer}>
    <Modal
      isOpen
      onClose={close}
      showHeader={false}
      ariaLabel={`Work Item #${target.workItemId}`}
      size="xl"
      contentClassName="min-h-0 overflow-hidden p-0"
      panelClassName="h-[85vh]"
    >
      <ModalArbitrationScope>
        <WorkItemDetails
          projectId={target.projectId}
          workItemId={target.workItemId}
          onClose={close}
        />
      </ModalArbitrationScope>
    </Modal>
    </KeyboardLayerProvider>
  );
}
