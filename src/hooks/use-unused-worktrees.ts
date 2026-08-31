import { useMutation } from '@tanstack/react-query';

import { api } from '@/lib/api';

export function useScanUnusedWorktrees() {
  return useMutation({
    mutationFn: () => api.unusedWorktrees.scan(),
  });
}

export function useCleanupUnusedWorktrees() {
  return useMutation({
    mutationFn: (params: { paths: string[] }) =>
      api.unusedWorktrees.cleanup(params),
  });
}
