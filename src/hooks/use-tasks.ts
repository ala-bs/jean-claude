import {
  ACTIVE_TASKS_INDEX_KEY,
  appendTaskToKnownIndexes,
  ingestActiveTasks,
  ingestProjectTasks,
  ingestTask,
  ingestTasks,
  markTaskListsStale,
  patchTaskSnapshot,
  projectTasksResourceKey,
  removeTask,
  selectActiveTasks,
  selectProjectTasks,
  selectTask,
  selectTasks,
  setProjectTaskIndexIds,
  taskResourceKey,
  TASKS_INDEX_KEY,
} from '@/cache/domains/tasks';
import { ingestStep, markStepListsStale } from '@/cache/domains/steps';
import type {
  InteractionMode,
  NewTask,
  ThinkingEffort,
  UpdateTask,
} from '@shared/types';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';

import type { AgentBackendType } from '@shared/agent-backend-types';
import { api } from '@/lib/api';
import { cache$ } from '@/cache/cache-store';
import type { FeedItem } from '@shared/feed-types';
import { invalidateFeedResources } from '@/cache/feed-cache';
import { setDocumentResource } from '@/cache/cache-actions';
import { useBackgroundJobsStore } from '@/stores/background-jobs';
import { useCacheResource } from '@/cache/use-cache-resource';
import { useTaskMessagesStore } from '@/stores/task-messages';
import { useToastStore } from '@/stores/toasts';



// The creation payload includes step-related fields alongside task fields.
// The IPC handler extracts interactionMode/modelPreference/agentBackend
// to auto-create the initial TaskStep.
type CreateTaskPayload = NewTask & {
  useWorktree?: boolean;
  useExistingBranch?: boolean;
  interactionMode?: InteractionMode | null;
  modelPreference?: string | null;
  thinkingEffort?: ThinkingEffort | null;
  agentBackend?: AgentBackendType | null;
  agentMemoryPrompt?: string;
};

export function invalidateFeedItems(
  queryClient: ReturnType<typeof useQueryClient>,
) {
  invalidateFeedResources(queryClient, ['tasks', 'workItems']);
}

export function updateFeedTaskPendingMessage(
  taskId: string,
  pendingMessage: string | null,
) {
  const key = 'feed:tasks';
  const current = cache$.documents[key].data.get() as FeedItem[] | undefined;
  if (!current) return;

  const updateItem = (item: FeedItem): FeedItem => {
    const children = item.children?.map(updateItem);
    const withChildren = children ? { ...item, children } : item;

    if (item.source !== 'task' || item.taskId !== taskId) {
      return withChildren;
    }

    return {
      ...withChildren,
      pendingMessage: pendingMessage ?? undefined,
    };
  };

  setDocumentResource(
    key,
    current.map(updateItem),
    cache$.resources[key].lastFetchedAt.get() ?? Date.now(),
  );
}

export function useTasks() {
  return useCacheResource({
    key: TASKS_INDEX_KEY,
    load: api.tasks.findAll,
    ingest: ingestTasks,
    select: selectTasks,
  });
}

export function useProjectTasks(projectId: string) {
  return useCacheResource({
    key: projectTasksResourceKey(projectId),
    load: () => api.tasks.findByProjectId(projectId),
    ingest: (tasks) => ingestProjectTasks(projectId, tasks),
    enabled: !!projectId,
    select: () => selectProjectTasks(projectId),
  });
}

export function useAllActiveTasks() {
  return useCacheResource({
    key: ACTIVE_TASKS_INDEX_KEY,
    load: () => api.tasks.findAllActive(),
    ingest: ingestActiveTasks,
    select: selectActiveTasks,
  });
}

export function useAllCompletedTasks({ limit }: { limit: number }) {
  return useInfiniteQuery({
    queryKey: ['tasks', 'allCompleted', { limit }],
    queryFn: ({ pageParam = 0 }) =>
      api.tasks.findAllCompleted({ limit, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loadedCount = allPages.reduce(
        (acc, page) => acc + page.tasks.length,
        0,
      );
      return loadedCount < lastPage.total ? loadedCount : undefined;
    },
  });
}

export function useTask(id: string) {
  return useCacheResource({
    key: taskResourceKey(id),
    load: () => api.tasks.findById(id),
    ingest: (task) => {
      if (task) {
        ingestTask(task);
      }
    },
    enabled: !!id,
    select: () => selectTask(id),
  });
}

export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateTaskPayload) => api.tasks.create(data),
    onSuccess: (task) => {
      ingestTask(task);
      appendTaskToKnownIndexes(task);
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({
        queryKey: ['tasks', { projectId: task.projectId }],
      });
      invalidateFeedItems(queryClient);
    },
  });
}

