import { describe, expect, it } from 'vitest';

import {
  createMobileDevServerCommandId,
  createMobilePreviewRuntimeKey,
} from '@/lib/mobile-preview-runtime';
import {
  deriveMobilePreviewRuntimes,
  resolveMobilePreviewRuntime,
} from './utils-mobile-preview-runtimes';
import type { MobilePreviewProjectConfig, Project, Task } from '@shared/types';
import type { RunStatus } from '@shared/run-command-types';

function createProject({
  id,
  name = id,
  mobilePreviewConfig,
}: {
  id: string;
  name?: string;
  mobilePreviewConfig?: MobilePreviewProjectConfig;
}) {
  return {
    id,
    name,
    mobilePreviewConfig,
  } as Project;
}

function createConfig(
  overrides: Partial<MobilePreviewProjectConfig> = {},
): MobilePreviewProjectConfig {
  return {
    mode: 'enabled',
    selectedAppPath: null,
    detectedApps: [],
    detectionUpdatedAt: null,
    metroPort: 8081,
    ...overrides,
  };
}

function createTask({
  id,
  projectId,
  name = id,
  branchName = `${id}-branch`,
  userCompleted = false,
}: {
  id: string;
  projectId: string;
  name?: string | null;
  branchName?: string | null;
  userCompleted?: boolean;
}) {
  return {
    id,
    projectId,
    name,
    prompt: `${id} prompt`,
    branchName,
    sourceBranch: 'main',
    userCompleted,
  } as Task;
}

function createRunStatus(
  commands: Array<{
    id: string;
    status?: 'running' | 'stopped' | 'errored';
    ports?: number[];
  }>,
): RunStatus {
  return {
    isRunning: commands.some((command) => command.status !== 'stopped'),
    commands: commands.map((command) => ({
      id: command.id,
      name: 'Metro',
      command: 'pnpm start',
      ports: command.ports ?? [8081],
      status: command.status ?? 'running',
    })),
  };
}

function derive({
  tasks,
  projects,
  runCommandRunning = {},
  currentTaskId = null,
  selectedRuntimeKey = null,
  selectedRuntimeSnapshot = null,
}: {
  tasks: Task[];
  projects: Project[];
  runCommandRunning?: Record<string, RunStatus>;
  currentTaskId?: string | null;
  selectedRuntimeKey?: string | null;
  selectedRuntimeSnapshot?: ReturnType<
    typeof deriveMobilePreviewRuntimes
  >[number] | null;
}) {
  return deriveMobilePreviewRuntimes({
    tasks,
    projects,
    runCommandRunning,
    currentTaskId,
    selectedRuntimeKey,
    selectedRuntimeSnapshot,
  });
}

