import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { WorkItemSummaryRequest } from '@shared/work-item-summary-types';

import {
  useBackgroundJobsStore,
  useRunningWorkItemSummaryJob,
} from '@/stores/background-jobs';
import {
  useGenerateWorkItemSummary,
  useWorkItemSummary,
} from '@/hooks/use-work-item-summary';

import clsx from 'clsx';
import { MarkdownContent } from '@/features/agent/ui-markdown-content';
import { useToastStore } from '@/stores/toasts';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to generate summary';
}

export function WorkItemGeneratedSummary({
  request,
  workItemTitle,
  className,
}: {
  request: WorkItemSummaryRequest;
  workItemTitle: string;
  className?: string;
}) {
  const summaryQuery = useWorkItemSummary(request);
  const generateSummary = useGenerateWorkItemSummary();
  const runningJob = useRunningWorkItemSummaryJob(
    request.providerId,
    request.workItemId,
  );
  const addRunningJob = useBackgroundJobsStore((state) => state.addRunningJob);
  const markJobSucceeded = useBackgroundJobsStore(
    (state) => state.markJobSucceeded,
  );
  const markJobFailed = useBackgroundJobsStore((state) => state.markJobFailed);
  const addToast = useToastStore((state) => state.addToast);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const summary = summaryQuery.data;
  const isGenerating = !!runningJob || generateSummary.isPending;

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  async function handleGenerate() {
    if (isGenerating) return;
    setGenerationError(null);
    const jobId = addRunningJob({
      type: 'work-item-summary-generation',
      title: `Summarize work item #${request.workItemId}`,
      projectId: request.projectId,
      details: {
        providerId: request.providerId,
        workItemId: request.workItemId,
        workItemTitle,
        projectName: request.projectName,
      },
    });
    try {
      await generateSummary.mutateAsync(request);
      markJobSucceeded(jobId);
    } catch (error) {
      const message = errorMessage(error);
      setGenerationError(message);
      markJobFailed(jobId, message);
    }
  }

  async function handleCopy() {
    if (!summary) return;
    try {
      await navigator.clipboard.writeText(summary.content);
      setCopied(true);
      addToast({ type: 'success', message: 'Summary copied' });
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      addToast({ type: 'error', message: 'Failed to copy summary' });
    }
  }

  if (summaryQuery.isLoading && !summary) {
    return (
      <div
        className={clsx(
          'border-line bg-surface-1 flex items-center gap-2 border px-4 py-3 text-xs',
          className,
        )}
      >
        <Loader2 className="text-acc h-3.5 w-3.5 animate-spin" />
        <span className="text-ink-3">Loading summary…</span>
      </div>
    );
  }

  return (
    <section
      className={clsx(
        'border-line bg-surface-1/70 relative overflow-hidden border',
        className,
      )}
      aria-label="Generated work item summary"
    >
      <div className="bg-acc absolute inset-y-0 left-0 w-0.5" />
      <header className="border-line flex min-h-11 items-center gap-3 border-b px-4 py-2.5">
        <div className="bg-acc/10 text-acc flex h-7 w-7 shrink-0 items-center justify-center rounded-sm">
          <Sparkles className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-ink-1 font-mono text-[11px] font-semibold uppercase tracking-[0.14em]">
              AI brief
            </h3>
            {summary?.isStale && (
              <span className="bg-status-run/10 text-status-run inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium">
                <AlertTriangle className="h-3 w-3" />
                Source updated
              </span>
            )}
          </div>
          <p className="text-ink-4 mt-0.5 text-[10px]">
            Generated from work item fields and full comment history
          </p>
        </div>
        {summary && (
          <button
            type="button"
            onClick={handleCopy}
            className="text-ink-3 hover:bg-surface-2 hover:text-ink-1 inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-[11px] transition-colors"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
        <button
          type="button"
          aria-disabled={isGenerating}
          onClick={handleGenerate}
          className={clsx(
            'border-line text-ink-2 hover:bg-surface-2 hover:text-ink-0 inline-flex h-7 items-center gap-1.5 rounded-sm border px-2.5 text-[11px] font-medium transition-colors',
            isGenerating && 'cursor-not-allowed opacity-60',
          )}
        >
          {isGenerating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {summary ? 'Regenerate' : 'Generate summary'}
        </button>
      </header>

      {(generationError || (summaryQuery.error && !summary)) && (
        <div className="border-status-fail/20 bg-status-fail/5 text-status-fail border-b px-4 py-2 text-xs">
          {generationError ?? errorMessage(summaryQuery.error)}
        </div>
      )}

      {summary ? (
        <div className="px-4 py-3">
          <MarkdownContent content={summary.content} renderMermaid />
        </div>
      ) : (
        <div className="px-4 py-5 text-center">
          <p className="text-ink-2 text-sm">No generated brief yet</p>
          <p className="text-ink-4 mt-1 text-xs">
            Generate compact context without replacing source details.
          </p>
        </div>
      )}
    </section>
  );
}
