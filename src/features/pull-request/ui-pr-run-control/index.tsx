import { AlertTriangle, ChevronDown, Loader2, Play, RefreshCw, Terminal } from 'lucide-react';
import {
  startTransition,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  getRunCommandDisplayName,
  isPortsInUseError,
  type ProjectCommand,
  type ProjectCommandGroup,
  type PrRunTarget,
  type RunStatus,
} from '@shared/run-command-types';
import type { Task } from '@shared/types';

import {
  buildRunCommandItems,
  getRunCommandAction,
  getRunConfirmation,
  resolveRunCommandIds,
  type RunCommandItem,
} from '@/lib/run-command-items';
import { Dropdown, DropdownDivider, DropdownItem } from '@/common/ui/dropdown';
import { api } from '@/lib/api';
import { Chip } from '@/common/ui/chip';
import { ConfirmRunModal } from '@/features/agent/ui-run-button/confirm-run-modal';
import { KillPortsModal } from '@/features/agent/ui-run-button/kill-ports-modal';
import { useBackgroundJobsStore } from '@/stores/background-jobs';
import { useOverlaysStore } from '@/stores/overlays';
import { useProjectCommandGroups } from '@/hooks/use-project-command-groups';
import { useProjectCommands } from '@/hooks/use-project-commands';
import { useTaskMessagesStore } from '@/stores/task-messages';
import { useToastStore } from '@/stores/toasts';

type PendingLaunch = {
  attemptId: number;
  contextKey: string;
  projectId: string;
  pullRequestId: number;
  item: RunCommandItem;
  commandIds: string[];
  jobId: string;
  activitySettled: boolean;
  awaitingPortDecision: boolean;
};

const EMPTY_COMMANDS: ProjectCommand[] = [];
const EMPTY_GROUPS: ProjectCommandGroup[] = [];

