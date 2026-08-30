import { useMutation } from '@tanstack/react-query';

import { api } from '@/lib/api';

/**
 * Generate a PR title/description from the worktree diff without creating a PR.
 *
 * Deliberately not cached: the diff moves as the task progresses, so every
 * press should reflect the branch as it stands right now.
 */
export function useGeneratePrDescription() {
  return useMutation({
    mutationFn: (taskId: string) => api.tasks.generatePrDescription({ taskId }),
  });
}
