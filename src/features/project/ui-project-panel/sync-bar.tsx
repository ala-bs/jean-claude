import { ArrowDownToLine, ArrowUpFromLine, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { useCallback } from 'react';

import {
  useProjectCheckoutBranch,
  useProjectGitFetch,
  useProjectGitPull,
  useProjectGitPush,
} from '@/hooks/use-project-git';
import { BranchSelect } from '@/common/ui/branch-select';
import { cleanIpcError } from '@/lib/ipc-error';
import type { ProjectGitStatus } from '@shared/types';
import { useProjectBranches } from '@/hooks/use-projects';
import { useToastStore } from '@/stores/toasts';
import { WorkingTreeChips } from './working-tree-popover';

function Divider() {
  return <span className="bg-line h-4 w-px shrink-0" />;
}

/**
 * Branch, divergence, working-tree state and remote actions on one line.
 *
 * Fetch and Pull are grouped into a single segmented control because they are
 * both read-only refreshes; Push is pulled out and accented since it is the
 * only one here that changes the remote.
 */
export function SyncBar({
  projectId,
  status,
}: {
  projectId: string;
  status: ProjectGitStatus;
}) {
  const addToast = useToastStore((state) => state.addToast);
  const { data: branches = [], isLoading: branchesLoading } =
    useProjectBranches(projectId);

  const fetchMutation = useProjectGitFetch();
  const pullMutation = useProjectGitPull();
  const pushMutation = useProjectGitPush();
  const checkoutMutation = useProjectCheckoutBranch();

  const run = useCallback(
    async (
      label: string,
      action: () => Promise<unknown>,
      successMessage?: string,
    ) => {
      try {
        await action();
        if (successMessage) {
          addToast({ message: successMessage, type: 'success' });
        }
      } catch (error) {
        addToast({
          message: `${label} failed: ${cleanIpcError(error)}`,
          type: 'error',
        });
      }
    },
    [addToast],
  );

  const hasUpstream = status.ahead !== null && status.behind !== null;
  const ahead = status.ahead ?? 0;

  return (
    <div className="border-line-soft bg-bg-1 flex shrink-0 flex-wrap items-center gap-3.5 border-b px-5 py-2.5">
      <BranchSelect
        branches={branches}
        branchesLoading={branchesLoading}
        value={status.isDetached ? undefined : status.branch}
        placeholder={status.isDetached ? `detached @ ${status.branch}` : undefined}
        size="sm"
        className="min-w-[200px]"
        disabled={checkoutMutation.isPending}
        onChange={(branchName) => {
          if (branchName === status.branch) return;
          void run(`Checkout ${branchName}`, () =>
            checkoutMutation.mutateAsync({ projectId, branchName }),
          );
        }}
      />

      {hasUpstream ? (
        <div className="flex items-center gap-2.5 font-mono text-xs tabular-nums">
          <span
            title={`${status.ahead} commits to push to ${status.upstream}`}
            className={ahead > 0 ? 'text-acc-ink' : 'text-ink-4'}
          >
            ↑{status.ahead}
          </span>
          <span
            title={`${status.behind} commits to pull from ${status.upstream}`}
            className={
              (status.behind ?? 0) > 0 ? 'text-status-review' : 'text-ink-4'
            }
          >
            ↓{status.behind}
          </span>
        </div>
      ) : (
        <span className="text-ink-3 text-xs whitespace-nowrap">no upstream</span>
      )}

      <Divider />

      <WorkingTreeChips projectId={projectId} status={status} />

      <div className="flex-1" />

      <div className="border-line bg-bg-2 flex items-center gap-0.5 rounded-md border p-0.5">
        <button
          type="button"
          disabled={fetchMutation.isPending}
          onClick={() => run('Fetch', () => fetchMutation.mutateAsync(projectId))}
          className="text-ink-1 hover:bg-glass-light hover:text-ink-0 inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors disabled:opacity-60"
        >
          <RefreshCw
            size={12}
            className={clsx(fetchMutation.isPending && 'animate-spin')}
          />
          {fetchMutation.isPending ? 'Fetching…' : 'Fetch'}
        </button>
        <span className="bg-line h-4 w-px" />
        <button
          type="button"
          disabled={pullMutation.isPending}
          onClick={() => run('Pull', () => pullMutation.mutateAsync(projectId))}
          className="text-ink-1 hover:bg-glass-light hover:text-ink-0 inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors disabled:opacity-60"
        >
          <ArrowDownToLine size={12} />
          {pullMutation.isPending ? 'Pulling…' : 'Pull'}
        </button>
      </div>

      <button
        type="button"
        disabled={pushMutation.isPending}
        onClick={() => run('Push', () => pushMutation.mutateAsync(projectId))}
        className="border-acc-line bg-acc-soft text-acc-ink inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-85 disabled:opacity-60"
      >
        <ArrowUpFromLine size={12} />
        {pushMutation.isPending ? 'Pushing…' : 'Push'}
        {ahead > 0 && (
          <span className="font-mono text-[11px] opacity-75 tabular-nums">
            {ahead}
          </span>
        )}
      </button>
    </div>
  );
}
