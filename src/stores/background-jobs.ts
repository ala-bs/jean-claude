import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { persist } from 'zustand/middleware';
import { useMemo } from 'react';


import { api } from '@/lib/api';

export type BackgroundJobType =
  | 'task-creation'
  | 'skill-creation'
  | 'pr-creation'
  | 'pr-review-creation'
  | 'summary-generation'
  | 'work-item-summary-generation'
  | 'project-summary-generation'
  | 'logo-generation'
  | 'verification-note'
  | 'step-start'
  | 'task-completion'
  | 'task-deletion'
  | 'commit'
  | 'merge'
  | 'worktree-cleanup'
  | 'pipeline-run'
  | 'agent-memory-extraction';
export type BackgroundJobStatus = 'running' | 'succeeded' | 'failed';

interface BackgroundJobBase {
  id: string;
  title: string;
  status: BackgroundJobStatus;
  createdAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  warningMessage: string | null;
  taskId: string | null;
  projectId: string | null;
  noteId: string | null;
}

export type BackgroundJob =
  | (BackgroundJobBase & {
      type: 'task-creation';
      details: {
        projectName: string | null;
        promptPreview: string | null;
        creationInput: Parameters<typeof api.tasks.createWithWorktree>[0];
        backlogTodoIds: string[];
      };
    })
  | (BackgroundJobBase & {
      type: 'skill-creation';
      details: {
        promptPreview: string | null;
      };
    })
  | (BackgroundJobBase & {
      type: 'pr-creation';
      details: {
        title: string;
        branchName: string;
      };
    })
  | (BackgroundJobBase & {
      type: 'pr-review-creation';
      details: {
        pullRequestId: number;
        created?: boolean;
      };
    })
  | (BackgroundJobBase & {
      type: 'summary-generation';
      details: {
        taskName: string | null;
      };
    })
  | (BackgroundJobBase & {
      type: 'work-item-summary-generation';
      details: {
        providerId: string;
        workItemId: number;
        workItemTitle: string;
        projectName: string;
      };
    })
  | (BackgroundJobBase & {
      type: 'project-summary-generation';
      details: {
        projectName: string | null;
      };
    })
  | (BackgroundJobBase & {
      type: 'agent-memory-extraction';
      details: {
        projectName: string | null;
      };
    })
  | (BackgroundJobBase & {
      type: 'logo-generation';
      details: {
        projectName: string | null;
        customPrompt: string | null;
      };
    })
  | (BackgroundJobBase & {
      type: 'verification-note';
      details: {
        workItemCount: number;
        workItemTitles: string[];
      };
    })
  | (BackgroundJobBase & {
      type: 'step-start';
      details: {
        stepId?: string;
        stepName: string;
      };
    })
  | (BackgroundJobBase & {
      type: 'task-completion';
      details: {
        cleanupWorktree: boolean | null;
      };
    })
  | (BackgroundJobBase & {
      type: 'task-deletion';
      details: {
        taskName: string | null;
        projectName: string | null;
        deleteWorktree: boolean;
      };
    })
  | (BackgroundJobBase & {
      type: 'commit';
      details: {
        message: string;
      };
    })
  | (BackgroundJobBase & {
      type: 'merge';
      details: {
        branchName: string;
        targetBranch: string;
      };
    })
  | (BackgroundJobBase & {
      type: 'worktree-cleanup';
      details: {
        branchName: string;
        worktreePath: string;
      };
    })
  | (BackgroundJobBase & {
      type: 'pipeline-run';
      details: {
        pipelineName: string;
        runName: string;
        runId: number;
        kind: 'build' | 'release';
      };
    });

