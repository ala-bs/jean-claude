import { useCallback, useEffect, useRef } from 'react';

import { TaskState, useTaskMessagesStore } from '@/stores/task-messages';
import { api } from '@/lib/api';


// Hoisted outside component to avoid recreation on every render
const DEFAULT_TASK_STATE: TaskState = {
  taskId: '',
  messages: [],
  status: 'waiting',
  error: null,
  pendingPermission: null,
  pendingQuestion: null,
  queuedPrompts: [],
  lastAccessedAt: 0,
};

export function useTaskMessages({
  taskId,
  stepId,
  enabled = true,
}: {
  taskId: string;
  stepId: string | null;
  enabled?: boolean;
}) {
  const stepState = useTaskMessagesStore((s) =>
    stepId ? s.steps[stepId] : undefined,
  );
  const loadStep = useTaskMessagesStore((s) => s.loadStep);
  const touchStep = useTaskMessagesStore((s) => s.touchStep);
  const unloadStep = useTaskMessagesStore((s) => s.unloadStep);
  const setStatus = useTaskMessagesStore((s) => s.setStatus);
  const setPermission = useTaskMessagesStore((s) => s.setPermission);
  const setQuestion = useTaskMessagesStore((s) => s.setQuestion);
  const setPendingRequestForTask = useTaskMessagesStore(
    (s) => s.setPendingRequestForTask,
  );
  const isLoaded = !!stepState;
  // Track which step we're currently fetching to prevent duplicate requests
  const fetchingRef = useRef<string | null>(null);
  // Track which step we've done a sync check for (only relevant when already loaded)
  const syncCheckedRef = useRef<string | null>(null);

  const fetchPendingRequest = useCallback(async () => {
    if (!enabled || !stepId) return;
    const pendingRequestVersionAtStart =
      useTaskMessagesStore.getState().pendingRequestVersion;
    const pendingRequest = await api.agent.getPendingRequest(stepId);
    if (pendingRequest) {
      if (
        useTaskMessagesStore.getState().pendingRequestVersion !==
        pendingRequestVersionAtStart
      ) {
        return;
      }

      const activeRequestId = getActivePendingRequestId(stepId, taskId);
      if (
        activeRequestId &&
        activeRequestId !== pendingRequest.data.requestId
      ) {
        return;
      }

      if (pendingRequest.type === 'permission') {
        setPermission(stepId, pendingRequest.data);
        setPendingRequestForTask(taskId, {
          type: 'permission',
          permission: pendingRequest.data,
        });
      } else {
        setQuestion(stepId, pendingRequest.data);
        setPendingRequestForTask(taskId, {
          type: 'question',
          question: pendingRequest.data,
        });
      }
    }
  }, [
    enabled,
    stepId,
    taskId,
    setPermission,
    setQuestion,
    setPendingRequestForTask,
  ]);

  const fetchMessages = useCallback(() => {
    if (!enabled || !stepId) return;
    fetchingRef.current = stepId;
    Promise.all([
      api.agent.getMessages(stepId),
      api.steps.findById(stepId),
    ])
      .then(([messages, step]) => {
        if (step) {
          loadStep(stepId, taskId, messages, step.status);
          // Also fetch pending request after loading step
          fetchPendingRequest();
        }
      })
      .catch((error: unknown) => {
        console.error('Failed to fetch task messages', error);
        const message =
          error instanceof Error ? error.message : 'Failed to fetch messages';
        setStatus(stepId, 'errored', message, taskId);
      })
      .finally(() => {
        if (fetchingRef.current === stepId) {
          fetchingRef.current = null;
        }
      });
  }, [enabled, stepId, taskId, loadStep, fetchPendingRequest, setStatus]);

  const refetch = useCallback(() => {
    if (!enabled || !stepId) return;
    // Force a fresh fetch by unloading and re-fetching
    unloadStep(stepId);
    syncCheckedRef.current = null;
    fetchMessages();
  }, [enabled, stepId, unloadStep, fetchMessages]);

  useEffect(() => {
    if (!enabled || !stepId) return;

    if (!isLoaded) {
      // Not loaded - fetch everything from backend
      // Reset sync check since we need a fresh load
      syncCheckedRef.current = null;

      // Only fetch if we're not already fetching this step
      if (fetchingRef.current !== stepId) {
        fetchMessages();
      }
    } else {
      // Already loaded - clear fetching ref
      fetchingRef.current = null;
      touchStep(stepId);

      // Only run sync check once per step open (not on every re-render)
      if (syncCheckedRef.current !== stepId) {
        syncCheckedRef.current = stepId;

        // Check message count sync
        api.agent
          .getMessageCount(stepId)
          .then((backendCount) => {
            const frontendCount = stepState?.messages.length ?? 0;
            if (backendCount !== frontendCount) {
              // Out of sync - reload from backend
              fetchMessages();
            }
          })
          .catch((error: unknown) => {
            console.error('Failed to sync task message count', error);
          });

        // Also fetch pending request (in case we missed an IPC event)
        fetchPendingRequest();
      }
    }
  }, [
    stepId,
    enabled,
    isLoaded,
    touchStep,
    stepState?.messages.length,
    fetchMessages,
    fetchPendingRequest,
  ]);

  // Refetch pending request when window regains focus
  useEffect(() => {
    if (!enabled || !stepId) return;

    const handleFocus = () => {
      // Only refetch if the step is loaded and in a waiting state
      if (isLoaded && stepState?.status === 'waiting') {
        fetchPendingRequest();
      }
    };

    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [enabled, stepId, isLoaded, stepState?.status, fetchPendingRequest]);

  const state = stepState ?? DEFAULT_TASK_STATE;

  return {
    messages: state.messages,
    status: state.status,
    error: state.error,
    pendingPermission: state.pendingPermission,
    pendingQuestion: state.pendingQuestion,
    queuedPrompts: state.queuedPrompts,
    isLoading: enabled && (!stepId || !isLoaded),
    refetch,
  };
}

function getActivePendingRequestId(stepId: string, taskId: string) {
  const state = useTaskMessagesStore.getState();
  const step = state.steps[stepId];
  const taskPending = state.pendingRequestsByTaskId[taskId];
  return (
    step?.pendingPermission?.requestId ??
    step?.pendingQuestion?.requestId ??
    taskPending?.permission?.requestId ??
    taskPending?.question?.requestId ??
    null
  );
}
