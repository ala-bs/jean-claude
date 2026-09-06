import {
  KeyboardLayerProvider,
  useKeyboardLayer,
} from '@/common/context/keyboard-bindings';
import { Button } from '@/common/ui/button';
import { Kbd } from '@/common/ui/kbd';
import { Modal } from '@/common/ui/modal';
import { useCommands } from '@/common/hooks/use-commands';



export function DeleteCommandDialog({
  isOpen,
  onClose,
  onConfirm,
  commandLabel,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  commandLabel: string;
}) {
  const layer = useKeyboardLayer('dialog', { exclusive: isOpen });

  useCommands(
    'delete-command-dialog',
    [
      isOpen && {
        label: 'Confirm Delete Command',
        shortcut: ['cmd+enter', 'cmd+backspace'],
        hideInCommandPalette: true,
        handler: () => {
          onConfirm();
        },
      },
    ],
    { layer },
  );

  if (!isOpen) return null;

  return (
    <KeyboardLayerProvider layer={layer}>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Delete Command"
        ariaLabel="Delete Command"
        size="sm"
      >
        <p className="text-ink-1 mb-4 text-sm leading-6">
          Are you sure you want to delete{' '}
          <span className="text-ink-0 font-medium">{commandLabel}</span>? This
          action cannot be undone.
        </p>

        <div className="flex justify-end gap-3">
          <Button type="button" onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button type="button" onClick={onConfirm} variant="danger">
            Delete
            <span className="inline-flex items-center gap-1">
              <Kbd shortcut="cmd+enter" />
              <Kbd shortcut="cmd+backspace" />
            </span>
          </Button>
        </div>
      </Modal>
    </KeyboardLayerProvider>
  );
}
