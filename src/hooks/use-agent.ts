import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';


import type { PermissionResponse, QuestionResponse } from '@shared/agent-types';
import { api } from '@/lib/api';
import type { PromptPart } from '@shared/agent-backend-types';
import { useTaskMessages } from '@/hooks/use-task-messages';
import { useTaskMessagesStore } from '@/stores/task-messages';
import { useToastStore } from '@/stores/toasts';



export function useAgentStream({
  taskId,
  stepId,
}: {
  taskId: string;
  stepId: string | null;
}) {
  const taskMessages = useTaskMessages({ taskId, stepId });
  const queryClient = useQueryClient();

  // Invalidate task queries when status changes to a terminal state
  useEffect(() => {
    if (
      taskMessages.status === 'completed' ||
      taskMessages.status === 'errored' ||
      taskMessages.status === 'interrupted'
    ) {
      queryClient.invalidateQueries({ queryKey: ['tasks', taskId] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    }
  }, [taskMessages.status, taskId, queryClient]);

  return taskMessages;
}

export function useAgentControls({
  taskId,
  stepId,
}: {
  taskId: string;
  stepId: string | null;
}) {
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const startInFlightRef = useRef(false);
  const queryClient = useQueryClient();
  const setPermission = useTaskMessagesStore((s) => s.setPermission);
  const setQuestion = useTaskMessagesStore((s) => s.setQuestion);
  const clearPendingRequestForTask = useTaskMessagesStore(
    (s) => s.clearPendingRequestForTask,
  );
  const setPendingRequestForTask = useTaskMessagesStore(
    (s) => s.setPendingRequestForTask,
  );
  const addToast = useToastStore((s) => s.addToast);

  const start = useCallback(async () => {
    if (!stepId || startInFlightRef.current) return false;
    startInFlightRef.current = true;
    setIsStarting(true);
    try {
      await api.agent.start(stepId);
      return true;
    } catch (error) {
      addToast({
        type: 'error',
        message:
          error instanceof Error ? error.message : 'Failed to start the step',
      });
      return false;
    } finally {
      startInFlightRef.current = false;
      setIsStarting(false);
    }
  }, [stepId, addToast]);

  const stop = useCallback(async () => {
    if (!stepId) return;
    setIsStopping(true);
    try {
      await api.agent.stop(stepId);
    } finally {
      setIsStopping(false);
      queryClient.invalidateQueries({ queryKey: ['tasks', taskId] });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepId]);

  const respondToPermission = useCallback(
    async (requestId: string, response: PermissionResponse) => {
      if (!stepId) return;
      try {
        await api.agent.respond(stepId, requestId, response);
        const pendingRequest = await api.agent.getPendingRequest(stepId);
        if (pendingRequest?.type === 'permission') {
          setPermission(stepId, pendingRequest.data);
          setQuestion(stepId, null);
          setPendingRequestForTask(taskId, {
            type: 'permission',
            permission: pendingRequest.data,
          });
        } else if (pendingRequest?.type === 'question') {
          setQuestion(stepId, pendingRequest.data);
          setPermission(stepId, null);
          setPendingRequestForTask(taskId, {
            type: 'question',
            question: pendingRequest.data,
          });
        } else {
          setPermission(stepId, null);
          clearPendingRequestForTask(taskId);
        }
      } catch (error) {
        addToast({
          type: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Failed to respond to permission request',
        });
        return;
      }
      const currentState = useTaskMessagesStore.getState();
      if (
        currentState.steps[stepId]?.pendingPermission?.requestId === requestId
      ) {
        setPermission(stepId, null);
      }
      if (
        currentState.pendingRequestsByTaskId[taskId]?.permission?.requestId ===
        requestId
      ) {
        clearPendingRequestForTask(taskId);
      }
    },
    [
      stepId,
      taskId,
      setPermission,
      setQuestion,
      clearPendingRequestForTask,
      setPendingRequestForTask,
      addToast,
    ],
  );

  const respondToQuestion = useCallback(
    async (requestId: string, response: QuestionResponse) => {
      if (!stepId) return;
      try {
        await api.agent.respond(stepId, requestId, response);
        const pendingRequest = await api.agent.getPendingRequest(stepId);
        if (pendingRequest?.type === 'question') {
          setQuestion(stepId, pendingRequest.data);
          setPermission(stepId, null);
          setPendingRequestForTask(taskId, {
            type: 'question',
            question: pendingRequest.data,
          });
        } else if (pendingRequest?.type === 'permission') {
          setPermission(stepId, pendingRequest.data);
          setQuestion(stepId, null);
          setPendingRequestForTask(taskId, {
            type: 'permission',
            permission: pendingRequest.data,
          });
        } else {
          setQuestion(stepId, null);
          clearPendingRequestForTask(taskId);
        }
      } catch (error) {
        addToast({
          type: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Failed to respond to question',
        });
        return false;
      }
      const currentState = useTaskMessagesStore.getState();
      if (
        currentState.steps[stepId]?.pendingQuestion?.requestId === requestId
      ) {
        setQuestion(stepId, null);
      }
      if (
        currentState.pendingRequestsByTaskId[taskId]?.question?.requestId ===
        requestId
      ) {
        clearPendingRequestForTask(taskId);
      }
      return true;
    },
    [
      stepId,
      taskId,
      setQuestion,
      setPermission,
      clearPendingRequestForTask,
      setPendingRequestForTask,
      addToast,
    ],
  );

  const sendMessage = useCallback(
    async (parts: PromptPart[]) => {
      if (!stepId) return;
      await api.agent.sendMessage(stepId, parts);
    },
    [stepId],
  );

  const queuePrompt = useCallback(
    async (parts: PromptPart[]) => {
      if (!stepId) return { promptId: '' };
      return api.agent.queuePrompt(stepId, parts);
    },
    [stepId],
  );

  const cancelQueuedPrompt = useCallback(
    async (promptId: string) => {
      if (!stepId) return;
      await api.agent.cancelQueuedPrompt(stepId, promptId);
    },
    [stepId],
  );

  const updateQueuedPrompt = useCallback(
    async (promptId: string, content: string) => {
      if (!stepId) return;
      await api.agent.updateQueuedPrompt(stepId, promptId, content);
    },
    [stepId],
  );

  return {
    start,
    stop,
    respondToPermission,
    respondToQuestion,
    sendMessage,
    queuePrompt,
    updateQueuedPrompt,
    cancelQueuedPrompt,
    isStarting,
    isStopping,
  };
}
