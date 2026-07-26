import type { CommandRunStatus, RunStatus } from '@shared/run-command-types';
import {
  createMobilePreviewRuntimeKey,
  parseMobileDevServerCommandId,
  parseMobilePreviewRuntimeKey,
} from '@/lib/mobile-preview-runtime';
import {
  DEFAULT_MOBILE_PREVIEW_PROJECT_CONFIG,
  isMobilePreviewProjectEnabled,
  type MobilePreviewProjectConfig,
  type Project,
  type Task,
} from '@shared/types';

type MobilePreviewRuntimeBase = {
  key: string;
  taskId: string;
  appPath: string;
  port: number;
  isRunning: boolean;
  commandStatus: CommandRunStatus | null;
};

type MobilePreviewRuntimeWithContext = MobilePreviewRuntimeBase & {
  isContextAvailable: true;
  taskName: string;
  projectId: string;
  projectName: string;
  branch: string | null;
  mobileConfig: MobilePreviewProjectConfig | null;
};

type MobilePreviewRuntimePlaceholder = MobilePreviewRuntimeBase & {
  isContextAvailable: false;
  taskName: string | null;
  projectId: string | null;
  projectName: null;
  branch: string | null;
  mobileConfig: null;
};

export type MobilePreviewRuntime =
  | MobilePreviewRuntimeWithContext
  | MobilePreviewRuntimePlaceholder;

function getTaskName(task: Task) {
  return task.name ?? (task.prompt.split('\n')[0].slice(0, 30) || task.id);
}

function getConfiguredPort(config: MobilePreviewProjectConfig | undefined) {
  const port = config?.metroPort;
  return typeof port === 'number' && Number.isInteger(port) && port > 0
    ? port
    : (DEFAULT_MOBILE_PREVIEW_PROJECT_CONFIG.metroPort ?? 8081);
}

function getRunningPort(
  commandStatus: CommandRunStatus,
  config: MobilePreviewProjectConfig | undefined,
) {
  const effectivePort = commandStatus.ports?.find(
    (port) => Number.isInteger(port) && port > 0,
  );
  return effectivePort ?? getConfiguredPort(config);
}

export function getMobilePreviewAppPath(config: MobilePreviewProjectConfig) {
  const detectedPaths = config.detectedApps.map((app) => app.path || '.');
  const selectedAppPath = config.selectedAppPath || '.';
  return detectedPaths.includes(selectedAppPath)
    ? selectedAppPath
    : (detectedPaths[0] ?? '.');
}

function canShowTaskRuntime(task: Task, project: Project | undefined) {
  return (
    !task.userCompleted &&
    !!project?.mobilePreviewConfig &&
    isMobilePreviewProjectEnabled(project.mobilePreviewConfig)
  );
}

