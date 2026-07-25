// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { Task, TaskStep } from '@shared/types';
import { act } from 'react';

import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { RootOverlay } from '@/common/context/overlay';
import { useBackgroundJobsStore } from '@/stores/background-jobs';
import { useNavigationStore } from '@/stores/navigation';
import { useTaskMessagesStore } from '@/stores/task-messages';
import { useToastStore } from '@/stores/toasts';

import { TaskPanel } from '.';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  commands: [] as Array<{ label: string; handler: () => void }>,
  createStep: vi.fn(),
  deleteTask: vi.fn(),
  deleteTaskDialogProps: null as null | {
    isOpen: boolean;
    onConfirm: (params: { deleteWorktree: boolean }) => void;
  },
  deletePrWorkspace: vi.fn(),
  deletePrWorkspaceDialogProps: null as null | {
    isOpen: boolean;
    onConfirm: () => void;
  },
  navigate: vi.fn(),
  pathname: '/projects/project-1/tasks/task-1',
  removeSessionAllowedTool: vi.fn(),
  removalResult: null as Promise<void> | null,
  startCommand: vi.fn(),
  steps: [] as TaskStep[] | undefined,
  taskStatus: 'waiting' as Task['status'],
  taskType: 'pr-review' as Task['type'],
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: mocks.pathname } }),
}));

vi.mock('@/common/hooks/use-commands', () => ({
  useCommands: (_scope: string, commands: Array<false | null | undefined | { label: string; handler: () => void }>) => {
    mocks.commands.push(...commands.filter((command): command is { label: string; handler: () => void } => Boolean(command)));
  },
}));

vi.mock('@/common/context/modal', () => ({
  useModal: () => ({ confirm: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/hooks/use-tasks', () => ({
  useTask: () => ({ data: createTask(mocks.taskType) }),
  useClearTaskUserCompleted: mutation,
  useCompleteTask: mutation,
  useDeleteTask: () => ({
    mutate: mocks.deleteTask,
    mutateAsync: mocks.deleteTask,
    isPending: false,
  }),
  useDeleteWorktree: mutation,
  useSetTaskMode: mutation,
  useToggleTaskUserCompleted: mutation,
  useUpdateTask: mutation,
}));

vi.mock('@/hooks/use-projects', () => ({
  useProject: () => ({
    data: {
      id: 'project-1',
      name: 'Jean-Claude',
      path: '/repo',
      defaultAgentBackend: 'claude-code',
      defaultBranch: 'main',
      protectedBranches: [],
    },
  }),
  useProjectFeatureMap: () => ({ data: null }),
  useProjectIsGitRepository: () => ({ data: true }),
}));

vi.mock('@/hooks/use-pr-workspace-actions', () => ({
  usePrWorkspaceActions: () => ({
    deleteCurrent: {
      mutateAsync: mocks.deletePrWorkspace,
      isPending: false,
      error: null,
      reset: vi.fn(),
    },
    deleteAll: mutation(),
  }),
}));

vi.mock('@/hooks/use-steps', () => ({
  useArchiveStep: mutation,
  useSteps: () => ({ data: mocks.steps }),
  useStep: (stepId: string) => ({
    data: mocks.steps?.find((step) => step.id === stepId),
  }),
  useCreateStep: () => ({ mutateAsync: mocks.createStep }),
  useUpdateStep: mutation,
}));

vi.mock('@/hooks/use-settings', () => ({
  getEditorLabel: () => 'Editor',
  useBackendDefaultModelsSetting: () => ({ data: { models: {} } }),
  useBackendsSetting: () => ({
    data: { defaultBackend: 'claude-code', enabledBackends: ['claude-code', 'opencode'] },
  }),
  useEditorSetting: () => ({ data: null }),
  usePromptSnippetsSetting: () => ({ data: [] }),
}));

vi.mock('@/hooks/use-step-permissions', () => ({
  useAddSessionAllowedTool: mutation,
  useAllowForProject: mutation,
  useAllowForProjectWorktrees: mutation,
  useAllowGlobally: mutation,
  useRemoveSessionAllowedTool: () => ({
    mutate: mocks.removeSessionAllowedTool,
    mutateAsync: mocks.removeSessionAllowedTool,
    isPending: false,
  }),
}));

vi.mock('@/hooks/use-agent', () => ({
  useAgentControls: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    respondToPermission: vi.fn(),
    respondToQuestion: vi.fn(),
    sendMessage: vi.fn(),
    queuePrompt: vi.fn(),
    updateQueuedPrompt: vi.fn(),
    cancelQueuedPrompt: vi.fn(),
    isStarting: false,
    isStopping: false,
  }),
  useAgentStream: ({ stepId }: { stepId: string | null }) => ({
    messages: stepId ? [{ id: 'message-1', type: 'assistant-message', value: 'Ready' }] : [],
    queuedPrompts: [],
    isLoading: false,
  }),
}));

