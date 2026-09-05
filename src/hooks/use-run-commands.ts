import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  PortsInUseErrorData,
  RunStatus,
  StartAdHocRunCommandParams,
} from '@shared/run-command-types';
import { api } from '@/lib/api';
import { isPortsInUseError } from '@shared/run-command-types';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { useTaskMessagesStore } from '@/stores/task-messages';

type AdHocParams = Omit<
  StartAdHocRunCommandParams,
  'taskId' | 'projectId' | 'workingDir'
>;

interface PendingStart {
  commandIds: string[];
  kind: 'command' | 'group' | 'ad-hoc';
  operationToken: symbol;
  adHocParams?: AdHocParams;
}

interface PortConflictRecord {
  error: PortsInUseErrorData;
  operation: PendingStart;
  projectId: string;
  taskGeneration: { taskId: string };
  taskId: string;
}

const EMPTY_COMMAND_IDS: string[] = [];

export function useRunCommands({
  taskId,
  projectId,
  workingDir,
}: {
  taskId: string;
  projectId: string;
  workingDir: string;
}) {
  const taskGeneration = useMemo(() => ({ taskId }), [taskId]);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [statusTaskId, setStatusTaskId] = useState(taskId);
  const [portConflict, setPortConflict] = useState<PortConflictRecord | null>(
    null,
  );
  const [startingCommandIds, setStartingCommandIds] = useState<string[]>([]);
  const [stoppingCommandIds, setStoppingCommandIds] = useState<string[]>([]);
  const [operationTaskId, setOperationTaskId] = useState(taskId);
  const [operationTaskGeneration, setOperationTaskGeneration] =
    useState(taskGeneration);
  const statusEventSequenceRef = useRef(0);
  const startOperationTokensRef = useRef(new Map<string, symbol>());
  const stopOperationTokensRef = useRef(new Map<string, symbol>());

  const resetRunCommandLogs = useTaskMessagesStore(
    (state) => state.resetRunCommandLogs,
  );
  const resetRunCommandLogsRef = useLatestRef(resetRunCommandLogs);
  const portConflictRef = useLatestRef(portConflict);
  const taskIdRef = useLatestRef(taskId);
  const taskGenerationRef = useLatestRef(taskGeneration);
  const workingDirRef = useLatestRef(workingDir);
  const currentStatus = statusTaskId === taskId ? status : null;
  const hasCurrentOperation =
    operationTaskId === taskId && operationTaskGeneration === taskGeneration;
  const currentPortConflict =
    portConflict?.taskId === taskId &&
    portConflict.taskGeneration === taskGeneration
      ? portConflict
      : null;
  const currentStartingCommandIds = hasCurrentOperation
    ? startingCommandIds
    : EMPTY_COMMAND_IDS;
  const currentStoppingCommandIds = hasCurrentOperation
    ? stoppingCommandIds
    : EMPTY_COMMAND_IDS;

  useEffect(() => {
    let active = true;
    const initialStatusSequence = statusEventSequenceRef.current;

    void api.runCommands.getStatus(taskId).then((newStatus) => {
      if (
        active &&
        taskIdRef.current === taskId &&
        statusEventSequenceRef.current === initialStatusSequence
      ) {
        setStatusTaskId(taskId);
        setStatus(newStatus);
      }
    });
    const unsubscribeStatus = api.runCommands.onStatusChange(
      (changedTaskId, newStatus) => {
        if (active && taskIdRef.current === taskId && changedTaskId === taskId) {
          statusEventSequenceRef.current += 1;
          setStatusTaskId(taskId);
          setStatus(newStatus);
        }
      },
    );

    return () => {
      active = false;
      unsubscribeStatus();
    };
  }, [taskId, taskIdRef]);

  const runStart = async (
    commandIds: string[],
    kind: PendingStart['kind'],
    expectedContext?: {
      projectId: string;
      taskGeneration: { taskId: string };
      taskId: string;
    },
    adHocParams?: AdHocParams,
  ): Promise<{ started: boolean }> => {
    const uniqueCommandIds = [...new Set(commandIds)];
    const currentResetRunCommandLogs = resetRunCommandLogsRef.current;
    const currentTaskId = expectedContext?.taskId ?? taskIdRef.current;
    const currentTaskGeneration =
      expectedContext?.taskGeneration ?? taskGenerationRef.current;
    if (
      taskIdRef.current !== currentTaskId ||
      taskGenerationRef.current !== currentTaskGeneration ||
      (expectedContext && projectId !== expectedContext.projectId)
    ) {
      return { started: false };
    }
    const statusSequenceAtStart = statusEventSequenceRef.current;
    const operationToken = Symbol('run-command-start');
    for (const commandId of uniqueCommandIds) {
      startOperationTokensRef.current.set(commandId, operationToken);
    }
    const isCurrentOperation = () =>
      taskIdRef.current === currentTaskId &&
      taskGenerationRef.current === currentTaskGeneration &&
      uniqueCommandIds.every(
        (commandId) =>
          startOperationTokensRef.current.get(commandId) === operationToken,
      );
    try {
      setOperationTaskId(currentTaskId);
      setOperationTaskGeneration(currentTaskGeneration);
      setStartingCommandIds((current) => [
        ...new Set([...current, ...uniqueCommandIds]),
      ]);
      setPortConflict(null);

      await Promise.all(
        uniqueCommandIds.map((runCommandId) =>
          api.runCommands.stopCommand({ taskId: currentTaskId, runCommandId }),
        ),
      );

      await Promise.all(
        uniqueCommandIds.map((runCommandId) => {
          const generation = currentResetRunCommandLogs(
            currentTaskId,
            runCommandId,
          );
          return api.runCommands.resetLogs({
            taskId: currentTaskId,
            runCommandId,
            generation,
          });
        }),
      );

      const result = adHocParams
        ? await api.runCommands.startAdHocCommand({
            taskId: currentTaskId,
            projectId,
            workingDir: workingDirRef.current,
            ...adHocParams,
          })
        : uniqueCommandIds.length === 1
          ? await api.runCommands.startCommand({
              taskId: currentTaskId,
              runCommandId: uniqueCommandIds[0],
            })
          : await api.runCommands.startGroup({
              taskId: currentTaskId,
              runCommandIds: uniqueCommandIds,
            });

      if (isPortsInUseError(result)) {
        if (isCurrentOperation()) {
          setPortConflict({
            error: result,
            operation: {
              commandIds: uniqueCommandIds,
              kind,
              operationToken,
              adHocParams,
            },
            projectId,
            taskGeneration: currentTaskGeneration,
            taskId: currentTaskId,
          });
        }
        return { started: false };
      }

      if (
        isCurrentOperation() &&
        statusEventSequenceRef.current === statusSequenceAtStart
      ) {
        setStatusTaskId(currentTaskId);
        setStatus(result);
        setPortConflict((current) =>
          current?.operation.operationToken === operationToken ? null : current,
        );
      }
      // A superseded operation must not report success: the caller would open
      // the logs pane for a command set that is no longer the active one.
      return { started: isCurrentOperation() };
    } catch (error) {
      if (isCurrentOperation()) {
        setPortConflict((current) =>
          current?.operation.operationToken === operationToken ? null : current,
        );
      }
      throw error;
    } finally {
      if (
        taskIdRef.current === currentTaskId &&
        taskGenerationRef.current === currentTaskGeneration
      ) {
        const currentCommandIds = uniqueCommandIds.filter(
          (commandId) =>
            startOperationTokensRef.current.get(commandId) === operationToken,
        );
        setStartingCommandIds((current) =>
          current.filter((commandId) => !currentCommandIds.includes(commandId)),
        );
        for (const commandId of currentCommandIds) {
          startOperationTokensRef.current.delete(commandId);
        }
      }
    }
  };

  const startCommand = async (runCommandId: string) =>
    runStart([runCommandId], 'command');

  const startAdHocCommand = async (params: AdHocParams) =>
    runStart([params.runCommandId], 'ad-hoc', undefined, params);

  const startGroup = async (runCommandIds: string[]) =>
    runStart(runCommandIds, 'group');

  const stopCommand = async (runCommandId: string) => {
    const currentTaskId = taskIdRef.current;
    const currentTaskGeneration = taskGenerationRef.current;
    const operationToken = Symbol('run-command-stop');
    stopOperationTokensRef.current.set(runCommandId, operationToken);
    setOperationTaskId(currentTaskId);
    setOperationTaskGeneration(currentTaskGeneration);
    setStoppingCommandIds((current) => [
      ...new Set([...current, runCommandId]),
    ]);
    try {
      await api.runCommands.stopCommand({ taskId: currentTaskId, runCommandId });
    } finally {
      if (
        taskIdRef.current === currentTaskId &&
        taskGenerationRef.current === currentTaskGeneration &&
        stopOperationTokensRef.current.get(runCommandId) === operationToken
      ) {
        setStoppingCommandIds((current) =>
          current.filter((commandId) => commandId !== runCommandId),
        );
        stopOperationTokensRef.current.delete(runCommandId);
      }
    }
  };

  const stopGroup = async (runCommandIds: string[]) => {
    const uniqueCommandIds = [...new Set(runCommandIds)];
    const currentTaskId = taskIdRef.current;
    const currentTaskGeneration = taskGenerationRef.current;
    const operationToken = Symbol('run-command-stop-group');
    for (const commandId of uniqueCommandIds) {
      stopOperationTokensRef.current.set(commandId, operationToken);
    }
    setOperationTaskId(currentTaskId);
    setOperationTaskGeneration(currentTaskGeneration);
    setStoppingCommandIds((current) => [
      ...new Set([...current, ...uniqueCommandIds]),
    ]);
    try {
      await Promise.all(
        uniqueCommandIds.map((runCommandId) =>
          api.runCommands.stopCommand({ taskId: currentTaskId, runCommandId }),
        ),
      );
    } finally {
      const currentCommandIds = uniqueCommandIds.filter(
        (commandId) =>
          stopOperationTokensRef.current.get(commandId) === operationToken,
      );
      if (
        taskIdRef.current === currentTaskId &&
        taskGenerationRef.current === currentTaskGeneration &&
        currentCommandIds.length > 0
      ) {
        setStoppingCommandIds((current) =>
          current.filter((commandId) => !currentCommandIds.includes(commandId)),
        );
        for (const commandId of currentCommandIds) {
          stopOperationTokensRef.current.delete(commandId);
        }
      }
    }
  };

  const confirmKillPorts = async (): Promise<{
    commandIds: string[];
    started: boolean;
  }> => {
    const conflict = currentPortConflict;
    if (!conflict || portConflictRef.current !== conflict) {
      return { commandIds: [], started: false };
    }

    const commandIds = [
      ...new Set(conflict.error.portsInUse.map((port) => port.commandId)),
    ];
    for (const commandId of commandIds) {
      await api.runCommands.killPortsForCommand(conflict.projectId, commandId);
      if (portConflictRef.current !== conflict) {
        return { commandIds: [], started: false };
      }
    }

    if (
      taskIdRef.current !== conflict.taskId ||
      taskGenerationRef.current !== conflict.taskGeneration
    ) {
      return { commandIds: [], started: false };
    }
    setPortConflict((current) => (current === conflict ? null : current));
    const result = await runStart(
      conflict.operation.commandIds,
      conflict.operation.kind,
      conflict,
      conflict.operation.adHocParams,
    );
    return {
      commandIds: conflict.operation.commandIds,
      started: result.started,
    };
  };

  const dismissPortsError = () => {
    setPortConflict((current) =>
      current === currentPortConflict ? null : current,
    );
  };

  const statusByCommandId = useMemo(() => {
    const byId: Record<string, RunStatus['commands'][number]> = {};
    for (const commandStatus of currentStatus?.commands ?? []) {
      byId[commandStatus.id] = commandStatus;
    }
    return byId;
  }, [currentStatus]);

  const startingCommandIdSet = useMemo(
    () => new Set(currentStartingCommandIds),
    [currentStartingCommandIds],
  );
  const stoppingCommandIdSet = useMemo(
    () => new Set(currentStoppingCommandIds),
    [currentStoppingCommandIds],
  );

  return {
    status: currentStatus,
    statusByCommandId,
    isRunning: currentStatus?.isRunning ?? false,
    isCommandStarting: (commandId: string) =>
      startingCommandIdSet.has(commandId),
    isCommandStopping: (commandId: string) =>
      stoppingCommandIdSet.has(commandId),
    isStartingAnyCommand: currentStartingCommandIds.length > 0,
    startCommand,
    startAdHocCommand,
    startGroup,
    stopCommand,
    stopGroup,
    portsInUseError: currentPortConflict?.error ?? null,
    confirmKillPorts,
    dismissPortsError,
  };
}