type NewBackgroundJobInput =
  | {
      type: 'task-creation';
      title: string;
      taskId?: string | null;
      projectId?: string | null;
      details: {
        projectName: string | null;
        promptPreview: string | null;
        creationInput: Parameters<typeof api.tasks.createWithWorktree>[0];
        backlogTodoIds: string[];
      };
    }
  | {
      type: 'skill-creation';
      title: string;
      taskId?: string | null;
      projectId?: string | null;
      details: {
        promptPreview: string | null;
      };
    }
  | {
      type: 'pr-creation';
      title: string;
      taskId?: string | null;
      projectId?: string | null;
      details: {
        title: string;
        branchName: string;
      };
    }
  | {
      type: 'pr-review-creation';
      title: string;
      taskId?: string | null;
      projectId?: string | null;
      details: {
        pullRequestId: number;
      };
    }
  | {
      type: 'summary-generation';
      title: string;
      taskId?: string | null;
      projectId?: string | null;
      details: {
        taskName: string | null;
      };
    }
  | {
      type: 'work-item-summary-generation';
      title: string;
      taskId?: string | null;
      projectId?: string | null;
      details: {
        providerId: string;
        workItemId: number;
        workItemTitle: string;
        projectName: string;
      };
    }
  | {
      type: 'project-summary-generation';
      title: string;
      taskId?: string | null;
      projectId?: string | null;
      details: {
        projectName: string | null;
      };
    }
  | {
      type: 'agent-memory-extraction';
      title: string;
      taskId?: string | null;
      projectId?: string | null;
      details: {
        projectName: string | null;
      };
    }
  | {
      type: 'logo-generation';
      title: string;
      taskId?: string | null;
      projectId?: string | null;
      details: {
        projectName: string | null;
        customPrompt: string | null;
      };
    }
  | {
      type: 'verification-note';
      title: string;
      taskId?: string | null;
      projectId?: string | null;
      noteId?: string | null;
      details: {
        workItemCount: number;
        workItemTitles: string[];
      };
    }
  | {
      type: 'step-start';
      title: string;
      taskId?: string | null;
      projectId?: string | null;
      details: {
        stepId?: string;
        stepName: string;
      };
    }
  | {
      type: 'task-completion';
      title: string;
      taskId?: string | null;
      projectId?: string | null;
      details: {
        cleanupWorktree: boolean | null;
      };
    }
  | {
      type: 'task-deletion';
      title: string;
      taskId?: string | null;
      projectId?: string | null;
      details: {
        taskName: string | null;
        projectName: string | null;
        deleteWorktree: boolean;
      };
    }
  | {
      type: 'commit';
      title: string;
      taskId?: string | null;
      projectId?: string | null;
      details: {
        message: string;
      };
    }
  | {
      type: 'merge';
      title: string;
      taskId?: string | null;
      projectId?: string | null;
      details: {
        branchName: string;
        targetBranch: string;
      };
    }
  | {
      type: 'worktree-cleanup';
      title: string;
      taskId?: string | null;
      projectId?: string | null;
      details: {
        branchName: string;
        worktreePath: string;
      };
    }
  | {
      type: 'pipeline-run';
      title: string;
      taskId?: string | null;
      projectId?: string | null;
      details: {
        pipelineName: string;
        runName: string;
        runId: number;
        kind: 'build' | 'release';
      };
    };

interface BackgroundJobsState {
  jobs: BackgroundJob[];
  addRunningJob: (job: NewBackgroundJobInput) => string;
  markJobSucceeded: (
    id: string,
    data?: {
      taskId?: string | null;
      projectId?: string | null;
      noteId?: string | null;
      warningMessage?: string | null;
    },
  ) => void;
  markPrReviewJobSucceeded: (
    id: string,
    data: { taskId: string; projectId: string; created: boolean },
  ) => void;
  markJobFailed: (id: string, errorMessage: string) => void;
  markJobRunning: (id: string) => void;
  clearFinished: () => void;
  /**
   * Boot repair: fail jobs interrupted by the restart and drop everything not
   * worth keeping (see `prunePersistedJobs`), in a single write.
   */
  repairAfterRestart: () => void;
}

/** Max finished jobs kept in localStorage. Running jobs are always kept. */
const MAX_PERSISTED_FINISHED_JOBS = 50;
/** Finished jobs older than this are dropped from localStorage. */
const FINISHED_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Hard ceiling for the serialized payload (~5MB total localStorage quota). */
const MAX_PERSISTED_BYTES = 512 * 1024;

/**
 * Timestamp a finished job is aged against. Unparseable dates count as expired;
 * future dates (clock skew) are clamped so they cannot become immortal or hog
 * the byte budget ahead of legitimate jobs.
 */
