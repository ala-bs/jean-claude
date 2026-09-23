import {
  parseProjectRootRunId,
  type ProjectCommand,
  START_PR_COMMAND_CHANNEL,
  type StartPrCommandParams,
} from '@shared/run-command-types';
import type { Task } from '@shared/types';

import {
  validateNonEmptyId,
  validatePrWorkspacePairParams,
  validateRecord,
} from './pr-input-validation';

type RunStartParams =
  | { taskId: string; runCommandId: string }
  | { taskId: string; runCommandIds: string[] };

export async function resolveRunCommandStart<Params extends RunStartParams>(
  params: Params,
  deps: {
    findTaskById: (id: string) => Promise<Task | undefined>;
    findProjectById: (id: string) => Promise<{ path: string } | undefined>;
    findCommandById: (id: string) => Promise<ProjectCommand | undefined>;
  },
): Promise<Params & { projectId: string; workingDir: string }> {
  // Project-root runs have no task row: the run id encodes the project and the
  // command runs in the repository checkout rather than a task worktree.
  const rootProjectId = parseProjectRootRunId(params.taskId);
  let projectId: string;
  let worktreePath: string | null = null;
  if (rootProjectId) {
    projectId = rootProjectId;
  } else {
    const task = await deps.findTaskById(params.taskId);
    if (!task) throw new Error(`Task ${params.taskId} not found`);
    projectId = task.projectId;
    worktreePath = task.worktreePath;
  }

  const project = await deps.findProjectById(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);

  const commandIds =
    'runCommandId' in params
      ? [params.runCommandId]
      : [...new Set(params.runCommandIds)];
  if (commandIds.length === 0) throw new Error('Command group is empty');
  for (const commandId of commandIds) {
    const command = await deps.findCommandById(commandId);
    if (!command || command.projectId !== projectId) {
      throw new Error(
        `Command ${commandId} not found for project ${projectId}`,
      );
    }
  }

  return {
    ...params,
    ...('runCommandIds' in params && { runCommandIds: commandIds }),
    projectId,
    workingDir: worktreePath ?? project.path,
  } as Params & { projectId: string; workingDir: string };
}

export function registerStartPrCommandHandler<Deps, Result>({
  ipcMain,
  startPrCommand,
  deps,
}: {
  ipcMain: {
    handle: (
      channel: string,
      listener: (event: unknown, params: unknown) => Result,
    ) => void;
  };
  startPrCommand: (params: StartPrCommandParams, deps: Deps) => Result;
  deps: Deps;
}): void {
  ipcMain.handle(START_PR_COMMAND_CHANNEL, (_, params) => {
    const pair = validatePrWorkspacePairParams(params);
    const value = params as Record<string, unknown>;
    const target = validateRecord(value.target, 'PR command target');
    if (target.type !== 'command' && target.type !== 'group') {
      throw new Error('Invalid PR command target type');
    }
    return startPrCommand(
      {
        ...pair,
        target: {
          type: target.type,
          id: validateNonEmptyId(target.id, 'target.id'),
        },
      },
      deps,
    );
  });
}

export function resetRunCommandLogs({
  params,
  resetLogs,
  broadcast,
}: {
  params: { taskId: string; runCommandId: string; generation: number };
  resetLogs: (params: {
    taskId: string;
    runCommandId: string;
    generation: number;
  }) => number;
  broadcast: (
    taskId: string,
    runCommandId: string,
    generation: number,
  ) => void;
}): number {
  const generation = resetLogs(params);
  broadcast(params.taskId, params.runCommandId, generation);
  return generation;
}
