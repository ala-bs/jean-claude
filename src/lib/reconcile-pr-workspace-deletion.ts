import type { QueryClient } from '@tanstack/react-query';

import { cache$ } from '@/cache/cache-store';
import { invalidateFeedResources } from '@/cache/feed-cache';
import { removeStep } from '@/cache/domains/steps';
import { removeTask } from '@/cache/domains/tasks';
import { useOverlaysStore } from '@/stores/overlays';
import { useTaskMessagesStore } from '@/stores/task-messages';

export async function reconcilePrWorkspaceDeletion(
  taskIds: string[],
  queryClient: QueryClient,
) {
  const messages = useTaskMessagesStore.getState();
  const overlays = useOverlaysStore.getState();

  for (const taskId of taskIds) {
    const cachedStepIds = Object.values(cache$.steps.get() ?? {})
      .filter((step) => step.taskId === taskId)
      .map((step) => step.id);
    const loadedStepIds = Object.entries(messages.steps)
      .filter(([, step]) => step.taskId === taskId)
      .map(([stepId]) => stepId);
    const stepIds = new Set([...cachedStepIds, ...loadedStepIds]);

    for (const stepId of stepIds) {
      messages.unloadStep(stepId);
      removeStep(stepId);
      queryClient.removeQueries({ queryKey: ['steps', stepId] });
    }
    messages.clearAllRunCommandLogs(taskId);
    messages.setRunCommandRunning(taskId, false);
    messages.clearPendingRequestForTask(taskId);
    overlays.clearRunningCommandTargetForTask(taskId);
    removeTask(taskId);
    queryClient.removeQueries({ queryKey: ['tasks', taskId] });
    queryClient.removeQueries({ queryKey: ['steps', { taskId }] });
  }

  invalidateFeedResources(queryClient, ['tasks', 'workItems']);
  await queryClient.invalidateQueries({ queryKey: ['tasks'] });
}
