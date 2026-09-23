// Panel listing every queued PR completion, grouped by project, in the exact
// order the driver will arm them. Waiting entries can be reordered or removed.

import { ArrowDown, ArrowUp, GitMerge, Loader2, X } from 'lucide-react';

import {
  type PrCompletionQueueEntry,
  usePrCompletionQueueStore,
} from '@/stores/pr-completion-queue';
import { Modal } from '@/common/ui/modal';
import { useKeyboardLayer } from '@/common/context/keyboard-bindings';
import { useLeavePrCompletionQueue } from '../use-leave-pr-completion-queue';
import { useProjects } from '@/hooks/use-projects';
import { useSetAutoComplete } from '@/hooks/use-pull-requests';

export function PrCompletionQueueOverlay({ onClose }: { onClose: () => void }) {
  // Dispatch is LIFO with no layer precedence, so without claiming a layer the
  // feed list mounted behind this modal keeps handling its shortcuts.
  useKeyboardLayer('overlay', { exclusive: true, passthrough: ['global-nav'] });
  const entries = usePrCompletionQueueStore((state) => state.entries);
  const { data: projects } = useProjects();

  const projectIds = [...new Set(entries.map((e) => e.projectId))];

  return (
    <Modal isOpen onClose={onClose} title="PR completion queue">
      <div className="max-h-[60vh] space-y-6 overflow-y-auto p-1">
        {projectIds.length === 0 && (
          <p className="text-ink-3 py-8 text-center text-sm">
            No PRs queued. Enable “Queue PR auto-complete one at a time” in a
            project’s settings, then set auto-complete on approved PRs.
          </p>
        )}

        {projectIds.map((projectId) => {
          const scoped = entries.filter((e) => e.projectId === projectId);
          const projectName =
            projects?.find((p) => p.id === projectId)?.name ?? 'Project';

          return (
            <section key={projectId}>
              <h3 className="text-ink-2 mb-2 text-xs font-semibold tracking-wide uppercase">
                {projectName}
              </h3>
              <ul className="space-y-1">
                {scoped.map((entry, index) => (
                  <QueueRow
                    key={entry.id}
                    entry={entry}
                    position={index + 1}
                    // A swap needs BOTH entries waiting, so the neighbour's
                    // status decides the button state — otherwise "move up" on
                    // the entry behind an armed head looks live but no-ops.
                    canMoveUp={scoped[index - 1]?.status === 'waiting'}
                    canMoveDown={scoped[index + 1]?.status === 'waiting'}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </Modal>
  );
}

function QueueRow({
  entry,
  position,
  canMoveUp,
  canMoveDown,
}: {
  entry: PrCompletionQueueEntry;
  position: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const move = usePrCompletionQueueStore((state) => state.move);
  const autoCompleteMutation = useSetAutoComplete(
    entry.projectId,
    entry.prId,
    entry.repoInfo,
  );
  const leaveQueue = useLeavePrCompletionQueue();
  const isWaiting = entry.status === 'waiting';

  const handleRemove = () => {
    leaveQueue({
      entry,
      disarm: () => autoCompleteMutation.mutate({ enabled: false }),
    });
  };

  return (
    <li className="bg-glass-light flex items-center gap-2 rounded-lg px-3 py-2">
      <span className="text-ink-3 w-6 shrink-0 text-xs tabular-nums">
        #{position}
      </span>
      {isWaiting ? (
        <GitMerge className="text-ink-3 h-3.5 w-3.5 shrink-0" />
      ) : (
        <Loader2 className="text-status-pr h-3.5 w-3.5 shrink-0 animate-spin" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-ink-1 truncate text-sm">
          !{entry.prId} {entry.prTitle}
        </p>
        <p className="text-ink-3 text-xs">
          {isWaiting
            ? `Waiting${entry.targetBranch ? ` → ${entry.targetBranch}` : ''}`
            : 'Auto-complete armed, waiting for merge'}
        </p>
      </div>
      <button
        onClick={() => move(entry.id, 'up')}
        disabled={!isWaiting || !canMoveUp}
        className="text-ink-3 hover:text-ink-1 rounded p-1 disabled:opacity-30"
        title="Move up"
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => move(entry.id, 'down')}
        disabled={!isWaiting || !canMoveDown}
        className="text-ink-3 hover:text-ink-1 rounded p-1 disabled:opacity-30"
        title="Move down"
      >
        <ArrowDown className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={handleRemove}
        className="text-ink-3 rounded p-1 hover:text-red-400"
        title="Remove from queue"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}