export function useCreateTaskWithWorktree() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      data: CreateTaskPayload & {
        useWorktree: boolean;
        sourceBranch?: string | null;
        autoStart?: boolean;
      },
    ) => api.tasks.createWithWorktree(data),
    onSuccess: (task) => {
      ingestTask(task);
      appendTaskToKnownIndexes(task);
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({
        queryKey: ['tasks', { projectId: task.projectId }],
      });
      invalidateFeedItems(queryClient);
    },
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateTask }) =>
      api.tasks.update(id, data),
    onSuccess: (task, { id }) => {
      ingestTask(task);
      updateFeedTaskPendingMessage(id, task.pendingMessage);
      markTaskListsStale(task.projectId);
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['tasks', id] });
      queryClient.invalidateQueries({
        queryKey: ['tasks', { projectId: task.projectId }],
      });
      invalidateFeedItems(queryClient);
    },
  });
}

export function useSetTaskSourceBranch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      taskId,
      sourceBranch,
    }: {
      taskId: string;
      sourceBranch: string;
    }) => api.tasks.setSourceBranch({ taskId, sourceBranch }),
    onSuccess: (task, { taskId }) => {
      ingestTask(task);
      markTaskListsStale(task.projectId);
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['tasks', taskId] });
      queryClient.invalidateQueries({
        queryKey: ['tasks', { projectId: task.projectId }],
      });
      queryClient.invalidateQueries({ queryKey: ['worktree-diff', taskId] });
      queryClient.invalidateQueries({ queryKey: ['worktree-status', taskId] });
      queryClient.invalidateQueries({
        queryKey: ['worktree-local-changes', taskId],
      });
      queryClient.invalidateQueries({ queryKey: ['worktree-commits', taskId] });
      queryClient.invalidateQueries({
        queryKey: ['worktree-file-content', taskId],
      });
      invalidateFeedItems(queryClient);
    },
  });
}

export function useUpdateTaskPendingMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      pendingMessage,
    }: {
      id: string;
      pendingMessage: string | null;
    }) => api.tasks.updatePendingMessage(id, pendingMessage),
    onSuccess: (task, { id }) => {
      ingestTask(task);
      updateFeedTaskPendingMessage(id, task.pendingMessage);
      markTaskListsStale(task.projectId);
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['tasks', id] });
      queryClient.invalidateQueries({
        queryKey: ['tasks', { projectId: task.projectId }],
      });
      invalidateFeedItems(queryClient);
    },
  });
}

export function useDeleteTask() {
  const queryClient = useQueryClient();
  const clearAllRunCommandLogs = useTaskMessagesStore(
    (s) => s.clearAllRunCommandLogs,
  );
  const setRunCommandRunning = useTaskMessagesStore(
    (s) => s.setRunCommandRunning,
  );
  return useMutation({
    mutationFn: ({
      id,
      deleteWorktree,
    }: {
      id: string;
      deleteWorktree?: boolean;
    }) => api.tasks.delete(id, { deleteWorktree }),
    onSuccess: (_, { id }) => {
      clearAllRunCommandLogs(id);
      setRunCommandRunning(id, false);
      removeTask(id, { deleteResource: false });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      invalidateFeedItems(queryClient);
    },
  });
}

