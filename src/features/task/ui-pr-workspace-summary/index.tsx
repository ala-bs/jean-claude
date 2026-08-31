import { GitBranch, Loader2 } from 'lucide-react';

import { AzureMarkdownContent } from '@/features/common/ui-azure-html-content';
import { usePullRequest } from '@/hooks/use-pull-requests';

export function formatRefName(refName: string | undefined): string {
  if (!refName) return '';
  return refName.replace(/^refs\/heads\//, '');
}

/**
 * PR title + description block shown on the PR workspace overview page so the
 * workspace is readable without jumping to the PR detail view.
 */
export function PrWorkspaceSummary({
  projectId,
  pullRequestId,
  providerId,
}: {
  projectId: string;
  pullRequestId: string;
  providerId?: string;
}) {
  const prId = Number(pullRequestId);
  const { data: pr, isLoading } = usePullRequest(
    projectId,
    Number.isFinite(prId) ? prId : 0,
  );

  if (isLoading && !pr) {
    return (
      <div className="text-ink-3 flex items-center gap-2 text-xs">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        Loading pull request...
      </div>
    );
  }

  if (!pr) return null;

  const sourceBranch = formatRefName(pr.sourceRefName);
  const targetBranch = formatRefName(pr.targetRefName);
  const description = pr.description?.trim() ?? '';

  return (
    <div className="border-glass-border bg-bg-0/45 min-w-0 rounded-lg border px-3.5 py-3">
      <div className="flex min-w-0 items-start gap-2">
        <h3 className="text-ink-0 min-w-0 flex-1 text-sm font-semibold break-words">
          {pr.title}
        </h3>
        {pr.isDraft ? (
          <span className="border-line text-ink-3 shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase">
            Draft
          </span>
        ) : null}
      </div>

      {sourceBranch && targetBranch ? (
        <div className="text-ink-3 mt-1 flex min-w-0 items-center gap-1.5 text-xs">
          <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">{sourceBranch}</span>
          <span aria-hidden>→</span>
          <span className="truncate">{targetBranch}</span>
        </div>
      ) : null}

      {/* No inner scroll cap — the card body scrolls as a single surface. */}
      <div className="border-glass-border mt-3 min-w-0 border-t pt-3">
        {description ? (
          <AzureMarkdownContent
            markdown={description}
            providerId={providerId}
            className="text-ink-1 text-sm"
            imageClassName="max-h-[320px] object-contain"
            enableImageModal
          />
        ) : (
          <p className="text-ink-3 text-xs italic">No description</p>
        )}
      </div>
    </div>
  );
}