/**
 * `prunePersistedJobs` runs on every store write, so an overflow would otherwise
 * log on every keystroke-triggered job update. Warn once per session.
 */
let warnedBudgetOverflow = false;
function warnBudgetOverflowOnce(
  running: number,
  failed: number,
  overflowBytes: number,
): void {
  if (warnedBudgetOverflow) return;
  warnedBudgetOverflow = true;
  console.error(
    `${running} running + ${failed} failed background jobs exceed the ${MAX_PERSISTED_BYTES} byte persistence budget by ${overflowBytes} bytes — localStorage writes may start failing`,
  );
}

/** Test seam: reset the once-per-session overflow warning. */
export function resetBudgetOverflowWarning(): void {
  warnedBudgetOverflow = false;
}

function finishedAt(job: BackgroundJob, now: number): number {
  const raw = job.completedAt ?? job.createdAt;
  const parsed = raw ? new Date(raw).getTime() : Number.NaN;
  if (!Number.isFinite(parsed)) return Number.NEGATIVE_INFINITY;
  return Math.min(parsed, now);
}

/**
 * `jobs` grew without bound: it only shrank on an explicit `clearFinished()`.
 * The serialized `background-jobs` key reached 4.6MB of the ~5MB localStorage
 * origin quota, so `localStorage.setItem` started throwing QuotaExceededError.
 * Zustand's persist middleware does not catch it, so the throw escapes through
 * whichever action triggered the write (usually an unhandled rejection in a React
 * handler): in-memory state updates, the disk write is lost, and unrelated stores
 * that write afterwards fail the same way — which is why settings appeared to
 * reset at random on restart.
 *
 * Keeps every running job, then the most recent finished ones within budget.
 * Eviction prefers keeping `failed` jobs over `succeeded` ones because only
 * failed jobs are actionable after a restart (retry / copy prompt).
 */
export function prunePersistedJobs(
  jobs: BackgroundJob[],
  { enforceByteBudget = true }: { enforceByteBudget?: boolean } = {},
): BackgroundJob[] {
  // A corrupt persisted value must not throw: the caller is `onRehydrateStorage`,
  // where a throw is swallowed by zustand and would skip the rest of boot repair.
  if (!Array.isArray(jobs)) return [];

  const now = Date.now();
  const running: BackgroundJob[] = [];
  const finished: BackgroundJob[] = [];

  for (const job of jobs) {
    if (job.status === 'running') {
      running.push(job);
      continue;
    }
    if (now - finishedAt(job, now) > FINISHED_JOB_TTL_MS) continue;
    finished.push(job);
  }

  // Newest first, and never rely on insertion order.
  const byRecency = (list: BackgroundJob[]) =>
    [...list].sort((a, b) => finishedAt(b, now) - finishedAt(a, now));

  // The count cap is applied FIRST, on the merged recency list, so it stays
  // status-blind: a burst of failures must not push all succeeded history out,
  // and the byte budget below is never charged for a job a later slice would
  // have thrown away anyway.
  const capped = byRecency(finished).slice(0, MAX_PERSISTED_FINISHED_JOBS);
  if (!enforceByteBudget) return [...running, ...capped];

  // Under byte pressure the status does matter: failed jobs are the only
  // actionable ones after a restart (retry / copy prompt), so they get first
  // claim on the budget and succeeded jobs are the disposable bulk. Nothing
  // finished is exempt though — 40 interrupted jobs carrying large prompts all
  // become `failed` at once on boot, and an exemption there would persist
  // megabytes and re-create the original quota bug.
  const failed = capped.filter((job) => job.status === 'failed');
  const succeeded = capped.filter((job) => job.status !== 'failed');

  // Hard byte ceiling. Each job is serialized exactly once — `partialize` runs
  // on every store write, so this must stay linear.
  let budget = MAX_PERSISTED_BYTES;
  // Running jobs are the only exempt category: they are live work the app still
  // has to track, and dropping them would orphan in-flight operations.
  for (const job of running) budget -= JSON.stringify(job).length * 2;

  if (budget < 0) {
    // Running jobs alone overflow the budget — not recoverable here without
    // orphaning live work, so say so once rather than letting a
    // QuotaExceededError surface somewhere unrelated later.
    warnBudgetOverflowOnce(running.length, failed.length, -budget);
  }

  // `break`, not `continue`: each kept set stays a strict newest-first prefix,
  // so a small old job can never leapfrog a larger newer one.
  const takeWithinBudget = (list: BackgroundJob[]) => {
    const kept: BackgroundJob[] = [];
    for (const job of list) {
      const bytes = JSON.stringify(job).length * 2;
      if (bytes > budget) break;
      budget -= bytes;
      kept.push(job);
    }
    return kept;
  };

  // Failed first: they get first claim on whatever budget the running jobs left.
  const keptFailed = takeWithinBudget(failed);
  const keptSucceeded = takeWithinBudget(succeeded);

  const keptFinished = byRecency([...keptFailed, ...keptSucceeded]);
  return [...running, ...keptFinished];
}

