import { useCallback, useEffect, useRef } from 'react';

import { TaskState, useTaskMessagesStore } from '@/stores/task-messages';
import { api } from '@/lib/api';


// Hoisted outside component to avoid recreation on every render
const STEP_NOT_FOUND_RETRY_MS = 400;
const STUCK_LOADING_RETRY_MS = 4000;

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
  const setBackgroundTasks = useTaskMessagesStore((s) => s.setBackgroundTasks);
  const isLoaded = !!stepState;
  // Track which step we're currently fetching to prevent duplicate requests
  const fetchingRef = useRef<string | null>(null);
  // Track which step we've done a sync check for (only relevant when already loaded)
  const syncCheckedRef = useRef<string | null>(null);
  // Incremented per fetch so late responses can be discarded
  const fetchGenerationRef = useRef(0);

  const fetchPendingRequest = useCallback(async () => {
    if (!enabled || !stepId) return;
    // Per-step version: a sibling step of the same task emitting status updates
    // must not invalidate this step's fetch.
    const pendingRequestVersionAtStart =
      useTaskMessagesStore.getState().pendingRequestVersions[stepId] ?? 0;
    const pendingRequest = await api.agent.getPendingRequest(stepId);
    if (pendingRequest) {
      if (
        (useTaskMessagesStore.getState().pendingRequestVersions[stepId] ?? 0) !==
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
        setPendingRequestForTask({
          taskId,
          stepId,
          request: { type: 'permission', permission: pendingRequest.data },
        });
      } else {
        setQuestion(stepId, pendingRequest.data);
        setPendingRequestForTask({
          taskId,
          stepId,
          request: { type: 'question', question: pendingRequest.data },
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

  /**
   * Re-hydrate the live background-job set from the main process.
   *
   * `background_tasks_changed` is only emitted on change, so a renderer that
   * reloaded (or a window opened) mid-run would otherwise never learn that the
   * agent is still waiting on background work. Also self-heals a stale
   * indicator left behind by a dropped clear event.
   */
  const fetchBackgroundTasks = useCallback(async () => {
    if (!enabled || !stepId) return;
    // Version, not an array reference: a set-then-clear pair arriving during
    // the await returns the key to `undefined`, which a reference check reads
    // as "unchanged" and would then overwrite with this older result.
    const versionAtStart =
      useTaskMessagesStore.getState().backgroundTasksVersions[stepId] ?? 0;
    try {
      const tasks = await api.agent.getBackgroundTasks(stepId);
      if (
        (useTaskMessagesStore.getState().backgroundTasksVersions[stepId] ??
          0) !== versionAtStart
      ) {
        // A live snapshot landed while this was in flight — it is newer.
        return;
      }
      setBackgroundTasks(stepId, tasks);
    } catch (error) {
      // IPC rejects when the window is tearing down. A missing indicator is
      // not worth an unhandled rejection.
      console.error('Failed to fetch background tasks', error);
    }
  }, [enabled, stepId, setBackgroundTasks]);

  const fetchMessages = useCallback(() => {
    if (!enabled || !stepId) return;
    fetchingRef.current = stepId;
    // Guards against stale responses clobbering newer state (refetch/unload,
    // step switch, or an IPC status update that landed while in flight).
    const generation = ++fetchGenerationRef.current;
    const isStale = () => generation !== fetchGenerationRef.current;
    Promise.all([
      api.agent.getMessages(stepId),
      api.steps.findById(stepId),
    ])
      .then(async ([messages, step]) => {
        if (isStale()) return;
        let resolvedStep = step;
        if (!resolvedStep) {
          // Step row may not be committed yet — retry once before giving up.
          await new Promise((resolve) =>
            setTimeout(resolve, STEP_NOT_FOUND_RETRY_MS),
          );
          if (isStale()) return;
          resolvedStep = await api.steps.findById(stepId);
          if (isStale()) return;
        }
        if (resolvedStep) {
          loadStep(stepId, taskId, messages, resolvedStep.status);
          // Also fetch pending request after loading step
          fetchPendingRequest();
          void fetchBackgroundTasks();
          return;
        }
        // Still missing: surface it as an error instead of leaving the step
        // unloaded forever (which strands the panel on "Loading...").
        console.error('Step not found while loading messages', stepId);
        setStatus(stepId, 'errored', 'Step not found', taskId);
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
  }, [
    enabled,
    stepId,
    taskId,
    loadStep,
    fetchPendingRequest,
    fetchBackgroundTasks,
    setStatus,
  ]);

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
        void fetchBackgroundTasks();
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
    fetchBackgroundTasks,
  ]);

  // Refetch pending request when window regains focus
  useEffect(() => {
    if (!enabled || !stepId) return;

    const handleFocus = () => {
      // Only refetch if the step is loaded and in a waiting state
      if (isLoaded && stepState?.status === 'waiting') {
        fetchPendingRequest();
      }
      // Background jobs are NOT gated on `waiting`: the whole point is a step
      // that reads as completed while its jobs are still live. Refetching on
      // focus also heals an indicator left stale by a dropped IPC event.
      if (isLoaded) {
        void fetchBackgroundTasks();
      }
    };

    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [
    enabled,
    stepId,
    isLoaded,
    stepState?.status,
    fetchPendingRequest,
    fetchBackgroundTasks,
  ]);

  // Watchdog: if the step never lands in the store (stale-aborted fetch, a
  // fetch that was never started), log state and retry instead of stranding
  // the feed on a spinner forever. Cleared as soon as the step loads.
  useEffect(() => {
    if (!enabled || !stepId || isLoaded) return;
    const timer = setInterval(() => {
      // A slow-but-live fetch is left alone (and not logged): retrying would
      // bump the generation and discard a nearly-complete response. Only
      // stranded steps — fetch aborted as stale, or never started — are revived.
      if (fetchingRef.current === stepId) return;
      console.warn('[task-messages] step stranded without a fetch, retrying', {
        stepId,
        taskId,
        generation: fetchGenerationRef.current,
      });
      fetchMessages();
    }, STUCK_LOADING_RETRY_MS);
    return () => clearInterval(timer);
  }, [enabled, stepId, taskId, isLoaded, fetchMessages]);

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
