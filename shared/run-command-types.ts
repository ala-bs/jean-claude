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
  sortOrder: number;
  createdAt: string;
}

export type NewProjectCommand = Omit<
  ProjectCommand,
  'id' | 'createdAt' | 'sortOrder' | 'isFavorite'
> & { isFavorite?: boolean };
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

export interface ProjectCommandGroup {
  id: string;
  projectId: string;
  name: string;
  commandIds: string[];
  sortOrder: number;
  createdAt: string;
}

export type NewProjectCommandGroup = Omit<
  ProjectCommandGroup,
  'id' | 'createdAt' | 'sortOrder'
>;

export type UpdateProjectCommandGroup = Partial<
  Pick<ProjectCommandGroup, 'name' | 'commandIds'>
>;

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
