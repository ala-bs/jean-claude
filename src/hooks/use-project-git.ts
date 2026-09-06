import type {
  ProjectCommitDetail,
  ProjectCommitFileContent,
  ProjectGitCommit,
  ProjectGitLogFilter,
  ProjectGitStatus,
  ProjectWorkingTreeFile,
} from '@shared/types';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

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

/** How many commits each `Load older commits` step pulls. */
export const PROJECT_GIT_GRAPH_PAGE_SIZE = 60;

/**
 * Stable cache segment for a filter.
 *
 * Branches are sorted so that selecting `a` then `b` and `b` then `a` share a
 * cache entry rather than re-running an identical query.
 */
function filterKey(filter: ProjectGitLogFilter | undefined) {
  return {
    query: filter?.query?.trim() ?? '',
    branches: [...(filter?.branches ?? [])].sort(),
  };
}

export function projectGitGraphKey(
  projectId: string | null,
  filter?: ProjectGitLogFilter,
) {
  return ['project-git-graph', projectId, filterKey(filter)] as const;
}

export function projectCommitCountKey(
  projectId: string | null,
  filter?: ProjectGitLogFilter,
) {
  return ['project-commit-count', projectId, filterKey(filter)] as const;
}

export function projectCommitDetailKey(
  projectId: string | null,
  commitHash: string | null,
) {
  return ['project-commit-detail', projectId, commitHash] as const;
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
  // Deliberately the key *prefix*, without the filter segment: the graph and
  // count are cached per filter, so passing a full key would refresh only the
  // unfiltered view and leave whatever the user is actually looking at stale.
  queryClient.invalidateQueries({ queryKey: ['project-git-graph', projectId] });
  queryClient.invalidateQueries({
    queryKey: ['project-commit-count', projectId],
  });
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

/**
 * Changed paths behind the sync bar's counts.
 *
 * `enabled` is what keeps this lazy: the popover passes `false` until it opens,
 * so a project with a huge diff costs nothing while the panel just sits there.
 */
export function useProjectWorkingTreeFiles(
  projectId: string | null,
  enabled = true,
) {
  return useQuery<ProjectWorkingTreeFile[]>({
    queryKey: ['project-working-tree-files', projectId],
    queryFn: () => {
      if (!projectId) return [];
      return api.projects.git.getWorkingTreeFiles(projectId);
    },
    enabled: !!projectId && enabled,
    staleTime: 3_000,
  });
}

/**
 * Total reachable commits, for the history pane's `n / total loaded` progress.
 *
 * Only changes when commits land, so it is cached far longer than the graph
 * itself; the git mutations below invalidate it explicitly.
 */
export function useProjectCommitCount(
  projectId: string | null,
  filter?: ProjectGitLogFilter,
) {
  return useQuery<number>({
    queryKey: projectCommitCountKey(projectId, filter),
    queryFn: () => {
      if (!projectId) return 0;
      return api.projects.git.getCommitCount(projectId, filter);
    },
    enabled: !!projectId,
    // A filtered count is a live search result, not a slowly-drifting total, so
    // it is not worth serving a minute-old answer for.
    staleTime: isFiltered(filter) ? 15_000 : 60_000,
  });
}

/** Whether a filter actually narrows anything, as opposed to being empty. */
export function isFiltered(filter: ProjectGitLogFilter | undefined): boolean {
  return (
    (filter?.query?.trim().length ?? 0) > 0 ||
    (filter?.branches?.length ?? 0) > 0
  );
}

/**
 * A commit's metadata and file list, for the diff pane.
 *
 * Immutable once written, so it is cached indefinitely — reopening a commit the
 * user already looked at costs nothing.
 */
export function useProjectCommitDetail(
  projectId: string | null,
  commitHash: string | null,
) {
  return useQuery<ProjectCommitDetail | null>({
    queryKey: projectCommitDetailKey(projectId, commitHash),
    queryFn: () => {
      if (!projectId || !commitHash) return null;
      return api.projects.git.getCommitDetail(projectId, commitHash);
    },
    enabled: !!projectId && !!commitHash,
    staleTime: Infinity,
  });
}

/**
 * Both sides of one file in a commit.
 *
 * Fetched per expanded file rather than with the commit detail: a commit
 * touching fifty files would otherwise ship every blob to render the three the
 * user actually opens.
 */
export function useProjectCommitFileContent(
  projectId: string | null,
  commitHash: string | null,
  filePath: string | null,
) {
  return useQuery<ProjectCommitFileContent | null>({
    queryKey: [
      'project-commit-file-content',
      projectId,
      commitHash,
      filePath,
    ] as const,
    queryFn: () => {
      if (!projectId || !commitHash || !filePath) return null;
      return api.projects.git.getCommitFileContent(
        projectId,
        commitHash,
        filePath,
      );
    },
    enabled: !!projectId && !!commitHash && !!filePath,
    staleTime: Infinity,
  });
}

/**
 * Paged history for the redesigned history pane.
 *
 * Pages by commit offset rather than accumulating one ever-growing `--max-count`
 * so scrolling back through a long history stays O(page) per step instead of
 * re-walking the whole log each time.
 *
 * Rows git emits purely to route merge edges carry no commit and are dropped
 * here: the pane derives its own lane geometry from parent hashes, so the
 * ASCII connector rows are noise that would also skew the page-size check.
 */
export function useProjectGitGraphPages(
  projectId: string | null,
  filter?: ProjectGitLogFilter,
) {
  return useInfiniteQuery({
    queryKey: projectGitGraphKey(projectId, filter),
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<ProjectGitCommit[]> => {
      if (!projectId) return [];
      const rows = await api.projects.git.getGraph(
        projectId,
        PROJECT_GIT_GRAPH_PAGE_SIZE,
        pageParam,
        filter,
      );
      // Dropping connectors here (rather than at render time) is what keeps the
      // offset arithmetic below sound: `--skip` counts commits, so a page length
      // that included connector rows would over-skip and silently lose commits.
      return rows
        .map((row) => row.commit)
        .filter((commit): commit is ProjectGitCommit => commit !== null);
    },
    getNextPageParam: (lastPage, allPages) => {
      // A short page means git ran out of commits, so there is nothing after it.
      if (lastPage.length < PROJECT_GIT_GRAPH_PAGE_SIZE) return undefined;
      return allPages.reduce((total, page) => total + page.length, 0);
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