export const useBackgroundJobsStore = create<BackgroundJobsState>()(
  persist(
    (set) => ({
      jobs: [],

      addRunningJob: (jobInput) => {
        const {
          type,
          title,
          taskId = null,
          projectId = null,
          details,
        } = jobInput;
        const noteId = 'noteId' in jobInput ? (jobInput.noteId ?? null) : null;
        const id = nanoid();
        const createdAt = new Date().toISOString();
        const runningJob = {
          id,
          type,
          title,
          status: 'running' as const,
          createdAt,
          completedAt: null,
          errorMessage: null,
          warningMessage: null,
          taskId,
          projectId,
          noteId,
          details,
        } as BackgroundJob;

        // Prune in memory on the one action that grows the list, so it stays
        // bounded for long-lived sessions instead of only being trimmed on the
        // way to disk. Count/TTL only: byte eviction is a persistence concern,
        // and applying it here would make history the user is looking at vanish
        // the moment they start an unrelated job.
        set((state) => ({
          jobs: prunePersistedJobs([runningJob, ...state.jobs], {
            enforceByteBudget: false,
          }),
        }));
        return id;
      },

      markJobSucceeded: (id, data) => {
        const completedAt = new Date().toISOString();
        set((state) => ({
          jobs: state.jobs.map((job): BackgroundJob => {
            if (job.id !== id) return job;
            const success = {
              status: 'succeeded' as const,
              completedAt,
              errorMessage: null,
              warningMessage: data?.warningMessage ?? job.warningMessage,
              taskId: data?.taskId ?? job.taskId,
              projectId: data?.projectId ?? job.projectId,
              noteId: data?.noteId ?? job.noteId,
            };
            return { ...job, ...success };
          }),
        }));
      },

      markPrReviewJobSucceeded: (id, data) => {
        const completedAt = new Date().toISOString();
        set((state) => ({
          jobs: state.jobs.map((job) =>
            job.id === id && job.type === 'pr-review-creation'
              ? {
                  ...job,
                  status: 'succeeded',
                  completedAt,
                  errorMessage: null,
                  taskId: data.taskId,
                  projectId: data.projectId,
                  details: { ...job.details, created: data.created },
                }
              : job,
          ),
        }));
      },

      markJobFailed: (id, errorMessage) => {
        const completedAt = new Date().toISOString();
        set((state) => ({
          jobs: state.jobs.map((job) =>
            job.id === id
              ? {
                  ...job,
                  status: 'failed',
                  completedAt,
                  errorMessage,
                  warningMessage: null,
                }
              : job,
          ),
        }));
      },

      markJobRunning: (id) => {
        set((state) => ({
          jobs: state.jobs.map((job) =>
            job.id === id
              ? {
                  ...job,
                  status: 'running',
                  completedAt: null,
                  errorMessage: null,
                  warningMessage: null,
                }
              : job,
          ),
        }));
      },

      clearFinished: () => {
        set((state) => ({
          jobs: state.jobs.filter((job) => job.status === 'running'),
        }));
      },

      repairAfterRestart: () => {
        const completedAt = new Date().toISOString();
        set((state) => ({
          // Fail interrupted jobs FIRST, then prune: running jobs are exempt
          // from eviction, so pruning first would leave a multi-megabyte payload
          // of jobs that are about to become failed anyway.
          jobs: prunePersistedJobs(
            (Array.isArray(state.jobs) ? state.jobs : []).map(
              (job): BackgroundJob =>
                job.status === 'running'
                  ? {
                      ...job,
                      status: 'failed',
                      completedAt,
                      errorMessage: 'Interrupted by app restart',
                      warningMessage: null,
                    }
                  : job,
            ),
          ),
        }));
      },
    }),
    {
      name: 'background-jobs',
      partialize: (state) => ({ jobs: prunePersistedJobs(state.jobs) }),
      onRehydrateStorage: () => (state, error) => {
        if (!state || error) return;
        // Unconditional: an app upgrading from a build that persisted the jobs
        // list unbounded arrives here holding a multi-megabyte array. Repair
        // must not depend on the user happening to start a job, otherwise the
        // origin quota stays exhausted and unrelated stores keep losing writes.
        // A single `set` — it is what rewrites the shrunken value to disk, and
        // one write per interrupted job would re-serialize the whole list N times
        // and re-render every consumer N times before first paint.
        try {
          state.repairAfterRestart();
        } catch (repairError) {
          // Zustand swallows anything thrown here (it re-enters this callback
          // with `state === undefined`), which would leave interrupted jobs
          // spinning forever with no clue why. A failed write is survivable —
          // in-memory state is already repaired — but it must be visible.
          console.error(
            'Failed to repair background jobs after restart',
            repairError,
          );
        }
      },
    },
  ),
);

