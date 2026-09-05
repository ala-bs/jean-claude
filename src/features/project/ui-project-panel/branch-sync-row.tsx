import { ArrowDownToLine, ArrowUpFromLine, RefreshCw } from 'lucide-react';
import { useCallback } from 'react';

import {
  useProjectCheckoutBranch,
  useProjectGitFetch,
  useProjectGitPull,
  useProjectGitPush,
} from '@/hooks/use-project-git';
import { BranchSelect } from '@/common/ui/branch-select';
import { Button } from '@/common/ui/button';
import { cleanIpcError } from '@/lib/ipc-error';
import type { ProjectGitStatus } from '@shared/types';
import { useProjectBranches } from '@/hooks/use-projects';
import { useToastStore } from '@/stores/toasts';

export function BranchSyncRow({
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

  return (
    <div className="flex flex-wrap items-center gap-2">
      <BranchSelect
        branches={branches}
        branchesLoading={branchesLoading}
        value={status.isDetached ? undefined : status.branch}
        placeholder={status.isDetached ? `detached @ ${status.branch}` : undefined}
        size="sm"
        className="min-w-[220px]"
        disabled={checkoutMutation.isPending}
        onChange={(branchName) => {
          if (branchName === status.branch) return;
          void run(`Checkout ${branchName}`, () =>
            checkoutMutation.mutateAsync({ projectId, branchName }),
          );
        }}
      />

      {hasUpstream ? (
        <span className="text-ink-2 flex items-center gap-2 text-xs tabular-nums">
          <span title={`${status.ahead} ahead of ${status.upstream}`}>
            ↑{status.ahead}
          </span>
          <span title={`${status.behind} behind ${status.upstream}`}>
            ↓{status.behind}
          </span>
        </span>
      ) : (
        <span className="text-ink-3 text-xs">no upstream</span>
      )}

      <div className="ml-auto flex items-center gap-2">
        <Button
          size="sm"
          icon={<RefreshCw />}
          loading={fetchMutation.isPending}
          disabled={fetchMutation.isPending}
          onClick={() =>
            run('Fetch', () => fetchMutation.mutateAsync(projectId))
          }
        >
          {fetchMutation.isPending ? 'Fetching…' : 'Fetch'}
        </Button>
        <Button
          size="sm"
          icon={<ArrowDownToLine />}
          loading={pullMutation.isPending}
          disabled={pullMutation.isPending}
          onClick={() => run('Pull', () => pullMutation.mutateAsync(projectId))}
        >
          {pullMutation.isPending ? 'Pulling…' : 'Pull'}
        </Button>
        <Button
          size="sm"
          icon={<ArrowUpFromLine />}
          loading={pushMutation.isPending}
          disabled={pushMutation.isPending}
          onClick={() => run('Push', () => pushMutation.mutateAsync(projectId))}
        >
          {pushMutation.isPending ? 'Pushing…' : 'Push'}
        </Button>
      </div>
    </div>
  );
}
