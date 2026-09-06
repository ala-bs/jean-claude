// shared/run-command-types.ts

import type { Task } from './types';

export type CommandStatus = 'running' | 'stopped' | 'errored';

export type RunCommandEnvSource =
  | 'taskName'
  | 'projectName'
  | 'availablePort'
  | 'worktreePath'
  | 'projectPath'
  | 'taskBranch'
  | 'sourceBranch'
  | 'defaultBranch'
  | 'prId'
  | 'prUrl'
  | 'custom';

export interface RunCommandEnvVar {
  source: RunCommandEnvSource;
  name: string;
  value?: string;
}

export const RUN_COMMAND_ENV_SOURCES: Array<{
  key: RunCommandEnvSource;
  label: string;
}> = [
  { key: 'taskName', label: 'Task name' },
  { key: 'projectName', label: 'Project name' },
  { key: 'worktreePath', label: 'Worktree path' },
  { key: 'projectPath', label: 'Project path' },
  { key: 'taskBranch', label: 'Task branch' },
  { key: 'sourceBranch', label: 'Source branch' },
  { key: 'defaultBranch', label: 'Default branch' },
  { key: 'prId', label: 'PR ID' },
  { key: 'prUrl', label: 'PR URL' },
  { key: 'availablePort', label: 'Available port' },
  { key: 'custom', label: 'Custom value' },
];

export interface ProjectCommand {
  id: string;
  projectId: string;
  name: string | null;
  command: string;
  ports: number[];
  portConflictStrategy: 'prompt' | 'use-available-port';
  portOverrideProvider: 'env' | 'args';
  portOverrideEnvVar: string | null;
  portOverrideArgs: string | null;
  envVars: RunCommandEnvVar[];
  confirmBeforeRun: boolean;
  confirmMessage: string | null;
  /** Favorites can be run from the project root folder, without a task. */
  isFavorite: boolean;
  /** Hidden commands stay configured but are not offered anywhere they can be run. */
  isHidden: boolean;
  sortOrder: number;
  createdAt: string;
}

export type NewProjectCommand = Omit<
  ProjectCommand,
  'id' | 'createdAt' | 'sortOrder' | 'isFavorite' | 'isHidden'
> & { isFavorite?: boolean; isHidden?: boolean };
export type UpdateProjectCommand = Partial<
  Pick<
    ProjectCommand,
    | 'name'
    | 'command'
    | 'ports'
    | 'portConflictStrategy'
    | 'portOverrideProvider'
    | 'portOverrideEnvVar'
    | 'portOverrideArgs'
    | 'envVars'
    | 'confirmBeforeRun'
    | 'confirmMessage'
    | 'isFavorite'
    | 'isHidden'
  >
>;

export type ProjectSuggestionCommand = Omit<NewProjectCommand, 'projectId'>;

export function getAvailablePortOverrideValidationError(command: {
  id?: string;
  ports: number[];
  portConflictStrategy: ProjectCommand['portConflictStrategy'];
}): string | null {
  if (
    command.portConflictStrategy !== 'use-available-port' ||
    command.ports.length === 1
  ) {
    return null;
  }

  const commandLabel = command.id ? `command ${command.id}` : 'command';
  return `Available-port override requires exactly one requested port; ${commandLabel} has ${command.ports.length}`;
}

export interface ProjectSuggestions {
  runCommands: ProjectSuggestionCommand[];
}

export interface ProjectCommandGroupEntry {
  commandId: string;
  /**
   * Block the stage until this command exits. Long-running commands (dev
   * servers) leave this off, otherwise the stage would never complete.
   */
  waitForExit: boolean;
}

export interface ProjectCommandGroupStage {
  id: string;
  entries: ProjectCommandGroupEntry[];
  /** Pause after the stage completes, before the next stage starts. */
  delayMs: number;
}

export interface ProjectCommandGroup {
  id: string;
  projectId: string;
  name: string;
  /** Source of truth for both membership and execution order. */
  stages: ProjectCommandGroupStage[];
  /**
   * Flattened, de-duplicated membership derived from `stages`. Maintained by
   * the repository on every write so membership-only consumers do not have to
   * walk the stage tree.
   */
  commandIds: string[];
  sortOrder: number;
  createdAt: string;
}

export type NewProjectCommandGroup = Omit<
  ProjectCommandGroup,
  'id' | 'createdAt' | 'sortOrder' | 'commandIds'
>;

export type UpdateProjectCommandGroup = Partial<
  Pick<ProjectCommandGroup, 'name' | 'stages'>
>;

export const MAX_COMMAND_GROUP_STAGE_DELAY_MS = 600_000;

export function flattenCommandGroupStages(
  stages: ProjectCommandGroupStage[],
): string[] {
  return [
    ...new Set(
      stages.flatMap((stage) => stage.entries.map((entry) => entry.commandId)),
    ),
  ];
}

export function createCommandGroupStage(
  entries: ProjectCommandGroupEntry[] = [],
): ProjectCommandGroupStage {
  return { id: crypto.randomUUID(), entries, delayMs: 0 };
}

/**
 * A group is sequential only if it has more than one stage. Single-stage groups
 * behave exactly like the legacy all-at-once groups.
 */
