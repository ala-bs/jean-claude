import { startTransition, useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Shield } from 'lucide-react';


import { api } from '@/lib/api';
import { Checkbox } from '@/common/ui/checkbox';
import { Modal } from '@/common/ui/modal';
import { parseCompoundCommand } from '@shared/shell-parse';
import { useToastStore } from '@/stores/toasts';


type PermissionScope = 'session' | 'project' | 'worktree' | 'global';

export function AddPermissionModal({
  isOpen,
  onClose,
  command,
  stepId,
  stepName,
  hasWorktree,
}: {
  isOpen: boolean;
  onClose: () => void;
  command: string;
  stepId: string;
  stepName: string;
  hasWorktree: boolean;
}) {
  const formId = useId();
  const targetDescriptionId = `${formId}-target-description`;
  const parsedCommands = useMemo(
    () => parseCompoundCommand(command),
    [command],
  );
  const addToast = useToastStore((s) => s.addToast);

  const [entries, setEntries] = useState(() =>
    parsedCommands.map((cmd) => ({ checked: true, value: cmd })),
  );
  const [scope, setScope] = useState<PermissionScope>('project');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Reset entries whenever the modal opens (handles same-command reopen)
  useEffect(() => {
    if (isOpen) {
      startTransition(() => setEntries(parsedCommands.map((cmd) => ({ checked: true, value: cmd }))));
      startTransition(() => setScope('project'));
      startTransition(() => setIsSubmitting(false));
    }
  }, [isOpen, parsedCommands]);

  const handleToggle = useCallback((index: number) => {
    setEntries((prev) =>
      prev.map((e, i) => (i === index ? { ...e, checked: !e.checked } : e)),
    );
  }, []);

  const handleValueChange = useCallback((index: number, value: string) => {
    setEntries((prev) =>
      prev.map((e, i) => (i === index ? { ...e, value } : e)),
    );
  }, []);

  const checkedCount = useMemo(
    () => entries.filter((e) => e.checked && e.value.trim()).length,
    [entries],
  );

  const handleSubmit = useCallback(async () => {
    const toAdd = entries.filter((e) => e.checked && e.value.trim());
    if (toAdd.length === 0) return;

    setIsSubmitting(true);
    try {
      const addFn =
        scope === 'session'
          ? api.steps.addSessionAllowedTool
          : scope === 'global'
          ? api.steps.allowGlobally
          : scope === 'worktree'
            ? api.steps.allowForProjectWorktrees
            : api.steps.allowForProject;

      await Promise.all(
        toAdd.map((entry) =>
          addFn({
            stepId,
            toolName: 'Bash',
            input: { command: entry.value.trim() },
          }),
        ),
      );
      addToast({
        message: `Added ${toAdd.length} permission${toAdd.length !== 1 ? 's' : ''}`,
        type: 'success',
      });
      onClose();
    } catch (error) {
      console.error('Failed to add permissions:', error);
      addToast({
        message: `Failed to add permissions: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
        type: 'error',
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [entries, scope, stepId, onClose, addToast]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Add to Permissions"
      ariaLabel="Add to Permissions"
      ariaDescribedBy={targetDescriptionId}
      size="lg"
    >
      <div className="space-y-4">
        <p
          id={targetDescriptionId}
          className="border-glass-border bg-bg-0/50 text-ink-2 rounded border px-3 py-2 text-xs"
        >
          Originating step:{' '}
          <strong className="text-ink-1 font-medium">{stepName}</strong>
        </p>

        {/* Commands list */}
        <div>
          <div className="text-ink-2 mb-2 text-xs font-medium">
            Commands
          </div>
          <div className="space-y-2">
            {entries.map((entry, index) => (
              <div key={index} className="flex items-start gap-2">
                <Checkbox
                  size="sm"
                  checked={entry.checked}
                  onChange={() => handleToggle(index)}
                  className="mt-2"
                  compact
                  ariaLabel={`Toggle permission command ${index + 1}`}
                />
                <label
                  htmlFor={`${formId}-command-${index}`}
                  className="sr-only"
                >
                  Permission command {index + 1}
                </label>
                <input
                  id={`${formId}-command-${index}`}
                  type="text"
                  value={entry.value}
                  onChange={(e) => handleValueChange(index, e.target.value)}
                  className="border-glass-border bg-bg-0 text-ink-1 focus:border-acc-line focus:ring-acc/30 w-full rounded border px-2.5 py-1.5 font-mono text-xs focus:ring-1 focus:outline-none"
                  spellCheck={false}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Scope selector */}
        <fieldset>
          <legend className="text-ink-2 mb-2 text-xs font-medium">Scope</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="border-glass-border bg-bg-0/35 flex cursor-pointer items-start gap-2 rounded border px-2.5 py-2">
              <input
                type="radio"
                name="permission-scope"
                value="session"
                checked={scope === 'session'}
                onChange={() => setScope('session')}
                className="border-glass-border bg-glass-medium text-acc focus:ring-acc/30 mt-0.5 h-3.5 w-3.5"
              />
              <span>
                <span className="text-ink-1 block text-sm">Session</span>
                <span className="text-ink-3 block text-[11px]">Current step only.</span>
              </span>
            </label>
            <label className="border-glass-border bg-bg-0/35 flex cursor-pointer items-start gap-2 rounded border px-2.5 py-2">
              <input
                type="radio"
                name="permission-scope"
                value="project"
                checked={scope === 'project'}
                onChange={() => setScope('project')}
                className="border-glass-border bg-glass-medium text-acc focus:ring-acc/30 mt-0.5 h-3.5 w-3.5"
              />
              <span>
                <span className="text-ink-1 block text-sm">Project</span>
                <span className="text-ink-3 block text-[11px]">
                  All sessions in this project.
                </span>
              </span>
            </label>
            {hasWorktree && (
              <label className="border-glass-border bg-bg-0/35 flex cursor-pointer items-start gap-2 rounded border px-2.5 py-2">
                <input
                  type="radio"
                  name="permission-scope"
                  value="worktree"
                  checked={scope === 'worktree'}
                  onChange={() => setScope('worktree')}
                  className="border-glass-border bg-glass-medium text-acc focus:ring-acc/30 mt-0.5 h-3.5 w-3.5"
                />
                <span>
                  <span className="text-ink-1 block text-sm">Worktree</span>
                  <span className="text-ink-3 block text-[11px]">
                    All worktrees for this project.
                  </span>
                </span>
              </label>
            )}
            <label className="border-glass-border bg-bg-0/35 flex cursor-pointer items-start gap-2 rounded border px-2.5 py-2">
              <input
                type="radio"
                name="permission-scope"
                value="global"
                checked={scope === 'global'}
                onChange={() => setScope('global')}
                className="border-glass-border bg-glass-medium text-acc focus:ring-acc/30 mt-0.5 h-3.5 w-3.5"
              />
              <span>
                <span className="text-ink-1 block text-sm">Global</span>
                <span className="text-ink-3 block text-[11px]">All projects.</span>
              </span>
            </label>
          </div>
          {scope !== 'session' && (
            <p className="text-status-run mt-2 text-[11px] leading-relaxed">
              Persistent Bash permissions can apply broadly. Keep command
              patterns specific.
            </p>
          )}
        </fieldset>

        {/* Actions */}
        <div className="border-glass-border flex items-center justify-end gap-2 border-t pt-4">
          <button
            onClick={onClose}
            className="text-ink-2 hover:bg-glass-medium hover:text-ink-1 rounded px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={checkedCount === 0 || isSubmitting}
            className="bg-acc hover:bg-acc flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Shield className="h-3.5 w-3.5" />
            {isSubmitting
              ? 'Adding…'
              : `Add ${checkedCount} permission${checkedCount !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