/** Human-readable label for a background job type. */
export function bgJobLabel(type: BackgroundJobType): string {
  switch (type) {
    case 'task-deletion':
      return 'Deleting…';
    case 'commit':
      return 'Committing…';
    case 'merge':
      return 'Merging…';
    case 'summary-generation':
      return 'Generating summary…';
    case 'work-item-summary-generation':
      return 'Generating work item summary…';
    case 'project-summary-generation':
      return 'Generating project summary…';
    case 'logo-generation':
      return 'Generating logo…';
    case 'verification-note':
      return 'Generating verification note…';
    case 'step-start':
      return 'Starting step…';
    case 'task-completion':
      return 'Completing…';
    case 'task-creation':
      return 'Creating…';
    case 'skill-creation':
      return 'Creating skill…';
    case 'pr-creation':
      return 'Creating PR…';
    case 'pr-review-creation':
      return 'Creating review workspace…';
    case 'worktree-cleanup':
      return 'Cleaning up worktree…';
    case 'pipeline-run':
      return 'Running pipeline…';
    case 'agent-memory-extraction':
      return 'Extracting agent memory…';
  }
}

export function getRunningJobsCount(jobs: BackgroundJob[]) {
  return jobs.filter((job) => job.status === 'running').length;
}

const EMPTY_RUNNING_JOBS: BackgroundJob[] = [];

/** Returns running background jobs linked to a given task. */
export function useRunningBackgroundJobsForTask(taskId: string | null) {
  const jobs = useBackgroundJobsStore((state) => state.jobs);

  return useMemo(
    () =>
      taskId
        ? jobs.filter(
            (job) => job.status === 'running' && job.taskId === taskId,
          )
        : EMPTY_RUNNING_JOBS,
    [jobs, taskId],
  );
}

export function useRunningWorkItemSummaryJob(
  providerId: string,
  workItemId: number,
) {
  return useBackgroundJobsStore((state) =>
    state.jobs.find(
      (job) =>
        job.type === 'work-item-summary-generation' &&
        job.status === 'running' &&
        job.details.providerId === providerId &&
        job.details.workItemId === workItemId,
    ),
  );
}

/** Returns true when a running task-creation job is linked to the given backlog item. */
export function useBackgroundNewTaskJobForBacklogItem({
  itemId,
}: {
  itemId: string;
}) {
  return useBackgroundJobsStore((state) =>
    state.jobs.some(
      (job) =>
        job.type === 'task-creation' &&
        job.status === 'running' &&
        job.details.backlogTodoIds.includes(itemId),
    ),
  );
}
