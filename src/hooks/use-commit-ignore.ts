import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  addCommitIgnoreEntries,
  canUnignoreCommitPaths,
  createCommitIgnoreMatcher,
  matchesCommitIgnore,
  removeCommitIgnoreEntries,
} from '@shared/commit-ignore';
import { api } from '@/lib/api';
import { useToastStore } from '@/stores/toasts';

export const commitIgnoreQueryKey = (projectId: string) => [
  'project-commit-ignore',
  projectId,
];

/**
 * Read/write access to a project's `.jean-claude/ignore` rules, plus matching
 * helpers so a file list can tell which of its paths are skipped at commit
 * time. Matching goes through the shared module the main process uses, so the
 * dimmed rows and the actual exclusions can't disagree.
 */
export function useCommitIgnore(projectId: string | undefined) {
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const queryKey = commitIgnoreQueryKey(projectId ?? '');

  const { data: content = '', isSuccess } = useQuery({
    queryKey,
    queryFn: () => api.projects.getCommitIgnore(projectId as string),
    enabled: Boolean(projectId),
  });

  const matcher = useMemo(() => createCommitIgnoreMatcher(content), [content]);

  const isIgnored = useCallback(
    (path: string) => matchesCommitIgnore(matcher, path),
    [matcher],
  );

  /** False when a glob keeps the paths ignored no matter what we remove. */
  const canUnignore = useCallback(
    (paths: string[]) => canUnignoreCommitPaths(content, paths),
    [content],
  );

  const { mutate } = useMutation({
    mutationFn: (next: string) =>
      api.projects.updateCommitIgnore(projectId as string, next),
    onError: (error) => {
      addToast({
        message:
          error instanceof Error
            ? error.message
            : 'Failed to update commit ignore rules',
        type: 'error',
      });
      // The optimistic value is now untrustworthy — re-read from disk.
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const setIgnored = useCallback(
    (paths: string[], ignored: boolean) => {
      if (!projectId || paths.length === 0) return;
      // Read through the cache rather than the render's closure: consecutive
      // toggles fire before the query re-renders, and the second one must build
      // on the first one's result or it silently drops it.
      const current =
        queryClient.getQueryData<string>(commitIgnoreQueryKey(projectId)) ?? '';
      const next = ignored
        ? addCommitIgnoreEntries(current, paths)
        : removeCommitIgnoreEntries(current, paths);
      if (next === current) return;
      queryClient.setQueryData(commitIgnoreQueryKey(projectId), next);
      // No onSuccess write-back: responses can land out of order and a stale
      // one would clobber the newer optimistic value. The cache above is the
      // source of truth until an error forces a refetch.
      mutate(next);
    },
    [mutate, projectId, queryClient],
  );

  return { content, isReady: isSuccess, isIgnored, canUnignore, setIgnored };
}
