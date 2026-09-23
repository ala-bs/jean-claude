import { Circle, GitMerge, Loader2, Play, X } from 'lucide-react';
import React, {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';

import {
  getAllowedMergeStrategies,
  MERGE_STRATEGY_LABELS,
  type PullRequestRepoInfo,
  useCurrentAzureUser,
  useInvalidatePullRequestDetails,
  usePullRequestPolicyEvaluations,
  useRequeuePolicyEvaluation,
  useSetAutoComplete,
} from '@/hooks/use-pull-requests';
import {
  usePrCompletionQueueEntry,
  usePrCompletionQueueStore,
} from '@/stores/pr-completion-queue';
import type { AzureDevOpsPullRequestDetails } from '@/lib/api';
import { Checkbox } from '@/common/ui/checkbox';
import { ListOrdered } from 'lucide-react';
import type { MergeStrategy } from '@/hooks/use-pull-requests';
import { Modal } from '@/common/ui/modal';
import { useLeavePrCompletionQueue } from '../use-leave-pr-completion-queue';
import { useProject } from '@/hooks/use-projects';
import { useToastStore } from '@/stores/toasts';



import { getCurrentIdentityId } from '../utils-pr-current-user';

// [qac-debug] temporary: last value each project's rows observed, so the
// per-row instrumentation logs transitions instead of one line per row.
const qacLastObserved = new Map<string, boolean | 'no-project'>();

export function PrAutoComplete({
  pr,
  projectId,
  repoInfo,
  variant = 'default',
}: {
  pr: AzureDevOpsPullRequestDetails;
  projectId: string;
  repoInfo?: PullRequestRepoInfo;
  variant?: 'default' | 'compact';
}) {
  const { data: currentUser } = useCurrentAzureUser(projectId, repoInfo);
  const autoCompleteMutation = useSetAutoComplete(projectId, pr.id, repoInfo);
  const requeueMutation = useRequeuePolicyEvaluation(projectId, pr.id, repoInfo);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [queuedIds, setQueuedIds] = useState<Set<string>>(() => new Set());
  const { data: evaluations = [], isPending: isEvaluationsPending } =
    usePullRequestPolicyEvaluations(
      projectId,
      pr.id,
      { refetchInterval: isModalOpen && queuedIds.size > 0 ? 3_000 : false },
      repoInfo,
    );
  const previousEvaluationsRef = useRef(evaluations);
  const invalidatePrDetails = useInvalidatePullRequestDetails(
    projectId,
    pr.id,
    repoInfo,
  );

  const allowedStrategies = useMemo(
    () => getAllowedMergeStrategies(evaluations),
    [evaluations],
  );

  const currentIdentityId = useMemo(() => {
    return getCurrentIdentityId({
      reviewers: pr.reviewers,
      createdBy: pr.createdBy,
      currentUser,
    });
  }, [pr.reviewers, pr.createdBy, currentUser]);

  const isAutoCompleteSet = !!pr.autoCompleteSetBy;

  const { data: project } = useProject(projectId);
  const isQueueEnabled = !!project?.queuePrAutoComplete;

  // [qac-debug] temporary instrumentation for the queue-auto-complete toggle.
  // This component mounts once per PR feed row, so logging every render would
  // emit one line per row per project change and bury the two lines that
  // actually matter. Log only when the observed value transitions.
  useEffect(() => {
    const observed = project ? !!project.queuePrAutoComplete : 'no-project';
    if (qacLastObserved.get(projectId) === observed) return;
    qacLastObserved.set(projectId, observed);
    console.warn('[qac-row] PrAutoComplete observed new value', {
      projectId,
      firstSeenOnPr: pr.id,
      queuePrAutoComplete: observed,
    });
  }, [pr.id, project, projectId]);
  const enqueue = usePrCompletionQueueStore((state) => state.enqueue);
  const queued = usePrCompletionQueueEntry(projectId, pr.id);
  const leaveQueue = useLeavePrCompletionQueue();
  const addToast = useToastStore((state) => state.addToast);

  const handleLeaveQueue = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!queued) return;
      leaveQueue({
        entry: queued.entry,
        disarm: () => autoCompleteMutation.mutate({ enabled: false }),
      });
    },
    [autoCompleteMutation, leaveQueue, queued],
  );

  useEffect(() => {
    if (previousEvaluationsRef.current === evaluations) return;
    // A tracked policy leaving the "queued, no build yet" state means CI
    // actually started, so the PR's policy-derived state is now stale.
    const started = [...queuedIds].filter((id) => {
      const evaluation = evaluations.find((e) => e.evaluationId === id);
      return (
        !evaluation ||
        evaluation.status !== 'queued' ||
        !!evaluation.context?.buildId
      );
    });
    setQueuedIds((prev) => {
      const next = new Set(prev);
      for (const id of started) next.delete(id);
      return next.size === prev.size ? prev : next;
    });
    if (started.length > 0) invalidatePrDetails();
    previousEvaluationsRef.current = evaluations;
    // `queuedIds` is a dep, but the ref guard above makes this a no-op unless
    // the evaluations themselves changed.
  }, [evaluations, invalidatePrDetails, queuedIds]);

  const pendingCi = useMemo(
    () =>
      evaluations.filter(
        (evaluation) =>
          !!evaluation.configuration.settings.buildDefinitionId &&
          evaluation.status === 'queued' &&
          !evaluation.context?.buildId,
      ),
    [evaluations],
  );
  const optionalPolicyConfigIds = useMemo(
    () =>
      evaluations
        .filter((evaluation) => !evaluation.configuration.isBlocking)
        .map((evaluation) => evaluation.configuration.id),
    [evaluations],
  );

  const pendingCiCount = pendingCi.length;

  // Form state for the popover
  const [mergeStrategy, setMergeStrategy] = useState<MergeStrategy>(
    pr.completionOptions?.mergeStrategy ??
      allowedStrategies[0] ??
      'noFastForward',
  );
  const [deleteSourceBranch, setDeleteSourceBranch] = useState(
    pr.completionOptions?.deleteSourceBranch ?? true,
  );
  const [transitionWorkItems, setTransitionWorkItems] = useState(
    pr.completionOptions?.transitionWorkItems ?? false,
  );
  const [mergeCommitMessage, setMergeCommitMessage] = useState(
    pr.completionOptions?.mergeCommitMessage ?? '',
  );
  const [showCommitMessage, setShowCommitMessage] = useState(
    !!pr.completionOptions?.mergeCommitMessage,
  );
  const [ignoreOptionalPolicies, setIgnoreOptionalPolicies] = useState(
    !!pr.completionOptions?.autoCompleteIgnoreConfigIds?.length,
  );

  const resetForm = useCallback(() => {
    setMergeStrategy(
      pr.completionOptions?.mergeStrategy ??
        allowedStrategies[0] ??
        'noFastForward',
    );
    setDeleteSourceBranch(pr.completionOptions?.deleteSourceBranch ?? true);
    setTransitionWorkItems(pr.completionOptions?.transitionWorkItems ?? false);
    setMergeCommitMessage(pr.completionOptions?.mergeCommitMessage ?? '');
    setShowCommitMessage(!!pr.completionOptions?.mergeCommitMessage);
    setIgnoreOptionalPolicies(
      !!pr.completionOptions?.autoCompleteIgnoreConfigIds?.length,
    );
  }, [allowedStrategies, pr.completionOptions]);

  useEffect(() => {
    if (!allowedStrategies.includes(mergeStrategy)) {
      startTransition(() => setMergeStrategy(allowedStrategies[0] ?? 'noFastForward'));
    }
  }, [allowedStrategies, mergeStrategy]);

  // Enqueue with whatever completion options the PR already carries (or sane
  // defaults). The queue is meant to be a single press on the rail item, so it
  // never goes through the modal — the driver arms it and runs its CI later.
  const handleQuickEnqueue = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      // The strategy is snapshotted into the entry and only PATCHed much later,
      // so it must not be guessed from an unresolved policy query:
      // `getAllowedMergeStrategies([])` returns *every* strategy, which would
      // bake `noFastForward` into a squash-only repo and make the arm fail.
      if (!currentIdentityId || isEvaluationsPending) return;
      enqueue({
        projectId,
        prId: pr.id,
        prTitle: pr.title,
        targetBranch: pr.targetRefName.replace('refs/heads/', ''),
        repoInfo,
        autoCompleteSetById: currentIdentityId,
        completionOptions: {
          mergeStrategy:
            pr.completionOptions?.mergeStrategy ??
            allowedStrategies[0] ??
            'noFastForward',
          deleteSourceBranch: pr.completionOptions?.deleteSourceBranch ?? true,
          transitionWorkItems:
            pr.completionOptions?.transitionWorkItems ?? false,
          mergeCommitMessage: pr.completionOptions?.mergeCommitMessage,
          // Mirrors the modal's opt-in checkbox: only ignore optional policies
          // if the PR was already set up that way. Enqueueing must not silently
          // widen what gets waived.
          autoCompleteIgnoreConfigIds: pr.completionOptions
            ?.autoCompleteIgnoreConfigIds?.length
            ? optionalPolicyConfigIds
            : undefined,
        },
      });
      addToast({
        type: 'success',
        message: `PR !${pr.id} added to the completion queue`,
      });
    },
    [
      addToast,
      allowedStrategies,
      currentIdentityId,
      enqueue,
      isEvaluationsPending,
      optionalPolicyConfigIds,
      pr.completionOptions,
      pr.id,
      pr.targetRefName,
      pr.title,
      projectId,
      repoInfo,
    ],
  );

  const handleEnable = useCallback(() => {
    if (!currentIdentityId || autoCompleteMutation.isAnyPending) return;

    const completionOptions = {
      mergeStrategy,
      deleteSourceBranch,
      transitionWorkItems,
      mergeCommitMessage:
        showCommitMessage && mergeCommitMessage ? mergeCommitMessage : undefined,
      autoCompleteIgnoreConfigIds:
        ignoreOptionalPolicies && optionalPolicyConfigIds.length > 0
          ? optionalPolicyConfigIds
          : undefined,
    };

    autoCompleteMutation.mutate(
      { enabled: true, autoCompleteSetById: currentIdentityId, completionOptions },
      { onSuccess: () => setIsModalOpen(false) },
    );
  }, [
    currentIdentityId,
    autoCompleteMutation,
    mergeStrategy,
    deleteSourceBranch,
    transitionWorkItems,
    mergeCommitMessage,
    showCommitMessage,
    ignoreOptionalPolicies,
    optionalPolicyConfigIds,
  ]);

  const handleCancel = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (autoCompleteMutation.isAnyPending) return;
      autoCompleteMutation.mutate({ enabled: false });
    },
    [autoCompleteMutation],
  );

  const handleQueueCi = useCallback(
    (evaluationId: string) => {
      setQueuedIds((prev) => new Set(prev).add(evaluationId));
      requeueMutation.mutate(
        { evaluationId },
        {
          onError: () => {
            setQueuedIds((prev) => {
              const next = new Set(prev);
              next.delete(evaluationId);
              return next;
            });
          },
        },
      );
    },
    [requeueMutation],
  );

  const handleQueueAllCi = useCallback(() => {
    for (const evaluation of pendingCi) {
      if (!queuedIds.has(evaluation.evaluationId)) {
        handleQueueCi(evaluation.evaluationId);
      }
    }
  }, [handleQueueCi, pendingCi, queuedIds]);

  // Queue membership wins over the plain auto-complete chip: once armed, the PR
  // is both auto-completing *and* queued, and the position is the useful bit.
  if (queued) {
    // `arming` is not yet merging — the PATCH is still in flight, and the leave
    // path deliberately does not disarm during it, so the label and the tooltip
    // must not promise a cancel that will not happen.
    const isArmed = queued.entry.status === 'armed';
    const isPending = queued.entry.status !== 'waiting';
    const queuedClassName =
      variant === 'compact'
        ? 'text-status-pr bg-status-pr/10 ring-status-pr/20 ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1'
        : 'bg-status-azure/20 text-status-azure flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium';

    return (
      <div className={queuedClassName}>
        {isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <ListOrdered className="h-3.5 w-3.5" />
        )}
        <span>
          {isArmed
            ? `Merging #${queued.position}`
            : `Queued #${queued.position}`}
        </span>
        <button
          onClick={handleLeaveQueue}
          className="ml-0.5 rounded p-0.5 hover:bg-white/10"
          title={isArmed ? 'Cancel auto-complete' : 'Remove from completion queue'}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    );
  }

  // When auto-complete is already set, show status chip with cancel button
  if (isAutoCompleteSet) {
    const activeClassName =
      variant === 'compact'
        ? 'text-status-done bg-status-done/10 ring-status-done/20 ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1'
        : 'bg-status-done/20 text-status-done flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium';
    const activeMutedClassName =
      variant === 'compact' ? 'text-status-done/70' : 'text-status-done/70';
    const cancelClassName =
      variant === 'compact'
        ? 'ml-0.5 rounded p-0.5 hover:bg-status-done/20'
        : 'hover:bg-status-done/30 ml-1 rounded p-0.5';

    return (
      <div className={activeClassName}>
        <GitMerge className="h-3.5 w-3.5" />
        <span>Auto-complete</span>
        {pr.completionOptions && (
          <span className={activeMutedClassName}>
            ({MERGE_STRATEGY_LABELS[pr.completionOptions.mergeStrategy]})
          </span>
        )}
        <button
          onClick={handleCancel}
          className={cancelClassName}
          title="Unset auto-complete"
          disabled={autoCompleteMutation.isAnyPending}
        >
          {autoCompleteMutation.isAnyPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <X className="h-3 w-3" />
          )}
        </button>
      </div>
    );
  }

  if (!currentIdentityId) return null;

  const triggerClassName =
    variant === 'compact'
      ? 'text-status-pr hover:bg-status-pr/15 ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors disabled:opacity-50'
      : 'bg-glass-medium hover:bg-bg-3 text-ink-1 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50';

  // Show button that opens configuration modal
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          if (isQueueEnabled) {
            handleQuickEnqueue(e);
            return;
          }
          e.stopPropagation();
          resetForm();
          setIsModalOpen(true);
        }}
        className={triggerClassName}
        disabled={
          autoCompleteMutation.isAnyPending ||
          (isQueueEnabled && isEvaluationsPending)
        }
        title={
          isQueueEnabled
            ? 'Add to the completion queue — CI runs automatically when it is its turn'
            : undefined
        }
      >
        {autoCompleteMutation.isAnyPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <GitMerge className="h-3.5 w-3.5" />
        )}
        Set auto-complete
      </button>
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title="Set auto-complete"
        size="md"
      >
        <div className="space-y-4">
          <div className="bg-bg-2 border-glass-border rounded-lg border p-3">
            <div className="text-ink-1 mb-1 text-sm font-medium">#{pr.id}</div>
            <p className="text-ink-3 line-clamp-2 text-xs">{pr.title}</p>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-ink-1 text-sm font-medium">Pending CI</h3>
              {pendingCiCount > 1 && (
                <button
                  type="button"
                  onClick={handleQueueAllCi}
                  disabled={requeueMutation.isPending}
                  className="text-status-pr hover:bg-status-pr/15 flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors disabled:opacity-50"
                >
                  <Play className="h-3 w-3" />
                  Run all
                </button>
              )}
            </div>
            {pendingCiCount === 0 ? (
              <div className="border-glass-border bg-glass-light text-ink-3 rounded-lg border px-3 py-2 text-xs">
                No pending CI needs to be run.
              </div>
            ) : (
              <div className="border-glass-border overflow-hidden rounded-lg border">
                {pendingCi.map((evaluation) => {
                  const isQueued = queuedIds.has(evaluation.evaluationId);
                  const name =
                    evaluation.configuration.settings.displayName ??
                    evaluation.configuration.type.displayName ??
                    `Policy ${evaluation.configuration.id}`;
                  return (
                    <div
                      key={evaluation.evaluationId}
                      className="border-glass-border/60 flex items-center gap-2 border-b px-3 py-2 last:border-b-0"
                    >
                      {isQueued ? (
                        <Loader2 className="h-3.5 w-3.5 text-status-run animate-spin" />
                      ) : (
                        <Circle className="text-ink-3 h-3.5 w-3.5" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-ink-1 truncate text-xs font-medium">
                          {name}
                        </div>
                        <div className="text-ink-4 text-[10.5px]">
                          {isQueued ? 'Queued' : 'Not run yet'}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleQueueCi(evaluation.evaluationId)}
                        disabled={isQueued || requeueMutation.isPending}
                        className="bg-glass-medium hover:bg-bg-3 text-ink-1 flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors disabled:opacity-50"
                      >
                        <Play className="h-3 w-3" />
                        Run
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="border-glass-border rounded-lg border p-3">
            <h3 className="text-ink-1 mb-3 text-sm font-medium">
              Completion options
            </h3>
            <label className="text-ink-2 mb-1 block text-xs">
              Merge strategy
            </label>
            <select
              value={mergeStrategy}
              onChange={(e) =>
                setMergeStrategy(e.target.value as MergeStrategy)
              }
              disabled={allowedStrategies.length <= 1}
              className="bg-bg-2 border-glass-border text-ink-1 mb-3 w-full rounded-lg border px-2 py-1.5 text-xs focus:outline-none"
            >
              {allowedStrategies.map((strategy) => (
                <option key={strategy} value={strategy}>
                  {MERGE_STRATEGY_LABELS[strategy]}
                </option>
              ))}
            </select>

            <Checkbox
              checked={deleteSourceBranch}
              onChange={setDeleteSourceBranch}
              label="Delete source branch"
              className="mb-2 text-xs"
            />

            <Checkbox
              checked={transitionWorkItems}
              onChange={setTransitionWorkItems}
              label="Transition work items"
              className="mb-3 text-xs"
            />

            {optionalPolicyConfigIds.length > 0 && (
              <Checkbox
                checked={ignoreOptionalPolicies}
                onChange={setIgnoreOptionalPolicies}
                label="Ignore optional policies"
                className="mb-3 text-xs"
              />
            )}

            <button
              type="button"
              onClick={() => setShowCommitMessage(!showCommitMessage)}
              className="text-acc-ink mb-2 text-xs hover:underline"
            >
              {showCommitMessage ? 'Hide' : 'Custom'} merge commit message
            </button>

            {showCommitMessage && (
              <textarea
                value={mergeCommitMessage}
                onChange={(e) => setMergeCommitMessage(e.target.value)}
                placeholder={pr.title}
                rows={3}
                className="bg-bg-2 border-glass-border text-ink-1 placeholder:text-ink-4 mb-3 w-full resize-none rounded-lg border px-2 py-1.5 text-xs focus:outline-none"
              />
            )}
          </div>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setIsModalOpen(false)}
              className="text-ink-2 hover:bg-glass-medium hover:text-ink-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleEnable}
              disabled={autoCompleteMutation.isAnyPending}
              className={clsx(
                'bg-acc text-ink-0 hover:bg-acc rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                autoCompleteMutation.isAnyPending && 'opacity-50',
              )}
            >
              {autoCompleteMutation.isAnyPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                'Enable auto-complete'
              )}
            </button>
          </div>

          {autoCompleteMutation.error && (
            <p className="text-status-fail text-xs">
              {autoCompleteMutation.error.message}
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}
