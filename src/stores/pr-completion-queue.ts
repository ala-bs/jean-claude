// Serialized "set PR to auto-complete" queue.
//
// Azure DevOps happily accepts auto-complete on several PRs targeting the same
// branch at once, but only the first one actually merges — the rest come back
// with conflicts once the target branch moves. This store holds an ordered
// per-project queue so exactly one PR is armed at a time; the driver
// (`ui-pr-completion-queue-driver`) walks it.
//
// Deliberately NOT persisted: an armed PR is only meaningful while the app can
// poll it, so the queue resets on restart rather than resuming stale state.

import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { useMemo } from 'react';

import type { PullRequestRepoInfo } from '@/hooks/use-pull-requests';

/**
 * `waiting`   — enqueued, nothing sent to Azure yet.
 * `arming`    — the auto-complete PATCH is in flight.
 * `armed`     — Azure accepted auto-complete; we are polling for the merge.
 */
export type PrCompletionQueueEntryStatus = 'waiting' | 'arming' | 'armed';

export type PrCompletionQueueCompletionOptions = {
  mergeStrategy: string;
  deleteSourceBranch: boolean;
  transitionWorkItems: boolean;
  mergeCommitMessage?: string;
  autoCompleteIgnoreConfigIds?: number[];
};

export interface PrCompletionQueueEntry {
  id: string;
  projectId: string;
  prId: number;
  prTitle: string;
  targetBranch: string | null;
  repoInfo?: PullRequestRepoInfo;
  autoCompleteSetById?: string;
  completionOptions: PrCompletionQueueCompletionOptions;
  status: PrCompletionQueueEntryStatus;
  enqueuedAt: string;
  /** Background job id, so the driver can resolve the job on settle. */
  jobId: string | null;
}

interface PrCompletionQueueState {
  /** Flat list; array order IS queue order, across all projects. */
  entries: PrCompletionQueueEntry[];

  enqueue: (
    input: Omit<PrCompletionQueueEntry, 'id' | 'status' | 'enqueuedAt' | 'jobId'>,
  ) => string;
  remove: (entryId: string) => void;
  setStatus: (entryId: string, status: PrCompletionQueueEntryStatus) => void;
  setJobId: (entryId: string, jobId: string) => void;
  /** Move an entry one slot earlier/later within its own project's queue. */
  move: (entryId: string, direction: 'up' | 'down') => void;
  clearProject: (projectId: string) => void;
}

export const usePrCompletionQueueStore = create<PrCompletionQueueState>(
  (set) => ({
    entries: [],

    enqueue: (input) => {
      const id = nanoid();
      set((state) => {
        // Re-enqueuing an already-queued PR is a no-op rather than a duplicate:
        // two entries for one PR would arm it twice and double-count failures.
        const existing = state.entries.find(
          (e) => e.projectId === input.projectId && e.prId === input.prId,
        );
        if (existing) return state;

        return {
          entries: [
            ...state.entries,
            {
              ...input,
              id,
              status: 'waiting' as const,
              enqueuedAt: new Date().toISOString(),
              jobId: null,
            },
          ],
        };
      });
      return id;
    },

    remove: (entryId) =>
      set((state) => ({
        entries: state.entries.filter((e) => e.id !== entryId),
      })),

    setStatus: (entryId, status) =>
      set((state) => {
        const target = state.entries.find((e) => e.id === entryId);
        if (!target || target.status === status) return state;
        return {
          entries: state.entries.map((e) =>
            e.id === entryId ? { ...e, status } : e,
          ),
        };
      }),

    setJobId: (entryId, jobId) =>
      set((state) => {
        const target = state.entries.find((e) => e.id === entryId);
        if (!target || target.jobId === jobId) return state;
        return {
          entries: state.entries.map((e) =>
            e.id === entryId ? { ...e, jobId } : e,
          ),
        };
      }),

    move: (entryId, direction) =>
      set((state) => {
        const entry = state.entries.find((e) => e.id === entryId);
        if (!entry) return state;
        // The head is already armed against Azure, so it stays put.
        if (entry.status !== 'waiting') return state;

        const siblings = state.entries.filter(
          (e) => e.projectId === entry.projectId,
        );
        const index = siblings.findIndex((e) => e.id === entryId);
        const swapWith = direction === 'up' ? index - 1 : index + 1;
        if (swapWith < 0 || swapWith >= siblings.length) return state;
        if (siblings[swapWith].status !== 'waiting') return state;

        // Reorder within the project slice, then splice it back into the flat
        // list at the same global positions the project occupied.
        const reordered = [...siblings];
        [reordered[index], reordered[swapWith]] = [
          reordered[swapWith],
          reordered[index],
        ];

        let cursor = 0;
        return {
          entries: state.entries.map((e) =>
            e.projectId === entry.projectId ? reordered[cursor++] : e,
          ),
        };
      }),

    clearProject: (projectId) =>
      set((state) => ({
        entries: state.entries.filter((e) => e.projectId !== projectId),
      })),
  }),
);

/** Distinct project ids that currently have queued entries. */
export function usePrCompletionQueueProjectIds() {
  const entries = usePrCompletionQueueStore((state) => state.entries);
  return useMemo(
    () => [...new Set(entries.map((e) => e.projectId))],
    [entries],
  );
}

/**
 * Queue state for a single PR: its 1-based position within its project's queue.
 * Returns null when the PR is not queued.
 */
export function usePrCompletionQueueEntry(projectId: string, prId: number) {
  const entries = usePrCompletionQueueStore((state) => state.entries);
  return useMemo(() => {
    const scoped = entries.filter((e) => e.projectId === projectId);
    const index = scoped.findIndex((e) => e.prId === prId);
    if (index === -1) return null;
    return { entry: scoped[index], position: index + 1 };
  }, [entries, projectId, prId]);
}