function createRuntime({
  taskId,
  task,
  project,
  appPath,
  commandStatus,
  portOverride,
}: {
  taskId: string;
  task: Task | undefined;
  project: Project | undefined;
  appPath: string;
  commandStatus: CommandRunStatus | null;
  portOverride?: number;
}): MobilePreviewRuntime {
  const runtime = {
    key: createMobilePreviewRuntimeKey({ taskId, appPath }),
    taskId,
    appPath,
    port:
      portOverride ??
      (commandStatus
        ? getRunningPort(commandStatus, project?.mobilePreviewConfig)
        : getConfiguredPort(project?.mobilePreviewConfig)),
    isRunning: commandStatus?.status === 'running',
    commandStatus,
  };
  if (!task || !project) {
    return {
      ...runtime,
      isContextAvailable: false,
      taskName: task ? getTaskName(task) : null,
      projectId: task?.projectId ?? null,
      projectName: null,
      branch: task ? (task.branchName ?? task.sourceBranch) : null,
      mobileConfig: null,
    };
  }
  return {
    ...runtime,
    isContextAvailable: true,
    taskName: getTaskName(task),
    projectId: project.id,
    projectName: project.name,
    branch: task.branchName ?? task.sourceBranch,
    mobileConfig: project.mobilePreviewConfig ?? null,
  };
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function deriveMobilePreviewRuntimes({
  tasks,
  projects,
  runCommandRunning,
  currentTaskId,
  selectedRuntimeKey = null,
  selectedRuntimeSnapshot = null,
}: {
  tasks: readonly Task[] | null | undefined;
  projects: readonly Project[] | null | undefined;
  runCommandRunning: Readonly<Record<string, RunStatus>>;
  currentTaskId: string | null | undefined;
  selectedRuntimeKey?: string | null;
  selectedRuntimeSnapshot?: MobilePreviewRuntime | null;
}): MobilePreviewRuntime[] {
  const taskById = new Map(tasks?.map((task) => [task.id, task]));
  const projectById = new Map(
    projects?.map((project) => [project.id, project]),
  );
  const runtimeByKey = new Map<string, MobilePreviewRuntime>();
  const tasksWithRunningRuntime = new Set<string>();

  for (const [taskId, status] of Object.entries(runCommandRunning)) {
    const task = taskById.get(taskId);
    const project = task ? projectById.get(task.projectId) : undefined;

    for (const commandStatus of status.commands) {
      if (commandStatus.status !== 'running') continue;
      const appPath = parseMobileDevServerCommandId(commandStatus.id);
      if (!appPath) continue;
      tasksWithRunningRuntime.add(taskId);

      const runtime = createRuntime({
        taskId,
        task,
        project,
        appPath,
        commandStatus,
      });
      runtimeByKey.set(runtime.key, runtime);
    }
  }

  for (const task of tasks ?? []) {
    const project = projectById.get(task.projectId);
    const config = project?.mobilePreviewConfig;
    if (!canShowTaskRuntime(task, project) || !project || !config) continue;
    const appPath = getMobilePreviewAppPath(config);
    const key = createMobilePreviewRuntimeKey({
      taskId: task.id,
      appPath,
    });
    if (
      tasksWithRunningRuntime.has(task.id) &&
      task.id !== currentTaskId &&
      key !== selectedRuntimeKey
    ) {
      continue;
    }
    const matchingSnapshot =
      selectedRuntimeSnapshot?.key === key ? selectedRuntimeSnapshot : null;
    if (!runtimeByKey.has(key)) {
      runtimeByKey.set(
        key,
        createRuntime({
          taskId: task.id,
          task,
          project,
          appPath,
          commandStatus: null,
          portOverride: matchingSnapshot?.port,
        }),
      );
    }
  }

  if (selectedRuntimeKey && !runtimeByKey.has(selectedRuntimeKey)) {
    const selectedIdentity = parseMobilePreviewRuntimeKey(selectedRuntimeKey);
    const selectedTask = selectedIdentity
      ? taskById.get(selectedIdentity.taskId)
      : undefined;
    const selectedProject = selectedTask
      ? projectById.get(selectedTask.projectId)
      : undefined;
    if (
      selectedIdentity &&
      selectedTask &&
      canShowTaskRuntime(selectedTask, selectedProject)
    ) {
      const matchingSnapshot =
        selectedRuntimeSnapshot?.key === selectedRuntimeKey
          ? selectedRuntimeSnapshot
          : null;
      runtimeByKey.set(
        selectedRuntimeKey,
        createRuntime({
          taskId: selectedIdentity.taskId,
          task: selectedTask,
          project: selectedProject,
          appPath: selectedIdentity.appPath,
          commandStatus: null,
          portOverride: matchingSnapshot?.port,
        }),
      );
    }
  }

  return Array.from(runtimeByKey.values()).sort((left, right) => {
    const runningDifference = Number(right.isRunning) - Number(left.isRunning);
    if (runningDifference) return runningDifference;

    return (
      compareText(
        left.taskName ?? left.taskId,
        right.taskName ?? right.taskId,
      ) ||
      compareText(left.appPath, right.appPath) ||
      compareText(
        left.projectName ?? left.projectId ?? '',
        right.projectName ?? right.projectId ?? '',
      ) ||
      compareText(left.taskId, right.taskId) ||
      compareText(left.key, right.key)
    );
  });
}

export function resolveMobilePreviewRuntime({
  runtimes,
  selectedRuntimeKey,
  currentTaskId,
}: {
  runtimes: readonly MobilePreviewRuntime[];
  selectedRuntimeKey: string | null | undefined;
  currentTaskId: string | null | undefined;
}): MobilePreviewRuntime | null {
  return (
    (selectedRuntimeKey
      ? runtimes.find((runtime) => runtime.key === selectedRuntimeKey)
      : undefined) ??
    (currentTaskId
      ? runtimes.find(
          (runtime) =>
            runtime.taskId === currentTaskId && runtime.isContextAvailable,
        )
      : undefined) ??
    runtimes.find(
      (runtime) => runtime.isRunning && runtime.isContextAvailable,
    ) ??
    runtimes.find(
      (runtime) => runtime.isRunning && !runtime.isContextAvailable,
    ) ??
    runtimes.find((runtime) => runtime.isContextAvailable) ??
    runtimes[0] ??
    null
  );
}
