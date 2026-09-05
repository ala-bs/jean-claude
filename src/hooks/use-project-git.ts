import type { ProjectGitGraphRow, ProjectGitStatus } from '@shared/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

/** How often the panel re-runs `git fetch` while it stays mounted. */
export const PROJECT_GIT_AUTO_FETCH_INTERVAL_MS = 60_000;

/**
 * Slack subtracted from the interval when deciding whether a fetch is due.
 *
 * `setInterval` fires on a best-effort schedule and the elapsed time is
 * measured against the previous fetch's *start*, so a tick can arrive a few
 * milliseconds shy of the full interval. Comparing against the raw interval
 * would then skip that tick — and, because the next tick is measured the same
 * way, every subsequent one too.
 */
const AUTO_FETCH_TIMER_GRACE_MS = 5_000;
/** How many graph rows we ask git for. */
export const PROJECT_GIT_GRAPH_LIMIT = 200;

export function projectGitStatusKey(projectId: string | null) {
  return ['project-git-status', projectId] as const;
}

export function projectGitGraphKey(projectId: string | null) {
  return ['project-git-graph', projectId] as const;
}

/**
 * Invalidates everything a git operation can change.
 *
 * The branch list is included because fetch/pull can create or delete branches:
 * leaving it out let the switcher serve a stale 30s-cached list that omitted
 * branches the user had just fetched.
 */
function invalidateProjectGit(queryClient: QueryClient, projectId: string) {
  queryClient.invalidateQueries({ queryKey: projectGitStatusKey(projectId) });
  queryClient.invalidateQueries({ queryKey: projectGitGraphKey(projectId) });
  queryClient.invalidateQueries({ queryKey: ['project-branches', projectId] });
  queryClient.invalidateQueries({
    queryKey: ['project-current-branch', projectId],
  });
}

export function useProjectGitStatus(projectId: string | null) {
  return useQuery<ProjectGitStatus | null>({
    queryKey: projectGitStatusKey(projectId),
    queryFn: () => {
      if (!projectId) return null;
      return api.projects.git.getStatus(projectId);
    },
    enabled: !!projectId,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
    // Keep ahead/behind honest between explicit refreshes; the auto-fetch below
    // is what actually updates the remote-tracking refs.
    refetchInterval: PROJECT_GIT_AUTO_FETCH_INTERVAL_MS,
  });
}

export function useProjectGitGraph(projectId: string | null) {
  return useQuery<ProjectGitGraphRow[]>({
    queryKey: projectGitGraphKey(projectId),
    queryFn: () => {
      if (!projectId) return [];
      return api.projects.git.getGraph(projectId, PROJECT_GIT_GRAPH_LIMIT);
    },
    enabled: !!projectId,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Explicit, user-initiated fetch. Runs interactively so it can prompt for
 * credentials, and surfaces failures to the caller — unlike the background
 * refresh in `useProjectGitAutoFetch`, which stays silent.
 */
export function useProjectGitFetch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => api.projects.git.fetch(projectId, true),
    onSuccess: (_, projectId) => invalidateProjectGit(queryClient, projectId),
  });
}

export function useProjectGitPush() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => api.projects.git.push(projectId),
    onSuccess: (_, projectId) => invalidateProjectGit(queryClient, projectId),
  });
}

export function useProjectGitPull() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => api.projects.git.pull(projectId),
    onSuccess: (_, projectId) => invalidateProjectGit(queryClient, projectId),
  });
}

export function useProjectCheckoutBranch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      branchName,
    }: {
      projectId: string;
      branchName: string;
    }) => api.projects.git.checkoutBranch(projectId, branchName),
    onSuccess: (_, { projectId }) => invalidateProjectGit(queryClient, projectId),
  });
}

/**
 * `git fetch` is slow, network bound, and can fail for reasons the user cannot
 * act on (offline, declined credential prompt). It is shared per project so
 * remounting the panel or opening it twice cannot stampede the remote, and
 * failures are swallowed so the panel keeps rendering last-known local state.
 */
const inFlightFetches = new Map<string, Promise<void>>();
const lastFetchAt = new Map<string, number>();

async function fetchProjectGitOnce(
  projectId: string,
  queryClient: QueryClient,
) {
  const pending = inFlightFetches.get(projectId);
  if (pending) return pending;

  // Stamped at the *start*, not on completion: the interval measures from one
  // fetch's start to the next, so comparing against a completion timestamp
  // would leave every tick short of the window and skip it forever.
  lastFetchAt.set(projectId, Date.now());

  const promise = api.projects.git
    .fetch(projectId)
    .then(() => {
      invalidateProjectGit(queryClient, projectId);
    })
    .catch(() => {
      // Offline / auth declined: keep showing last-known local state.
    })
    .finally(() => {
      inFlightFetches.delete(projectId);
    });

  inFlightFetches.set(projectId, promise);
  return promise;
}

/**
 * Runs `git fetch` on mount and then on an interval, de-duplicated across every
 * mounted consumer for the same project.
 *
 * `enabled` lets the caller hold off until it knows the project is actually a
 * git repository, so non-repo projects do not fire a doomed IPC call per tick.
 */
export function useProjectGitAutoFetch(
  projectId: string | null,
  enabled = true,
) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!projectId || !enabled) return;

    let cancelled = false;

    const run = () => {
      if (cancelled) return;
      const last = lastFetchAt.get(projectId) ?? 0;
      const elapsed = Date.now() - last;
      if (
        elapsed <
        PROJECT_GIT_AUTO_FETCH_INTERVAL_MS - AUTO_FETCH_TIMER_GRACE_MS
      ) {
        return;
      }
      void fetchProjectGitOnce(projectId, queryClient);
    };

    run();
    const timer = setInterval(run, PROJECT_GIT_AUTO_FETCH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, projectId, queryClient]);
}