vi.mock('@/hooks/use-project-commands', () => ({
  useProjectCommands: () => ({
    data: [
      {
        id: 'command-1',
        projectId: 'project-1',
        name: 'Dev server',
        command: 'pnpm dev',
        ports: [],
        portConflictStrategy: 'prompt',
        portOverrideProvider: 'env',
        portOverrideEnvVar: null,
        portOverrideArgs: null,
        envVars: [],
        confirmBeforeRun: false,
        confirmMessage: null,
        sortOrder: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-project-command-groups', () => ({
  useProjectCommandGroups: () => ({
    data: [],
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-run-commands', () => ({
  useRunCommands: () => ({
    status: null,
    statusByCommandId: {},
    isCommandStarting: () => false,
    isCommandStopping: () => false,
    isStartingAnyCommand: false,
    startCommand: mocks.startCommand,
    startGroup: vi.fn(),
    stopCommand: vi.fn(),
    stopGroup: vi.fn(),
    portsInUseError: null,
    confirmKillPorts: vi.fn(),
    dismissPortsError: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-agent-resource-snapshots', () => ({
  useAgentResourceSnapshots: () => ({ data: [], historyByStepId: {} }),
}));
vi.mock('@/hooks/use-backend-models', () => ({ useBackendModels: () => ({ data: [] }) }));
vi.mock('@/hooks/use-context-usage', () => ({ useContextUsage: () => null }));
vi.mock('@/hooks/use-skills', () => ({ useSkills: () => ({ data: [] }) }));
vi.mock('@/hooks/use-task-root-path', () => ({ useTaskRootPath: () => ({ rootPath: '/repo' }) }));
vi.mock('@/hooks/use-work-items', () => ({ useWorkItemById: () => ({ data: null }) }));

vi.mock('@/lib/api', () => ({
  api: {
    agent: { sendMessage: vi.fn() },
    shell: { openInEditor: vi.fn() },
    tasks: { focused: vi.fn() },
  },
}));

vi.mock('@/features/agent/ui-message-stream', () => ({
  MessageStream: ({
    onAddBashToPermissions,
  }: {
    onAddBashToPermissions?: (command: string) => void;
  }) => (
    <div>
      Normal message UI
      <button onClick={() => onAddBashToPermissions?.('pnpm test')}>
        Add command permission
      </button>
    </div>
  ),
}));
vi.mock('@/features/agent/ui-add-permission-modal', () => ({
  AddPermissionModal: ({ stepId, stepName }: { stepId: string; stepName: string }) => (
    <div>
      Add permission modal for {stepId}: {stepName}
    </div>
  ),
}));
vi.mock('@/features/agent/ui-message-input', () => ({ MessageInput: () => null }));

vi.mock('./add-step-dialog', () => ({
  AddStepDialog: ({
    canContinue,
    isOpen,
    onConfirm,
  }: {
    canContinue?: boolean;
    isOpen: boolean;
    onConfirm: (data: unknown) => Promise<boolean>;
  }) =>
    isOpen ? (
      <div>
        <div>Add Step Dialog</div>
        {canContinue !== false ? <div>Continue preset</div> : null}
        <button
          type="button"
          onClick={() =>
            void onConfirm({
              promptTemplate: 'Inspect this PR',
              hasUserPrompt: true,
              presetType: 'new-session',
              interactionMode: 'auto',
              agentBackend: 'opencode',
              modelPreference: 'gpt-5',
              thinkingEffort: 'high',
              images: [],
              start: true,
              includedReviewCommentIds: [],
            })
          }
        >
          Submit first step
        </button>
      </div>
    ) : null,
}));

vi.mock('./command-logs-pane', () => ({
  CommandLogsPane: () => <div>Existing command logs pane</div>,
}));
vi.mock('./task-name-editor', () => ({
  getTaskTitle: ({ name }: { name: string | null }) => name ?? '',
  TaskNameEditor: () => <div>PR #42</div>,
}));
vi.mock('./task-pending-note-input', () => ({ TaskPendingNoteInput: () => null }));
vi.mock('./task-settings-pane', () => ({
  TaskSettingsPane: ({
    onRemoveTool,
  }: {
    onRemoveTool: (rule: { toolName: string; pattern?: string }) => Promise<void>;
  }) => (
    <div>
      Task settings pane
      <button
        onClick={() => {
          mocks.removalResult = onRemoveTool({
            toolName: 'Bash',
            pattern: 'pnpm test',
          });
        }}
      >
        Remove permission
      </button>
    </div>
  ),
}));
vi.mock('./debug-messages-pane', () => ({ DebugMessagesPane: () => <div>Raw messages pane</div> }));
vi.mock('./delete-task-dialog', () => ({
  DeleteTaskDialog: (props: {
    isOpen: boolean;
    onConfirm: (params: { deleteWorktree: boolean }) => void;
  }) => {
    mocks.deleteTaskDialogProps = props;
    return props.isOpen ? (
      <button onClick={() => props.onConfirm({ deleteWorktree: true })}>
        Confirm generic task delete
      </button>
    ) : null;
  },
}));
vi.mock('@/features/pull-request/ui-delete-pr-workspace-dialog', () => ({
  DeletePrWorkspaceDialog: (props: {
    isOpen: boolean;
    onConfirm: () => void;
  }) => {
    mocks.deletePrWorkspaceDialogProps = props;
    return props.isOpen ? (
      <button onClick={props.onConfirm}>Confirm PR workspace delete</button>
    ) : null;
  },
}));
vi.mock('./complete-task-dialog', () => ({ CompleteTaskDialog: () => null }));
vi.mock('./change-worktree-path-dialog', () => ({ ChangeWorktreePathDialog: () => null }));

function mutation() {
  return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
}

function createTask(type: Task['type']): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    type,
    name: 'PR #42',
    prompt: 'Review pull request',
    status: mocks.taskStatus,
    worktreePath: '/repo/.worktrees/pr-42',
    startCommitHash: 'abc123',
    sourceBranch: 'main',
    branchName: 'feature/pr-42',
    prWorkspaceState: 'active',
    hasUnread: false,
    userCompleted: false,
    workItemIds: null,
    workItemUrls: null,
    pullRequestId: '42',
    pullRequestUrl: 'https://example.com/pr/42',
    pendingMessage: null,
    todoItems: [],
    parentTaskId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function createStep(): TaskStep {
  return {
    id: 'step-1',
    taskId: 'task-1',
    name: 'Inspect this PR',
    type: 'agent',
    dependsOn: [],
    promptTemplate: 'Inspect this PR',
    resolvedPrompt: 'Inspect this PR',
    status: 'running',
    sessionId: 'session-1',
    interactionMode: 'auto',
    modelPreference: 'gpt-5',
    thinkingEffort: 'high',
    agentBackend: 'opencode',
    output: null,
    images: null,
    meta: {},
    sessionRules: {},
    autoStart: false,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('TaskPanel zero-step PR workspace', () => {
  let container: HTMLDivElement;
  let root: Root;

  async function renderPanel() {
    await act(async () =>
      root.render(
        <RootOverlay>
          <RootKeyboardBindings>
            <TaskPanel taskId="task-1" />
          </RootKeyboardBindings>
        </RootOverlay>,
      ),
    );
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    mocks.commands = [];
    mocks.steps = [];
    mocks.taskStatus = 'waiting';
    mocks.taskType = 'pr-review';
    mocks.createStep.mockReset().mockImplementation(async () => {
      const step = createStep();
      mocks.steps = [step];
      return step;
    });
    mocks.navigate.mockReset();
    mocks.deleteTask.mockReset().mockResolvedValue(undefined);
    mocks.deleteTaskDialogProps = null;
    mocks.pathname = '/projects/project-1/tasks/task-1';
    mocks.deletePrWorkspace.mockReset().mockResolvedValue(undefined);
    mocks.deletePrWorkspaceDialogProps = null;
    mocks.removeSessionAllowedTool.mockReset().mockResolvedValue(undefined);
    mocks.removalResult = null;
    mocks.startCommand.mockReset().mockResolvedValue(undefined);
    useNavigationStore.setState({ taskState: {}, addStepDrafts: {} });
    useBackgroundJobsStore.setState({ jobs: [] });
    useTaskMessagesStore.setState({ steps: {}, runCommandLogs: {}, runCommandRunning: {} });
    useToastStore.setState({ toasts: [] });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
  });

  it('creates and activates first generic step, then renders normal messages', async () => {
    await renderPanel();
    expect(container.textContent).toContain('PR Workspace');
    expect(container.textContent).not.toContain('Task Settings');

    await act(async () => findButton('Add Step').click());
    expect(container.textContent).toContain('Add Step Dialog');
    expect(container.textContent).not.toContain('Continue preset');

    await act(async () => findButton('Submit first step').click());

    expect(mocks.createStep).toHaveBeenCalledWith({
      taskId: 'task-1',
      name: 'Inspect this PR',
      type: 'agent',
      promptTemplate: 'Inspect this PR',
      interactionMode: 'auto',
      agentBackend: 'opencode',
      modelPreference: 'gpt-5',
      thinkingEffort: 'high',
      images: null,
      dependsOn: [],
      sortOrder: 0,
      start: true,
    });
    expect(useNavigationStore.getState().taskState['task-1']?.activeStepId).toBe('step-1');

    await renderPanel();
    expect(container.textContent).not.toContain('PR Workspace');
    expect(container.textContent).toContain('Normal message UI');
    expect(mocks.steps?.[0]?.status).toBe('running');
    expect(mocks.steps?.[0]?.autoStart).toBe(false);
    expect(
      mocks.commands.some((command) => command.label === 'Toggle Task Settings'),
    ).toBe(true);
  });

  it('wires actual RunButton, explicit logs, PR route, and hides settings commands', async () => {
    await renderPanel();

    expect(mocks.commands.some((command) => command.label === 'Toggle Task Settings')).toBe(false);
    expect(mocks.commands.some((command) => command.label.includes('Raw Message'))).toBe(false);
    expect(mocks.commands.some((command) => command.label === 'Copy Session ID')).toBe(false);

    const taskMenu = container.querySelector<HTMLButtonElement>(
      '[title^="Task menu"]',
    );
    expect(taskMenu).not.toBeNull();
    await act(async () => taskMenu!.click());
    expect(document.body.textContent).not.toContain('Task Settings');
    expect(document.body.textContent).not.toContain('Raw Messages');
    await act(async () => taskMenu!.click());

    await act(async () => findButton('Logs').click());
    expect(container.textContent).toContain('Existing command logs pane');

    await act(async () => findButton('View Pull Request').click());
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/projects/$projectId/prs/$prId',
      params: { projectId: 'project-1', prId: '42' },
    });

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Run command"]')!.click());
    expect(document.body.textContent).toContain('Dev server');
    await act(async () => findButton('Dev server').click());
    expect(mocks.startCommand).toHaveBeenCalledWith('command-1');
    expect(container.textContent).toContain('Existing command logs pane');
  });

  it('opens workspace deletion from zero-step empty state', async () => {
    await renderPanel();

    await act(async () => findButton('Delete PR Workspace').click());

    expect(mocks.deletePrWorkspaceDialogProps?.isOpen).toBe(true);
  });

  it('preserves Continue behavior for generic zero-step tasks', async () => {
    mocks.taskType = 'agent';
    await renderPanel();

    const addStepCommand = mocks.commands.find((command) => command.label === 'Add Step');
    expect(addStepCommand).toBeDefined();
    await act(async () => addStepCommand!.handler());
    expect(container.textContent).toContain('Continue preset');
  });

  it('preserves real generic task deletion flow without calling PR deletion', async () => {
    mocks.taskType = 'agent';
    await renderPanel();

    await act(async () =>
      mocks.commands.find((command) => command.label === 'Delete Task')!.handler(),
    );
    expect(mocks.deleteTaskDialogProps?.isOpen).toBe(true);

    await act(async () => findButton('Confirm generic task delete').click());
    await vi.waitFor(() => expect(mocks.deleteTask).toHaveBeenCalledTimes(1));

    expect(mocks.deleteTask).toHaveBeenCalledWith({
      id: 'task-1',
      deleteWorktree: true,
    });
    expect(mocks.deletePrWorkspace).not.toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/all' });
    expect(useBackgroundJobsStore.getState().jobs.at(-1)).toMatchObject({
      taskId: 'task-1',
      type: 'task-deletion',
      status: 'succeeded',
    });
  });

  it('uses current PR workspace deletion and navigates after project-route success', async () => {
    await renderPanel();
    const deleteCommand = mocks.commands.find(
      (command) => command.label === 'Delete PR Workspace',
    );
    expect(deleteCommand).toBeDefined();
    expect(mocks.commands.some((command) => command.label === 'Delete Worktree')).toBe(
      false,
    );

    await act(async () => deleteCommand!.handler());
    await act(async () => findButton('Confirm PR workspace delete').click());

    expect(mocks.deletePrWorkspace).toHaveBeenCalledWith({ taskId: 'task-1' });
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/projects/$projectId/prs/$prId',
      params: { projectId: 'project-1', prId: '42' },
    });
    expect(useBackgroundJobsStore.getState().jobs.at(-1)).toMatchObject({
      taskId: 'task-1',
      type: 'task-deletion',
      status: 'succeeded',
    });
  });

  it('does not block modal or navigation while PR deletion is running', async () => {
    let resolveDeletion!: () => void;
    mocks.deletePrWorkspace.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDeletion = resolve;
      }),
    );
    await renderPanel();

    await act(async () => {
      await findButton('Delete PR Workspace').click();
      findButton('Confirm PR workspace delete').click();
    });

    expect(mocks.deletePrWorkspace).toHaveBeenCalledWith({ taskId: 'task-1' });
    expect(mocks.deletePrWorkspaceDialogProps?.isOpen).toBe(false);
    expect(mocks.navigate).toHaveBeenCalled();
    expect(useBackgroundJobsStore.getState().jobs.at(-1)).toMatchObject({
      type: 'task-deletion',
      status: 'running',
    });

    await act(async () => resolveDeletion());
    await vi.waitFor(() =>
      expect(useBackgroundJobsStore.getState().jobs.at(-1)).toMatchObject({
        status: 'succeeded',
      }),
    );
  });

  it('keeps backend-managed PR workspace deletion available while running', async () => {
    mocks.taskStatus = 'running';
    await renderPanel();

    expect(
      mocks.commands.some((command) => command.label === 'Delete PR Workspace'),
    ).toBe(true);
    expect(
      mocks.commands.some((command) => command.label === 'Delete Worktree'),
    ).toBe(false);

    mocks.taskType = 'agent';
    mocks.commands = [];
    await renderPanel();
    expect(
      mocks.commands.some((command) => command.label === 'Delete Task'),
    ).toBe(false);
  });

  it('uses all-route PR redirect only after successful deletion', async () => {
    mocks.pathname = '/all/task-1';
    await renderPanel();
    await act(async () =>
      mocks.commands.find((command) => command.label === 'Delete PR Workspace')!.handler(),
    );
    expect(mocks.navigate).not.toHaveBeenCalled();

    await act(async () => findButton('Confirm PR workspace delete').click());
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/all/prs/$projectId/$prId',
      params: { projectId: 'project-1', prId: '42' },
    });
  });

  it('reports failed deletion through the background job', async () => {
    mocks.deletePrWorkspace.mockRejectedValue(new Error('cleanup failed'));
    await renderPanel();
    await act(async () =>
      mocks.commands.find((command) => command.label === 'Delete PR Workspace')!.handler(),
    );

    await act(async () => findButton('Confirm PR workspace delete').click());

    expect(mocks.deletePrWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalled();
    expect(mocks.deletePrWorkspaceDialogProps?.isOpen).toBe(false);
    expect(useBackgroundJobsStore.getState().jobs.at(-1)).toMatchObject({
      type: 'task-deletion',
      status: 'failed',
      errorMessage: 'cleanup failed',
    });
  });

  it('uses route-family fallbacks and keeps normal task actions unchanged', async () => {
    mocks.pathname = '/all/unknown/task-1';
    await renderPanel();
    await act(async () =>
      mocks.commands.find((command) => command.label === 'Delete PR Workspace')!.handler(),
    );
    await act(async () => findButton('Confirm PR workspace delete').click());
    expect(mocks.navigate).toHaveBeenLastCalledWith({ to: '/all' });

    mocks.pathname = '/projects/project-1/unknown/task-1';
    mocks.commands = [];
    await renderPanel();
    await act(async () =>
      mocks.commands.find((command) => command.label === 'Delete PR Workspace')!.handler(),
    );
    await act(async () => findButton('Confirm PR workspace delete').click());
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: '/projects/$projectId',
      params: { projectId: 'project-1' },
    });

    mocks.taskType = 'agent';
    mocks.commands = [];
    await renderPanel();
    expect(mocks.commands.some((command) => command.label === 'Delete Task')).toBe(true);
    expect(mocks.commands.some((command) => command.label === 'Delete Worktree')).toBe(true);
  });

  it('keeps permission modal bound to its generic origin when active selection changes', async () => {
    const genericStep = createStep();
    const chatStep = createStep();
    chatStep.id = 'chat-step';
    chatStep.name = 'Review chat';
    chatStep.meta = {
      kind: 'pr-review-chat',
      pullRequestId: 42,
      filePath: 'src/app.ts',
      lineStart: 1,
      selectedText: 'text',
    };
    mocks.steps = [genericStep, chatStep];
    await act(async () =>
      useNavigationStore.getState().setActiveStepId('task-1', genericStep.id),
    );
    await renderPanel();
    await act(async () => findButton('Add command permission').click());
    expect(container.textContent).toContain(
      'Add permission modal for step-1: Inspect this PR',
    );

    await act(async () =>
      useNavigationStore.getState().setActiveStepId('task-1', chatStep.id),
    );
    await renderPanel();
    expect(container.textContent).toContain(
      'Add permission modal for step-1: Inspect this PR',
    );
  });

  it('closes a permission modal when its origin disappears and rejects chat origins', async () => {
    const genericStep = createStep();
    mocks.steps = [genericStep];
    await act(async () =>
      useNavigationStore.getState().setActiveStepId('task-1', genericStep.id),
    );
    await renderPanel();
    await act(async () => findButton('Add command permission').click());
    expect(container.textContent).toContain('Add permission modal for step-1');

    const chatStep = createStep();
    chatStep.id = 'chat-step';
    chatStep.meta = {
      kind: 'pr-review-chat',
      pullRequestId: 42,
      filePath: 'src/app.ts',
      lineStart: 1,
      selectedText: 'text',
    };
    mocks.steps = [chatStep];
    await act(async () =>
      useNavigationStore.getState().setActiveStepId('task-1', chatStep.id),
    );
    await renderPanel();
    expect(container.textContent).not.toContain('Add permission modal');

    await act(async () => findButton('Add command permission').click());
    expect(container.textContent).not.toContain('Add permission modal');
  });

  it('settles permission removal failures after showing backend reason', async () => {
    const genericStep = createStep();
    mocks.steps = [genericStep];
    mocks.removeSessionAllowedTool.mockRejectedValue(new Error('backend denied removal'));
    await act(async () =>
      useNavigationStore.getState().setActiveStepId('task-1', genericStep.id),
    );
    useNavigationStore.getState().setTaskRightPane('task-1', { type: 'settings' });
    await renderPanel();

    await act(async () => findButton('Remove permission').click());
    await expect(mocks.removalResult).resolves.toBeUndefined();
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
      message: 'backend denied removal',
      type: 'error',
    });
  });

  it('closes prohibited panes when zero-state loads and keeps command logs allowed', async () => {
    mocks.steps = undefined;
    useNavigationStore.getState().setTaskRightPane('task-1', { type: 'settings' });
    await renderPanel();
    expect(container.textContent).toContain('Task settings pane');
    expect(container.querySelector('.mr-2')).not.toBeNull();

    mocks.steps = [];
    await renderPanel();
    expect(container.textContent).not.toContain('Task settings pane');
    expect(container.querySelector('.mr-2')).toBeNull();
    expect(useNavigationStore.getState().taskState['task-1']?.rightPane).toBeNull();

    await act(async () =>
      useNavigationStore
        .getState()
        .setTaskRightPane('task-1', { type: 'debugMessages' }),
    );
    expect(container.textContent).not.toContain('Raw messages pane');
    expect(useNavigationStore.getState().taskState['task-1']?.rightPane).toBeNull();

    await act(async () =>
      useNavigationStore
        .getState()
        .setTaskRightPane('task-1', {
          type: 'commandLogs',
          selectedCommandId: null,
        }),
    );
    expect(container.textContent).toContain('Existing command logs pane');
    expect(container.querySelector('.mr-2')).not.toBeNull();

    await act(async () => useNavigationStore.getState().setTaskRightPane('task-1', null));
    mocks.steps = [createStep()];
    await renderPanel();
    expect(useNavigationStore.getState().taskState['task-1']?.rightPane).toBeNull();
    expect(container.textContent).not.toContain('Task settings pane');
  });

  function findButton(label: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll('button')).find((entry) =>
      entry.textContent?.includes(label),
    );
    if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
    return button;
  }
});
