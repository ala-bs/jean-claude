import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  appendTaskToKnownIndexes,
  ingestTask,
  markTaskListsStale,
} from '@/cache/domains/tasks';
import {
  ensureStepInTaskIndex,
  ingestStep,
  markStepListsStale,
} from '@/cache/domains/steps';
import { api } from '@/lib/api';
import { invalidateFeedItems } from '@/hooks/use-tasks';
import type { TaskStep } from '@shared/types';



export function useCreateOrGetPrReviewTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.tasks.createPrReviewTask,
    onSuccess: (task) => {
      ingestTask(task);
      appendTaskToKnownIndexes(task);
      markTaskListsStale(task.projectId);
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({
        queryKey: ['tasks', { projectId: task.projectId }],
      });
      invalidateFeedItems(queryClient);
    },
  });
}

export function useCreatePrReviewChatStep() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.steps.createPrReviewChatStep,
    onSuccess: (step: TaskStep) => {
      ingestStep(step);
      ensureStepInTaskIndex(step);
      markStepListsStale(step.taskId);
      queryClient.invalidateQueries({
        queryKey: ['steps', { taskId: step.taskId }],
      });
    },
  });
}

export function useContinuePrReviewChatStep() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.steps.continuePrReviewChatStep,
    onSuccess: (step: TaskStep) => {
      ingestStep(step);
      markStepListsStale(step.taskId);
      queryClient.invalidateQueries({
        queryKey: ['steps', { taskId: step.taskId }],
      });
      queryClient.invalidateQueries({ queryKey: ['steps', step.id] });
    },
  });
}