export function PrRunControl({
  projectId,
  pullRequestId,
  status,
  readOnly,
  associatedTask,
}: {
  projectId: string;
  pullRequestId: number;
  status: 'active' | 'completed' | 'abandoned';
  readOnly: boolean;
  associatedTask?: Task | null;
}) {
  const commandsQuery = useProjectCommands(projectId);
  const groupsQuery = useProjectCommandGroups(projectId);
  const commands = commandsQuery.data ?? EMPTY_COMMANDS;
  const groups = groupsQuery.data ?? EMPTY_GROUPS;
  const [runtimeTask, setRuntimeTask] = useState<Task | null>(
    associatedTask ?? null,
  );
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [statusRefreshVersion, setStatusRefreshVersion] = useState(0);
  const [preparingIds, setPreparingIds] = useState<string[]>([]);
  const [stoppingIds, setStoppingIds] = useState<string[]>([]);
  const [pendingConfirm, setPendingConfirm] = useState<RunCommandItem | null>(
    null,
  );
  const [portsError, setPortsError] = useState<
    Extract<Awaited<ReturnType<typeof api.tasks.startPrCommand>>['runResult'], {
      type: 'PortsInUseError';
    }> | null
  >(null);
  const pendingTargetRef = useRef<PendingLaunch | null>(null);
  const associatedTaskContextRef = useRef(
    associatedTask
      ? `${associatedTask.id}:${associatedTask.worktreePath ?? ''}`
      : null,
  );
  const isPreparingRef = useRef(false);
  const launchAttemptIdRef = useRef(0);
  const mountedRef = useRef(true);
  const launchContextKey = `${projectId}:${pullRequestId}:${status}:${readOnly}`;
  const launchContextRef = useRef(launchContextKey);
  const previousLaunchContextRef = useRef(launchContextKey);
  const dropdownRef = useRef<{
    toggle: (restoreFocusTo?: HTMLElement | null) => void;
  } | null>(null);
  const addToast = useToastStore((state) => state.addToast);
  const addRunningJob = useBackgroundJobsStore((state) => state.addRunningJob);
  const markPrReviewJobSucceeded = useBackgroundJobsStore(
    (state) => state.markPrReviewJobSucceeded,
  );
  const markJobFailed = useBackgroundJobsStore((state) => state.markJobFailed);
  const openRunningCommands = useOverlaysStore(
    (state) => state.openRunningCommands,
  );
  const setRunCommandRunning = useTaskMessagesStore(
    (state) => state.setRunCommandRunning,
  );

  const menuItems = useMemo(
    () => buildRunCommandItems({ commands, groups }),
    [commands, groups],
  );
  const hasExecutableItem = useMemo(
    () =>
      menuItems.some(
        (item) => resolveRunCommandIds({ item, commands }).length > 0,
      ),
    [commands, menuItems],
  );
  const runningCommandIds = useMemo(
    () =>
      (runStatus?.commands ?? [])
        .filter((command) => command.status === 'running')
        .map((command) => command.id),
    [runStatus],
  );
  const isPreparing = preparingIds.length > 0;
  const isRunning = runningCommandIds.length > 0;

  useLayoutEffect(() => {
    launchContextRef.current = launchContextKey;
  }, [launchContextKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const pending = pendingTargetRef.current;
      if (
        pending?.awaitingPortDecision &&
        !pending.activitySettled
      ) {
        pending.activitySettled = true;
        markJobFailed(
          pending.jobId,
          'Launch cancelled while waiting for port confirmation because the view closed',
        );
      }
    };
  }, [markJobFailed]);

  useEffect(() => {
    if (previousLaunchContextRef.current === launchContextKey) return;
    previousLaunchContextRef.current = launchContextKey;
    const pending = pendingTargetRef.current;
    if (pending?.awaitingPortDecision && !pending.activitySettled) {
      pending.activitySettled = true;
      markJobFailed(
        pending.jobId,
        'Launch cancelled while waiting for port confirmation because the pull request context changed',
      );
    }
    pendingTargetRef.current = null;
    isPreparingRef.current = false;
    startTransition(() => {
      setPreparingIds([]);
      setPendingConfirm(null);
      setPortsError(null);
    });
  }, [launchContextKey, markJobFailed]);

  useEffect(() => {
    const nextContext = associatedTask
      ? `${associatedTask.id}:${associatedTask.worktreePath ?? ''}`
      : null;
    if (associatedTaskContextRef.current === nextContext) return;
    associatedTaskContextRef.current = nextContext;
    startTransition(() => {
      setRuntimeTask(associatedTask ?? null);
      setRunStatus(null);
    });
  }, [associatedTask]);

  useEffect(() => {
    const taskId = runtimeTask?.id;
    if (!taskId) return;

    let active = true;
    let statusEventSequence = 0;
    const applyStatus = (nextStatus: RunStatus) => {
      if (!active) return;
      setRunStatus(nextStatus);
      setRunCommandRunning(taskId, nextStatus.isRunning ? nextStatus : false);
    };
    const unsubscribe = api.runCommands.onStatusChange(
      (changedTaskId, nextStatus) => {
        if (changedTaskId === taskId) {
          statusEventSequence += 1;
          applyStatus(nextStatus);
        }
      },
    );
    const sequenceAtFetch = statusEventSequence;
    void api.runCommands
      .getStatus(taskId)
      .then((nextStatus) => {
        if (statusEventSequence === sequenceAtFetch) applyStatus(nextStatus);
      })
      .catch(() => {});

    return () => {
      active = false;
      unsubscribe();
    };
  }, [
    runtimeTask?.id,
    runtimeTask?.worktreePath,
    setRunCommandRunning,
    statusRefreshVersion,
  ]);

  const showError = (error: unknown, fallback: string) => {
    addToast({
      type: 'error',
      message: error instanceof Error ? error.message : fallback,
    });
  };

  const openLogs = (commandIds = runningCommandIds) => {
    if (!runtimeTask || commandIds.length === 0) return;
    openRunningCommands({
      taskId: runtimeTask.id,
      runCommandId: commandIds[0],
    });
  };

  const isCurrentLaunch = (pending: PendingLaunch) =>
    mountedRef.current &&
    launchContextRef.current === pending.contextKey &&
    pendingTargetRef.current?.attemptId === pending.attemptId;

  const finishLaunch = async (pending: PendingLaunch) => {
    let retainForPortConflict = false;
    const target: PrRunTarget = {
      type: pending.item.type,
      id: pending.item.item.id,
    };
    try {
      const result = await api.tasks.startPrCommand({
        projectId: pending.projectId,
        pullRequestId: pending.pullRequestId,
        target,
      });
      if (isPortsInUseError(result.runResult)) {
        retainForPortConflict = true;
        pending.awaitingPortDecision = true;
        pending.commandIds = result.runCommandIds;
        if (!isCurrentLaunch(pending)) {
          if (!pending.activitySettled) {
            pending.activitySettled = true;
            markJobFailed(
              pending.jobId,
              'Launch cancelled before port confirmation could be shown',
            );
          }
          return;
        }
        setRuntimeTask(result.task);
        setStatusRefreshVersion((version) => version + 1);
        setPortsError(result.runResult);
        setPreparingIds([]);
        isPreparingRef.current = false;
        return;
      }

      if (!pending.activitySettled) {
        pending.activitySettled = true;
        markPrReviewJobSucceeded(pending.jobId, {
          taskId: result.task.id,
          projectId: pending.projectId,
          created: result.created,
        });
      }
      if (!isCurrentLaunch(pending)) return;

      setRuntimeTask(result.task);
      setStatusRefreshVersion((version) => version + 1);
      setPortsError(null);
      setRunStatus(result.runResult);
      setRunCommandRunning(result.task.id, result.runResult);
      const runCommandId = result.runCommandIds[0];
      if (runCommandId) {
        openRunningCommands({ taskId: result.task.id, runCommandId });
      }
    } catch (error) {
      if (!pending.activitySettled) {
        pending.activitySettled = true;
        markJobFailed(
          pending.jobId,
          error instanceof Error ? error.message : 'Failed to start project',
        );
      }
      if (isCurrentLaunch(pending)) {
        showError(error, 'Failed to start project');
      }
    } finally {
      if (isCurrentLaunch(pending)) {
        if (!retainForPortConflict) pendingTargetRef.current = null;
        setPreparingIds([]);
        isPreparingRef.current = false;
      }
    }
  };

  const launch = (item: RunCommandItem) => {
    if (isPreparingRef.current) return;
    const commandIds = resolveRunCommandIds({ item, commands });
    if (commandIds.length === 0) return;

    isPreparingRef.current = true;
    setPreparingIds(commandIds);
    const jobId = addRunningJob({
      type: 'pr-review-creation',
      title: `Preparing project for PR #${pullRequestId}`,
      projectId,
      details: { pullRequestId },
    });
    const pending: PendingLaunch = {
      attemptId: ++launchAttemptIdRef.current,
      contextKey: launchContextRef.current,
      projectId,
      pullRequestId,
      item,
      commandIds,
      jobId,
      activitySettled: false,
      awaitingPortDecision: false,
    };
    pendingTargetRef.current = pending;
    void finishLaunch(pending);
  };

  const stop = async (commandIds: string[]) => {
    if (!runtimeTask || commandIds.length === 0) return;
    const uniqueIds = [...new Set(commandIds)];
    setStoppingIds(uniqueIds);
    try {
      await Promise.all(
        uniqueIds.map((runCommandId) =>
          api.runCommands.stopCommand({
            taskId: runtimeTask.id,
            runCommandId,
          }),
        ),
      );
    } catch (error) {
      showError(error, 'Failed to stop command');
    } finally {
      setStoppingIds([]);
    }
  };

  const handleItem = (item: RunCommandItem) => {
    const commandIds = resolveRunCommandIds({ item, commands });
    const action = getRunCommandAction({ commandIds, runningCommandIds });
    if (
      action.type === 'disabled' ||
      isPreparingRef.current ||
      commandIds.some((id) => stoppingIds.includes(id))
    ) {
      return;
    }
    if (action.type === 'stop') {
      void stop(action.commandIds);
      return;
    }

    const confirmation = getRunConfirmation({ item, commands });
    if (confirmation) {
      setPendingConfirm(item);
      return;
    }
    launch(item);
  };

  const handleRetryPorts = async () => {
    const pending = pendingTargetRef.current;
    if (!portsError || !pending || isPreparingRef.current) return;
    pending.awaitingPortDecision = false;
    isPreparingRef.current = true;
    setPreparingIds(pending.commandIds);
    try {
      const conflictingCommandIds = [
        ...new Set(portsError.portsInUse.map((port) => port.commandId)),
      ];
      await Promise.all(
        conflictingCommandIds.map((commandId) =>
          api.runCommands.killPortsForCommand(pending.projectId, commandId),
        ),
      );
      setPortsError(null);
      await finishLaunch(pending);
    } catch (error) {
      if (!pending.activitySettled) {
        pending.activitySettled = true;
        markJobFailed(
          pending.jobId,
          error instanceof Error ? error.message : 'Failed to free ports',
        );
      }
      const isCurrent = isCurrentLaunch(pending);
      if (isCurrent) {
        pendingTargetRef.current = null;
        setPortsError(null);
        showError(error, 'Failed to free ports');
        setPreparingIds([]);
        isPreparingRef.current = false;
      }
    }
  };

  if (readOnly || status !== 'active') return null;

  if (commandsQuery.isError || groupsQuery.isError) {
    const isRetrying = commandsQuery.isFetching || groupsQuery.isFetching;
    return (
      <button
        type="button"
        aria-label="Retry loading project commands"
        onClick={() => {
          if (commandsQuery.isError) void commandsQuery.refetch();
          if (groupsQuery.isError) void groupsQuery.refetch();
        }}
        disabled={isRetrying}
        className="border-status-fail/40 bg-status-fail/10 text-status-fail hover:bg-status-fail/20 flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
      >
        {isRetrying ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
        )}
        Commands unavailable
        <RefreshCw className="h-3 w-3" aria-hidden />
      </button>
    );
  }

  if (commandsQuery.isPending || groupsQuery.isPending || !hasExecutableItem) {
    return null;
  }

  return (
    <>
      <Dropdown
        align="right"
        dropdownRef={dropdownRef}
        trigger={({ triggerRef, ...triggerProps }) => (
          <div
            className="border-glass-border bg-bg-1 flex overflow-hidden rounded-md border"
          >
            <button
              type="button"
              aria-label={isRunning ? 'View command logs' : 'Start project'}
              {...(!isRunning && !isPreparing ? triggerProps : {})}
              disabled={isPreparing}
              onClick={(event) =>
                isRunning
                  ? openLogs()
                  : dropdownRef.current?.toggle(event.currentTarget)
              }
              className="hover:bg-bg-2 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
            >
              {isPreparing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : isRunning ? (
                <Terminal className="h-3.5 w-3.5" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              {isPreparing
                ? 'Preparing workspace...'
                : isRunning
                  ? 'View logs'
                  : 'Start project'}
            </button>
            {!isPreparing && (
              <button
                ref={triggerRef}
                type="button"
                aria-label="Choose project command"
                {...triggerProps}
                onClick={(event) =>
                  dropdownRef.current?.toggle(event.currentTarget)
                }
                className="border-glass-border hover:bg-bg-2 border-l px-1.5 transition-colors"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      >
        {menuItems.map((item, index) => {
          const commandIds = resolveRunCommandIds({ item, commands });
          const action = getRunCommandAction({ commandIds, runningCommandIds });
          const busy =
            commandIds.some(
              (id) => preparingIds.includes(id) || stoppingIds.includes(id),
            ) || isPreparing;
          const label =
            item.type === 'command'
              ? getRunCommandDisplayName(item.item)
              : item.item.name;
          const content = (
            <>
              <span className="text-ink-2 mr-2 truncate text-xs">{label}</span>
              {item.type === 'group' && (
                <Chip size="xs" color="blue">
                  Group
                </Chip>
              )}
              <Chip
                size="xs"
                color={action.type === 'stop' ? 'red' : 'green'}
                className="uppercase"
              >
                {busy ? '...' : action.type === 'stop' ? 'Stop' : 'Run'}
              </Chip>
            </>
          );

          return (
            <div key={`${item.type}:${item.item.id}`}>
              {action.type === 'disabled' ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled
                  className="text-ink-4 flex w-full items-center gap-2 px-3 py-1.5 text-left opacity-50"
                >
                  <span className="flex-1">{content}</span>
                </button>
              ) : (
                <DropdownItem onClick={() => handleItem(item)}>
                  <span className="flex items-center gap-2">{content}</span>
                </DropdownItem>
              )}
              {index < menuItems.length - 1 && <DropdownDivider />}
            </div>
          );
        })}
      </Dropdown>

      {pendingConfirm && (
        <ConfirmRunModal
          commandName={
            getRunConfirmation({ item: pendingConfirm, commands })?.label ?? ''
          }
          message={
            getRunConfirmation({ item: pendingConfirm, commands })?.message ??
            null
          }
          onConfirm={() => {
            const item = pendingConfirm;
            setPendingConfirm(null);
            launch(item);
          }}
          onCancel={() => setPendingConfirm(null)}
        />
      )}

      {portsError && (
        <KillPortsModal
          error={portsError}
          onConfirm={() => void handleRetryPorts()}
          onCancel={() => {
            const pending = pendingTargetRef.current;
            if (pending && !pending.activitySettled) {
              pending.activitySettled = true;
              markJobFailed(
                pending.jobId,
                'Launch cancelled while waiting for port confirmation',
              );
            }
            pendingTargetRef.current = null;
            setPortsError(null);
          }}
          isLoading={isPreparing}
        />
      )}
    </>
  );
}
