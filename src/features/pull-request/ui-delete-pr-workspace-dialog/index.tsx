import { AlertTriangle } from 'lucide-react';

import { Button } from '@/common/ui/button';
import { Modal } from '@/common/ui/modal';

export function DeletePrWorkspaceDialog({
  isOpen,
  scope,
  isPending,
  error,
  onClose,
  onConfirm,
}: {
  isOpen: boolean;
  scope: 'current' | 'all';
  isPending: boolean;
  error: Error | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!isOpen) return null;

  const label =
    scope === 'current' ? 'Delete PR Workspace' : 'Delete PR Workspaces';

  return (
    <Modal
      isOpen
      onClose={() => {
        if (!isPending) onClose();
      }}
      title={label}
      ariaLabel={label}
      closeOnClickOutside={!isPending}
      closeOnEscape={!isPending}
      closeDisabled={isPending}
      ariaDescribedBy="delete-pr-workspace-description"
    >
      <div className="flex gap-3">
        <AlertTriangle
          className="mt-0.5 h-5 w-5 text-status-fail shrink-0"
          aria-hidden
        />
        <div>
          <p
            id="delete-pr-workspace-description"
            className="text-ink-1 text-sm leading-6"
          >
            {scope === 'current'
              ? 'This permanently removes this PR Workspace'
              : 'This permanently removes all PR Workspaces for this pull request'}
            , including task history, steps and messages, worktrees, local
            branches, agents, and commands. This action cannot be undone.
          </p>
          {error && (
            <p className="mt-3 text-status-fail text-sm" role="alert">
              {error.message}
            </p>
          )}
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-3">
        <Button
          type="button"
          onClick={onClose}
          disabled={isPending}
          variant="ghost"
        >
          Cancel
        </Button>
        <Button
          type="button"
          onClick={onConfirm}
          loading={isPending}
          disabled={isPending}
          variant="danger"
        >
          {label}
        </Button>
      </div>
    </Modal>
  );
}
