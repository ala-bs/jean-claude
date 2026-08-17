import {
  AlertCircle,
  Archive,
  GitPullRequestClosed,
  RefreshCw,
  Trash2,
} from 'lucide-react';

import {
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import {
  usePrWorkspaceDecisions,
  useResolvePrWorkspaceDecision,
} from '@/hooks/use-pr-workspace-decisions';
import { Button } from '@/common/ui/button';
import { getPrWorkspaceDeletionDestination } from '@/lib/pr-workspace-navigation';
import { Modal } from '@/common/ui/modal';
import { useHasQueuedModal } from '@/common/context/modal';
import { useToastStore } from '@/stores/toasts';

const preventDismiss = () => {};

export function ClosedPrWorkspaceModal() {
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const {
    data: decisions = [],
    error: loadError,
    isFetching,
    refetch,
  } = usePrWorkspaceDecisions();
  const resolution = useResolvePrWorkspaceDecision();
  const addToast = useToastStore((state) => state.addToast);
  const decision = decisions[0];
  // Queued modals bypass arbitration, so yield explicitly to avoid stacking.
  const hasQueuedModal = useHasQueuedModal();

  const resolve = async (action: 'keep' | 'delete') => {
    if (!decision) return;
    const taskIds = [...decision.taskIds];

    try {
      const result = await resolution.mutateAsync({
        projectId: decision.projectId,
        pullRequestId: decision.pullRequestId,
        action,
        taskIds,
      });
      const destination =
        action === 'delete'
          ? getPrWorkspaceDeletionDestination({
              pathname,
              deletedTaskIds: result.taskIds,
              projectId: decision.projectId,
              pullRequestId: decision.pullRequestId,
            })
          : null;
      if (destination) void navigate(destination);
    } catch (error) {
      addToast({
        message:
          error instanceof Error
            ? error.message
            : 'Failed to resolve PR workspace',
        type: 'error',
      });
    }
  };

  return (
    <Modal
      isOpen={
        !hasQueuedModal && (decision !== undefined || loadError !== null)
      }
      onClose={preventDismiss}
      closeOnClickOutside={false}
      closeOnEscape={false}
      showHeader={false}
      arbitrationPriority={0}
      size="md"
      ariaLabel={
        decision
          ? `Pull request #${decision.pullRequestId} is closed`
          : loadError
            ? 'Unable to load PR workspace decisions'
            : 'Closed pull request workspace'
      }
      ariaDescribedBy="closed-pr-workspace-description"
      panelClassName="overflow-hidden border border-white/[0.08] bg-bg-1 shadow-[0_24px_80px_rgba(0,0,0,0.5)]"
      contentClassName="p-0"
    >
      {!decision && loadError && (
        <div className="p-5">
          <div className="flex gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-400/10 text-red-300">
              <AlertCircle className="h-4.5 w-4.5" aria-hidden />
            </div>
            <div>
              <h2 className="text-ink-0 text-base font-semibold">
                Unable to load PR workspace decisions
              </h2>
              <p
                id="closed-pr-workspace-description"
                className="text-ink-3 mt-1 text-xs leading-5"
                role="alert"
              >
                {loadError instanceof Error
                  ? loadError.message
                  : 'Could not check for pending workspace decisions.'}
              </p>
            </div>
          </div>
          <div className="mt-5 flex justify-end">
            <Button
              data-action="retry"
              autoFocus
              variant="secondary"
              size="md"
              loading={isFetching}
              icon={<RefreshCw />}
              onClick={() => refetch()}
            >
              Retry
            </Button>
          </div>
        </div>
      )}
      {decision && (
        <div>
          <header className="border-glass-border flex gap-3 border-b px-5 py-4">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-amber-300/15 bg-amber-300/[0.07] text-amber-200">
              <GitPullRequestClosed className="h-4.5 w-4.5" aria-hidden />
            </div>
            <div className="min-w-0">
              <h2 className="text-ink-0 text-base font-semibold">
                Pull request #{decision.pullRequestId} is closed
              </h2>
              <p
                id="closed-pr-workspace-description"
                className="text-ink-3 mt-1 text-xs leading-5"
              >
                Choose what happens to its PR Workspace.
              </p>
            </div>
          </header>

          <div className="space-y-2 px-5 py-4">
            <section className="border-glass-border flex gap-3 rounded-lg border bg-white/[0.025] p-3.5">
              <Archive className="text-ink-3 mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <div>
                <h3 className="text-ink-1 text-sm font-medium">Keep workspace</h3>
                <p className="text-ink-3 mt-1 text-xs leading-5">
                  Retains the workspace and all activity. No automatic cleanup
                  occurs, and the workspace remains fully operational.
                </p>
              </div>
            </section>

            <section className="flex gap-3 rounded-lg border border-red-300/10 bg-red-300/[0.025] p-3.5">
              <Trash2 className="mt-0.5 h-4 w-4 shrink-0 text-red-300/80" aria-hidden />
              <div>
                <h3 className="text-ink-1 text-sm font-medium">Delete all</h3>
                <p className="text-ink-3 mt-1 text-xs leading-5">
                  Stops all activity and permanently removes all PR Workspace
                  tasks, histories, worktrees, and local branches for this PR.
                </p>
              </div>
            </section>

            {resolution.error && (
              <p className="pt-1 text-xs text-red-300" role="alert">
                {resolution.error instanceof Error
                  ? resolution.error.message
                  : 'Failed to resolve PR workspace'}
              </p>
            )}
            {loadError && (
              <div
                className="flex items-center justify-between gap-3 rounded-md border border-red-300/15 bg-red-300/[0.04] px-3 py-2"
                role="alert"
              >
                <span className="text-xs text-red-300">
                  Decision status could not be refreshed.
                </span>
                <Button
                  data-action="retry"
                  variant="unstyled"
                  size="sm"
                  loading={isFetching}
                  onClick={() => refetch()}
                  className="text-red-200 hover:text-red-100"
                >
                  Retry
                </Button>
              </div>
            )}
          </div>

          <footer className="border-glass-border flex items-center justify-end gap-2 border-t bg-white/[0.018] px-5 py-3.5">
            <Button
              data-action="keep"
              autoFocus
              variant="secondary"
              size="md"
              disabled={resolution.isPending || loadError !== null || isFetching}
              loading={resolution.isPending && resolution.variables?.action === 'keep'}
              onClick={() => resolve('keep')}
            >
              Keep workspace
            </Button>
            <Button
              data-action="delete"
              variant="danger"
              size="md"
              disabled={resolution.isPending || loadError !== null || isFetching}
              loading={resolution.isPending && resolution.variables?.action === 'delete'}
              onClick={() => resolve('delete')}
            >
              Delete all
            </Button>
          </footer>
        </div>
      )}
    </Modal>
  );
}
