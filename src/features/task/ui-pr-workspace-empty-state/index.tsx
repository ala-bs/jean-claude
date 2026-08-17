import {
  ArrowDownToLine,
  ArrowUpRight,
  FileText,
  GitPullRequest,
  Loader2,
  Plus,
  Settings2,
  Trash2,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '@/common/ui/button';

export function shouldShowPrWorkspaceEmptyState({
  taskType,
  steps,
}: {
  taskType: string;
  steps: unknown[] | undefined;
}): boolean {
  return taskType === 'pr-review' && steps !== undefined && steps.length === 0;
}

export function PrWorkspaceEmptyState({
  commandControls,
  commandAvailability,
  onAddStep,
  onDelete,
  onOpenLogs,
  onOpenProjectSettings,
  onOpenPullRequest,
  onPull,
  isPulling = false,
  projectName,
  pullRequestId,
}: {
  commandControls: ReactNode;
  commandAvailability: {
    state: 'loading' | 'error' | 'ready';
    hasConfiguredItems: boolean;
    retry: () => Promise<unknown>;
  };
  onAddStep: () => void;
  onDelete: () => void;
  onOpenLogs: () => void;
  onOpenProjectSettings: () => void;
  onOpenPullRequest?: () => void;
  onPull?: () => void;
  isPulling?: boolean;
  projectName: string;
  pullRequestId: string | null;
}) {
  return (
    <div className="flex h-full min-w-0 items-center justify-center overflow-y-auto px-4 py-8 sm:px-8">
      <section className="border-glass-border bg-bg-1/40 w-full max-w-2xl overflow-hidden rounded-xl border shadow-[0_18px_60px_rgba(0,0,0,0.16)]">
        <div className="border-glass-border flex min-w-0 items-center gap-3 border-b px-4 py-3 sm:px-5">
          <div className="bg-acc/15 text-acc-ink flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
            <GitPullRequest className="h-4 w-4" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-ink-0 truncate text-sm font-semibold">
              PR Workspace{pullRequestId ? ` #${pullRequestId}` : ''}
            </div>
            <div className="text-ink-3 truncate text-xs">{projectName}</div>
          </div>
          <span className="border-status-done/25 bg-status-done/10 text-status-done shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase">
            Ready
          </span>
        </div>

        <div className="space-y-5 p-4 sm:p-5">
          <div>
            <h2 className="text-ink-0 text-base font-semibold">
              Ready for your first step
            </h2>
            <p className="text-ink-3 mt-1 max-w-lg text-sm leading-relaxed">
              Add Step creates an agent session in this pull request workspace.
              Use it to investigate, review, or make changes.
            </p>
          </div>

          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="primary"
              size="sm"
              icon={<Plus />}
              onClick={onAddStep}
            >
              Add Step
            </Button>
            {onPull ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon={
                  isPulling ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <ArrowDownToLine />
                  )
                }
                disabled={isPulling}
                onClick={onPull}
              >
                {isPulling ? 'Pulling...' : 'Pull'}
              </Button>
            ) : null}
            {onOpenPullRequest ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon={<ArrowUpRight />}
                onClick={onOpenPullRequest}
              >
                View Pull Request
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              icon={<FileText />}
              onClick={onOpenLogs}
            >
              Logs
            </Button>
            <div className="min-w-0">{commandControls}</div>
            <Button
              type="button"
              variant="danger"
              size="sm"
              icon={<Trash2 />}
              onClick={onDelete}
            >
              Delete PR Workspace
            </Button>
          </div>

          {commandAvailability.state === 'loading' ? (
            <div className="text-ink-3 flex items-center gap-2 px-1 text-xs">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Loading project commands...
            </div>
          ) : commandAvailability.state === 'error' ? (
            <div className="border-status-fail/25 bg-status-fail-soft flex min-w-0 flex-col gap-3 rounded-lg border px-3.5 py-3 sm:flex-row sm:items-center">
              <p className="text-status-fail min-w-0 flex-1 text-xs">
                Could not load project commands.
              </p>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => void commandAvailability.retry()}
              >
                Retry
              </Button>
            </div>
          ) : !commandAvailability.hasConfiguredItems ? (
            <div className="border-glass-border bg-bg-0/45 flex min-w-0 flex-col gap-3 rounded-lg border px-3.5 py-3 sm:flex-row sm:items-center">
              <p className="text-ink-3 min-w-0 flex-1 text-xs leading-relaxed">
                No project commands configured. Add commands in Project Settings
                to run this workspace.
              </p>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                icon={<Settings2 />}
                onClick={onOpenProjectSettings}
                className="self-start sm:self-auto"
              >
                Project Settings
              </Button>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