describe('mobile preview runtime index', () => {
  it('includes only running commands with valid mobile dev-server IDs', () => {
    const project = createProject({ id: 'project-1' });
    const task = createTask({ id: 'task-1', projectId: project.id });

    const rows = derive({
      tasks: [task],
      projects: [project],
      runCommandRunning: {
        [task.id]: createRunStatus([
          { id: createMobileDevServerCommandId('apps/mobile') },
          { id: 'dev-server:web' },
          { id: 'mobile-dev-server:%' },
          { id: createMobileDevServerCommandId('stopped'), status: 'stopped' },
        ]),
      },
    });

    expect(rows.map((row) => row.appPath)).toEqual(['apps/mobile']);
    expect(rows[0]).toMatchObject({
      taskId: task.id,
      projectId: project.id,
      taskName: task.name,
      projectName: project.name,
      branch: task.branchName,
      isRunning: true,
    });
  });

  it('keeps running mobile commands visible after integration is disabled', () => {
    const project = createProject({
      id: 'project-1',
      mobilePreviewConfig: createConfig({ mode: 'disabled' }),
    });
    const task = createTask({ id: 'task-1', projectId: project.id });

    const rows = derive({
      tasks: [task],
      projects: [project],
      currentTaskId: task.id,
      runCommandRunning: {
        [task.id]: createRunStatus([
          { id: createMobileDevServerCommandId('.') },
        ]),
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ appPath: '.', isRunning: true });
  });

  it('emits a status-backed placeholder while task metadata is missing', () => {
    const rows = derive({
      tasks: [],
      projects: [],
      runCommandRunning: {
        'missing-task': createRunStatus([
          { id: createMobileDevServerCommandId('apps/mobile'), ports: [8090] },
        ]),
      },
    });

    expect(rows).toEqual([
      expect.objectContaining({
        key: createMobilePreviewRuntimeKey({
          taskId: 'missing-task',
          appPath: 'apps/mobile',
        }),
        taskId: 'missing-task',
        taskName: null,
        projectId: null,
        projectName: null,
        branch: null,
        appPath: 'apps/mobile',
        port: 8090,
        isRunning: true,
        isContextAvailable: false,
      }),
    ]);
  });

  it('emits a partially hydrated placeholder while project metadata is missing', () => {
    const task = createTask({ id: 'task-1', projectId: 'missing-project' });
    const rows = derive({
      tasks: [task],
      projects: [],
      runCommandRunning: {
        [task.id]: createRunStatus([
          { id: createMobileDevServerCommandId('.'), ports: [8084] },
        ]),
      },
    });

    expect(rows[0]).toMatchObject({
      taskId: task.id,
      taskName: task.name,
      projectId: task.projectId,
      projectName: null,
      branch: task.branchName,
      port: 8084,
      isRunning: true,
      isContextAvailable: false,
    });
  });

  it('removes a status-backed runtime when its run status disappears', () => {
    const running = derive({
      tasks: [],
      projects: [],
      runCommandRunning: {
        'deleted-task': createRunStatus([
          { id: createMobileDevServerCommandId('.') },
        ]),
      },
    });
    const stopped = derive({ tasks: [], projects: [], runCommandRunning: {} });

    expect(running).toHaveLength(1);
    expect(stopped).toEqual([]);
  });

  it('retains only the selected non-current runtime as stopped after Metro exits', () => {
    const selectedProject = createProject({
      id: 'selected-project',
      mobilePreviewConfig: createConfig({
        selectedAppPath: 'apps/mobile',
        detectedApps: [
          {
            path: 'apps/mobile',
            stacks: ['expo'],
            confidence: 'high',
            reasons: [],
          },
        ],
      }),
    });
    const currentProject = createProject({
      id: 'current-project',
      mobilePreviewConfig: createConfig({ mode: 'disabled' }),
    });
    const selectedTask = createTask({
      id: 'selected-task',
      projectId: selectedProject.id,
    });
    const currentTask = createTask({
      id: 'current-task',
      projectId: currentProject.id,
    });
    const selectedRuntimeKey = createMobilePreviewRuntimeKey({
      taskId: selectedTask.id,
      appPath: 'apps/mobile',
    });
    const running = derive({
      tasks: [selectedTask, currentTask],
      projects: [selectedProject, currentProject],
      currentTaskId: currentTask.id,
      selectedRuntimeKey,
      runCommandRunning: {
        [selectedTask.id]: createRunStatus([
          {
            id: createMobileDevServerCommandId('apps/mobile'),
            ports: [19001],
          },
        ]),
      },
    });

    const stopped = derive({
      tasks: [selectedTask, currentTask],
      projects: [selectedProject, currentProject],
      currentTaskId: currentTask.id,
      selectedRuntimeKey,
      selectedRuntimeSnapshot: running[0],
    });

    expect(stopped).toEqual([
      expect.objectContaining({
        key: selectedRuntimeKey,
        taskId: selectedTask.id,
        appPath: 'apps/mobile',
        port: 19001,
        isRunning: false,
        commandStatus: null,
        isContextAvailable: true,
      }),
    ]);
  });

  it('inserts one stopped current-task row using a valid selected app', () => {
    const config = createConfig({
      selectedAppPath: 'apps/second',
      detectedApps: [
        {
          path: 'apps/first',
          stacks: ['expo'],
          confidence: 'high',
          reasons: [],
        },
        {
          path: 'apps/second',
          stacks: ['react-native'],
          confidence: 'high',
          reasons: [],
        },
      ],
      metroPort: 9090,
    });
    const project = createProject({ id: 'project-1', mobilePreviewConfig: config });
    const task = createTask({ id: 'task-1', projectId: project.id });

    const rows = derive({
      tasks: [task],
      projects: [project],
      currentTaskId: task.id,
    });

    expect(rows).toEqual([
      expect.objectContaining({
        key: createMobilePreviewRuntimeKey({
          taskId: task.id,
          appPath: 'apps/second',
        }),
        appPath: 'apps/second',
        port: 9090,
        isRunning: false,
        commandStatus: null,
        mobileConfig: config,
      }),
    ]);
  });

  it('inserts stopped rows for all visible tasks in mobile-enabled projects', () => {
    const enabledProject = createProject({
      id: 'enabled-project',
      mobilePreviewConfig: createConfig({
        selectedAppPath: 'apps/mobile',
        detectedApps: [
          {
            path: 'apps/mobile',
            stacks: ['expo'],
            confidence: 'high',
            reasons: [],
          },
        ],
      }),
    });
    const disabledProject = createProject({
      id: 'disabled-project',
      mobilePreviewConfig: createConfig({ mode: 'disabled' }),
    });
    const activeTask = createTask({
      id: 'active-task',
      projectId: enabledProject.id,
    });
    const completedTask = createTask({
      id: 'completed-task',
      projectId: enabledProject.id,
      userCompleted: true,
    });
    const disabledTask = createTask({
      id: 'disabled-task',
      projectId: disabledProject.id,
    });

    const rows = derive({
      tasks: [activeTask, completedTask, disabledTask],
      projects: [enabledProject, disabledProject],
    });

    expect(rows.map((row) => row.taskId)).toEqual([activeTask.id]);
    expect(rows[0]).toMatchObject({
      appPath: 'apps/mobile',
      isRunning: false,
      isContextAvailable: true,
    });
  });

  it('rejects an invalid selected app and falls back to first detected app or root', () => {
    const detectedProject = createProject({
      id: 'detected-project',
      mobilePreviewConfig: createConfig({
        selectedAppPath: 'apps/missing',
        detectedApps: [
          {
            path: 'apps/valid',
            stacks: ['expo'],
            confidence: 'high',
            reasons: [],
          },
        ],
      }),
    });
    const rootProject = createProject({
      id: 'root-project',
      mobilePreviewConfig: createConfig({ selectedAppPath: 'apps/missing' }),
    });
    const detectedTask = createTask({
      id: 'detected-task',
      projectId: detectedProject.id,
    });
    const rootTask = createTask({ id: 'root-task', projectId: rootProject.id });

    expect(
      derive({
        tasks: [detectedTask],
        projects: [detectedProject],
        currentTaskId: detectedTask.id,
      })[0].appPath,
    ).toBe('apps/valid');
    expect(
      derive({
        tasks: [rootTask],
        projects: [rootProject],
        currentTaskId: rootTask.id,
      })[0].appPath,
    ).toBe('.');
  });

  it('preserves multiple running app paths for one task and actual effective ports', () => {
    const project = createProject({
      id: 'project-1',
      mobilePreviewConfig: createConfig({ metroPort: 8081 }),
    });
    const task = createTask({ id: 'task-1', projectId: project.id });

    const rows = derive({
      tasks: [task],
      projects: [project],
      runCommandRunning: {
        [task.id]: createRunStatus([
          { id: createMobileDevServerCommandId('apps/one'), ports: [8082] },
          { id: createMobileDevServerCommandId('apps/two'), ports: [8083] },
        ]),
      },
    });

    expect(rows.map(({ appPath, port }) => ({ appPath, port }))).toEqual([
      { appPath: 'apps/one', port: 8082 },
      { appPath: 'apps/two', port: 8083 },
    ]);
  });

  it('uses configured port only for stopped and legacy running statuses', () => {
    const project = createProject({
      id: 'project-1',
      mobilePreviewConfig: createConfig({ metroPort: 9191 }),
    });
    const currentTask = createTask({ id: 'current', projectId: project.id });
    const legacyTask = createTask({ id: 'legacy', projectId: project.id });
    const legacyStatus = createRunStatus([
      { id: createMobileDevServerCommandId('legacy') },
    ]);
    delete (legacyStatus.commands[0] as Partial<(typeof legacyStatus.commands)[number]>).ports;

    const rows = derive({
      tasks: [currentTask, legacyTask],
      projects: [project],
      currentTaskId: currentTask.id,
      runCommandRunning: { [legacyTask.id]: legacyStatus },
    });

    expect(rows.find((row) => row.taskId === currentTask.id)?.port).toBe(9191);
    expect(rows.find((row) => row.taskId === legacyTask.id)?.port).toBe(9191);
  });

  it('merges the current setup row into its matching running runtime', () => {
    const project = createProject({
      id: 'project-1',
      mobilePreviewConfig: createConfig({
        selectedAppPath: 'apps/mobile',
        detectedApps: [
          {
            path: 'apps/mobile',
            stacks: ['expo'],
            confidence: 'high',
            reasons: [],
          },
        ],
      }),
    });
    const task = createTask({ id: 'task-1', projectId: project.id });

    const rows = derive({
      tasks: [task],
      projects: [project],
      currentTaskId: task.id,
      runCommandRunning: {
        [task.id]: createRunStatus([
          { id: createMobileDevServerCommandId('apps/mobile'), ports: [8088] },
        ]),
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      appPath: 'apps/mobile',
      port: 8088,
      isRunning: true,
      commandStatus: { ports: [8088], status: 'running' },
    });
  });

  it('keeps a selection-independent order: running first, then name/app ties', () => {
    const project = createProject({
      id: 'project-1',
      mobilePreviewConfig: createConfig(),
    });
    const alpha = createTask({ id: 'alpha', projectId: project.id, name: 'Alpha' });
    const current = createTask({
      id: 'current',
      projectId: project.id,
      name: 'Zulu current',
    });
    const beta = createTask({ id: 'beta', projectId: project.id, name: 'Beta' });
    const selectedKey = createMobilePreviewRuntimeKey({
      taskId: beta.id,
      appPath: 'z-app',
    });

    const rows = derive({
      tasks: [beta, current, alpha],
      projects: [project],
      currentTaskId: current.id,
      selectedRuntimeKey: selectedKey,
      runCommandRunning: {
        [beta.id]: createRunStatus([
          { id: createMobileDevServerCommandId('z-app') },
        ]),
        [alpha.id]: createRunStatus([
          { id: createMobileDevServerCommandId('b-app') },
          { id: createMobileDevServerCommandId('a-app') },
        ]),
      },
    });

    expect(rows.map((row) => row.key)).toEqual([
      createMobilePreviewRuntimeKey({ taskId: alpha.id, appPath: 'a-app' }),
      createMobilePreviewRuntimeKey({ taskId: alpha.id, appPath: 'b-app' }),
      selectedKey,
      createMobilePreviewRuntimeKey({ taskId: current.id, appPath: '.' }),
    ]);

    const reselected = derive({
      tasks: [beta, current, alpha],
      projects: [project],
      currentTaskId: current.id,
      selectedRuntimeKey: createMobilePreviewRuntimeKey({
        taskId: alpha.id,
        appPath: 'b-app',
      }),
      runCommandRunning: {
        [beta.id]: createRunStatus([
          { id: createMobileDevServerCommandId('z-app') },
        ]),
        [alpha.id]: createRunStatus([
          { id: createMobileDevServerCommandId('b-app') },
          { id: createMobileDevServerCommandId('a-app') },
        ]),
      },
    });
    expect(reselected.map((row) => row.key)).toEqual(rows.map((r) => r.key));
  });

  it('lists the running app before the configured stopped app for one task', () => {
    const project = createProject({
      id: 'project-1',
      mobilePreviewConfig: createConfig({
        selectedAppPath: 'apps/current',
        detectedApps: [
          {
            path: 'apps/current',
            stacks: ['expo'],
            confidence: 'high',
            reasons: [],
          },
        ],
      }),
    });
    const task = createTask({ id: 'task-1', projectId: project.id });
    const rows = derive({
      tasks: [task],
      projects: [project],
      currentTaskId: task.id,
      runCommandRunning: {
        [task.id]: createRunStatus([
          { id: createMobileDevServerCommandId('apps/other') },
        ]),
      },
    });

    expect(rows.map((row) => row.appPath)).toEqual([
      'apps/other',
      'apps/current',
    ]);
    expect(
      resolveMobilePreviewRuntime({
        runtimes: rows,
        selectedRuntimeKey: 'missing',
        currentTaskId: task.id,
      })?.appPath,
    ).toBe('apps/other');
  });

  it('prefers a running hydrated runtime over a running placeholder', () => {
    const project = createProject({ id: 'project-1', name: 'Zulu project' });
    const task = createTask({
      id: 'hydrated-task',
      projectId: project.id,
      name: 'zulu task',
    });
    const rows = derive({
      tasks: [task],
      projects: [project],
      runCommandRunning: {
        'alpha-placeholder': createRunStatus([
          { id: createMobileDevServerCommandId('.'), ports: [8081] },
        ]),
        [task.id]: createRunStatus([
          { id: createMobileDevServerCommandId('.'), ports: [8082] },
        ]),
      },
    });

    expect(rows[0].isContextAvailable).toBe(false);
    expect(
      resolveMobilePreviewRuntime({
        runtimes: rows,
        selectedRuntimeKey: null,
        currentTaskId: null,
      })?.taskId,
    ).toBe(task.id);
  });

  it('resolves valid selection, current task, running row, first row, then null', () => {
    const project = createProject({
      id: 'project-1',
      mobilePreviewConfig: createConfig(),
    });
    const current = createTask({ id: 'current', projectId: project.id });
    const running = createTask({ id: 'running', projectId: project.id });
    const selected = createTask({ id: 'selected', projectId: project.id });
    const selectedKey = createMobilePreviewRuntimeKey({
      taskId: selected.id,
      appPath: 'selected-app',
    });
    const rows = derive({
      tasks: [current, running, selected],
      projects: [project],
      currentTaskId: current.id,
      runCommandRunning: {
        [running.id]: createRunStatus([
          { id: createMobileDevServerCommandId('running-app') },
        ]),
        [selected.id]: createRunStatus([
          { id: createMobileDevServerCommandId('selected-app') },
        ]),
      },
    });

    expect(
      resolveMobilePreviewRuntime({
        runtimes: rows,
        selectedRuntimeKey: selectedKey,
        currentTaskId: current.id,
      })?.taskId,
    ).toBe(selected.id);
    expect(
      resolveMobilePreviewRuntime({
        runtimes: rows,
        selectedRuntimeKey: 'missing',
        currentTaskId: current.id,
      })?.taskId,
    ).toBe(current.id);
    expect(
      resolveMobilePreviewRuntime({
        runtimes: rows.filter((row) => row.taskId !== current.id),
        selectedRuntimeKey: null,
        currentTaskId: 'missing',
      })?.isRunning,
    ).toBe(true);

    const stoppedOnly = rows.filter((row) => row.taskId === current.id);
    expect(
      resolveMobilePreviewRuntime({
        runtimes: stoppedOnly,
        selectedRuntimeKey: null,
        currentTaskId: 'missing',
      }),
    ).toBe(stoppedOnly[0]);
    expect(
      resolveMobilePreviewRuntime({
        runtimes: [],
        selectedRuntimeKey: null,
        currentTaskId: null,
      }),
    ).toBeNull();
  });
});