export function useDeleteWorktree() {
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  return useMutation({
    mutationFn: ({
      taskId,
      keepBranch,
    }: {
      taskId: string;
      keepBranch?: boolean;
    }) => api.tasks.worktree.delete(taskId, { keepBranch }),
    onSuccess: (result, { taskId }) => {
      if (result.editorCloseWarning) {
        addToast({ type: 'error', message: result.editorCloseWarning });
      }
      patchTaskSnapshot(taskId, {
        worktreePath: null,
        branchName: null,
        startCommitHash: null,
        sourceBranch: null,
      });
      queryClient.invalidateQueries({ queryKey: ['tasks', taskId] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({ queryKey: ['worktree-status', taskId] });
      queryClient.invalidateQueries({ queryKey: ['worktree-diff', taskId] });
      queryClient.invalidateQueries({
        queryKey: ['worktree-file-content', taskId],
      });
    },
  });
}

export function useSetStepMode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ stepId, mode }: { stepId: string; mode: InteractionMode }) =>
      api.steps.setMode(stepId, mode),
    onSuccess: (step) => {
      if (!step) return;
      ingestStep(step);
      markStepListsStale(step.taskId);
      queryClient.invalidateQueries({ queryKey: ['steps', step.id] });
      queryClient.invalidateQueries({
        queryKey: ['steps', { taskId: step.taskId }],
      });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

/**
 * @deprecated Use useSetStepMode instead. Kept as a compatibility shim
 * that delegates to the step-based API. Callers should migrate to pass
 * stepId directly.
 */
export function useSetTaskMode() {
  return useSetStepMode();
}

export function useToggleTaskUserCompleted() {
  const queryClient = useQueryClient();
  const clearAllRunCommandLogs = useTaskMessagesStore(
    (s) => s.clearAllRunCommandLogs,
  );
  const setRunCommandRunning = useTaskMessagesStore(
    (s) => s.setRunCommandRunning,
  );
  return useMutation({
    mutationFn: (id: string) => api.tasks.toggleUserCompleted(id),
    onSuccess: (task, id) => {
      clearAllRunCommandLogs(id);
      setRunCommandRunning(id, false);
      ingestTask(task);
      markTaskListsStale(task.projectId);
      queryClient.invalidateQueries({ queryKey: ['tasks', id] });
      queryClient.invalidateQueries({
        queryKey: ['tasks', { projectId: task.projectId }],
      });
      queryClient.invalidateQueries({ queryKey: ['tasks', 'allActive'] });
      queryClient.invalidateQueries({ queryKey: ['tasks', 'allCompleted'] });
      invalidateFeedItems(queryClient);
    },
  });
}

export function useCompleteTask() {
  const queryClient = useQueryClient();
  const clearAllRunCommandLogs = useTaskMessagesStore(
    (s) => s.clearAllRunCommandLogs,
  );
  const setRunCommandRunning = useTaskMessagesStore(
    (s) => s.setRunCommandRunning,
  );
  const addRunningJob = useBackgroundJobsStore((s) => s.addRunningJob);
  const markJobSucceeded = useBackgroundJobsStore((s) => s.markJobSucceeded);
  const markJobFailed = useBackgroundJobsStore((s) => s.markJobFailed);

  return useMutation({
    mutationFn: ({
      id,
      cleanupWorktree,
    }: {
      id: string;
      cleanupWorktree?: boolean;
    }) => api.tasks.complete(id, { cleanupWorktree }),
    onMutate: ({ id, cleanupWorktree }) =>
      addRunningJob({
        type: 'task-completion',
        title: 'Completing task',
        taskId: id,
        details: {
          cleanupWorktree: cleanupWorktree ?? null,
        },
      }),
    onSuccess: (result, { id }, jobId) => {
      const { task } = result;

      ingestTask(task);
      markTaskListsStale(task.projectId);

      if (jobId) {
        markJobSucceeded(jobId, { projectId: task.projectId });
      }
      clearAllRunCommandLogs(id);
      setRunCommandRunning(id, false);
      queryClient.invalidateQueries({ queryKey: ['tasks', id] });
      queryClient.invalidateQueries({
        queryKey: ['tasks', { projectId: task.projectId }],
      });
      queryClient.invalidateQueries({ queryKey: ['tasks', 'allActive'] });
      queryClient.invalidateQueries({ queryKey: ['tasks', 'allCompleted'] });
      invalidateFeedItems(queryClient);
    },
    onError: (error, _variables, jobId) => {
      if (!jobId) return;

      const message =
        error instanceof Error ? error.message : 'Task completion failed';
      markJobFailed(jobId, message);
    },
  });
}

export function useClearTaskUserCompleted() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.tasks.clearUserCompleted(id),
    onSuccess: (task, id) => {
      ingestTask(task);
      markTaskListsStale(task.projectId);
      queryClient.invalidateQueries({ queryKey: ['tasks', id] });
      queryClient.invalidateQueries({
        queryKey: ['tasks', { projectId: task.projectId }],
      });
      queryClient.invalidateQueries({ queryKey: ['tasks', 'allActive'] });
      queryClient.invalidateQueries({ queryKey: ['tasks', 'allCompleted'] });
      invalidateFeedItems(queryClient);
    },
  });
}

export function useReorderTasks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      activeIds,
      completedIds,
    }: {
      projectId: string;
      activeIds: string[];
      completedIds: string[];
    }) => api.tasks.reorder(projectId, activeIds, completedIds),
    onSuccess: (_, { projectId, activeIds, completedIds }) => {
      setProjectTaskIndexIds(projectId, [...activeIds, ...completedIds]);
      markTaskListsStale(projectId);
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      queryClient.invalidateQueries({
        queryKey: ['tasks', { projectId }],
      });
      invalidateFeedItems(queryClient);
    },
  });
}