export function isSequentialCommandGroup(group: {
  stages: ProjectCommandGroupStage[];
}): boolean {
  return group.stages.length > 1;
}

/**
 * Resolves the stages a group should actually run: drops entries whose command
 * is missing or hidden, then drops stages left empty. Hidden members are
 * dropped rather than rejected so a group stays runnable when only some of its
 * commands are hidden.
 */
export function resolveCommandGroupRunStages({
  stages,
  commands,
}: {
  stages: ProjectCommandGroupStage[];
  commands: Array<Pick<ProjectCommand, 'id' | 'isHidden'>>;
}): ProjectCommandGroupStage[] {
  const runnableIds = new Set(
    commands.filter((command) => !command.isHidden).map((command) => command.id),
  );

  return stages
    .map((stage) => ({
      ...stage,
      entries: stage.entries.filter((entry) => runnableIds.has(entry.commandId)),
    }))
    .filter((stage) => stage.entries.length > 0);
}

export type RunCommandConfigItem =
  | ({ type: 'command' } & Pick<ProjectCommand, 'id' | 'sortOrder'>)
  | ({ type: 'group' } & Pick<ProjectCommandGroup, 'id' | 'sortOrder'>);

export type PrRunTarget =
  | { type: 'command'; id: string }
  | { type: 'group'; id: string };

export interface StartPrCommandParams {
  projectId: string;
  pullRequestId: number;
  target: PrRunTarget;
}

export interface StartPrCommandResult {
  task: Task;
  created: boolean;
  runCommandIds: string[];
  runResult: RunStatus | PortsInUseErrorData;
}

export const START_PR_COMMAND_CHANNEL = 'tasks:startPrCommand';

export interface CommandRunStatus {
  id: string;
  name: string | null;
  command: string;
  ports?: number[];
  status: CommandStatus;
  pid?: number;
}

export interface RunStatus {
  isRunning: boolean;
  commands: CommandRunStatus[];
}

/**
 * Why a staged group run stopped early. A user-initiated stop is NOT an abort
 * and is never reported here.
 */
export type RunCommandGroupAbortReason =
  | { type: 'commandFailed'; commandName: string; exitCode: number }
  | { type: 'restartFailed'; commandName: string };

export interface RunCommandGroupAbortEvent {
  taskId: string;
  /** Stages that will now never run. */
  skippedStageCount: number;
  reason: RunCommandGroupAbortReason;
}

export const RUN_COMMAND_GROUP_ABORT_CHANNEL =
  'project:commands:run:groupAborted';

export function getRunCommandGroupAbortMessage(
  event: RunCommandGroupAbortEvent,
): string {
  const skipped =
    event.skippedStageCount > 0
      ? ` ${event.skippedStageCount} later stage${
          event.skippedStageCount === 1 ? '' : 's'
        } skipped.`
      : '';

  if (event.reason.type === 'restartFailed') {
    return `Run group stopped: could not restart ${event.reason.commandName}.${skipped}`;
  }

  return `Run group stopped: ${event.reason.commandName} exited with code ${event.reason.exitCode}.${skipped}`;
}

export type RunCommandLogStream = 'stdout' | 'stderr';

export interface RunCommandLogEvent {
  taskId: string;
  runCommandId: string;
  stream: RunCommandLogStream;
  text: string;
  generation: number;
}

export type StartAdHocRunCommandParams = {
  taskId: string;
  projectId: string;
  workingDir: string;
  runCommandId: string;
  name: string | null;
  command: string;
  ports: number[];
  availablePort?: {
    provider: 'env' | 'args';
    envVar?: string;
    args?: string;
  };
  envVars?: RunCommandEnvVar[];
};

export interface PortInUse {
  port: number;
  commandId: string;
  command: string;
  processInfo?: string;
}

export interface PortsInUseErrorData {
  type: 'PortsInUseError';
  message: string;
  portsInUse: PortInUse[];
}

export function isPortsInUseError(
  error: unknown,
): error is PortsInUseErrorData {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    (error as PortsInUseErrorData).type === 'PortsInUseError'
  );
}

export interface WorkspacePackage {
  name: string; // e.g., "@app/web"
  path: string; // relative path, e.g., "packages/web"
  scripts: string[]; // prefixed with filter syntax
}

export interface PackageScriptsResult {
  scripts: string[];
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun' | null;
  isWorkspace: boolean;
  workspacePackages: WorkspacePackage[];
}

/**
 * Favorite commands run in the project root instead of a task worktree.
 * The run-command service is keyed by task id, so project-root runs use a
 * synthetic id derived from the project id.
 */
const PROJECT_ROOT_RUN_PREFIX = 'project-root:';

export function getProjectRootRunId(projectId: string): string {
  return `${PROJECT_ROOT_RUN_PREFIX}${projectId}`;
}

export function parseProjectRootRunId(taskId: string): string | null {
  return taskId.startsWith(PROJECT_ROOT_RUN_PREFIX)
    ? taskId.slice(PROJECT_ROOT_RUN_PREFIX.length)
    : null;
}

export function getRunCommandDisplayName(command: {
  name?: string | null;
  command: string;
}): string {
  return command.name?.trim() || command.command;
}
