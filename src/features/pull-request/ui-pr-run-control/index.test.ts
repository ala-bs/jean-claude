/**
 * @vitest-environment happy-dom
 */
/* eslint-disable sort-imports */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, StrictMode, type ComponentProps } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ProjectCommand,
  ProjectCommandGroup,
  RunStatus,
} from '@shared/run-command-types';
import type { Task } from '@shared/types';

import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { RootOverlay } from '@/common/context/overlay';
import { RunningCommandsOverlay } from '@/features/run-commands/ui-running-commands-overlay';
import { api } from '@/lib/api';
import { useBackgroundJobsStore } from '@/stores/background-jobs';
import { useOverlaysStore } from '@/stores/overlays';
import { useTaskMessagesStore } from '@/stores/task-messages';
import { useToastStore } from '@/stores/toasts';

import { PrRunControl } from '.';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient;
let statusListener: ((taskId: string, status: RunStatus) => void) | null = null;

const commandOne = buildCommand({
  id: 'command-1',
  name: 'Web server',
  sortOrder: 2,
  createdAt: '2026-01-02T00:00:00.000Z',
});
const commandTwo = buildCommand({
  id: 'command-2',
  name: 'API server',
  sortOrder: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
});
const group = buildGroup({
  id: 'group-1',
  name: 'Full stack',
  commandIds: ['command-1', 'command-2'],
  sortOrder: 0,
});
const stoppedStatus: RunStatus = {
  isRunning: false,
  commands: [
    { id: 'command-1', name: 'Web server', command: 'pnpm web', status: 'stopped' },
    { id: 'command-2', name: 'API server', command: 'pnpm api', status: 'stopped' },
  ],
};
const runningStatus: RunStatus = {
  isRunning: true,
  commands: [
    { id: 'command-1', name: 'Web server', command: 'pnpm web', status: 'running' },
    { id: 'command-2', name: 'API server', command: 'pnpm api', status: 'running' },
  ],
};

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  statusListener = null;
  vi.spyOn(api.projectCommands, 'findByProjectId').mockResolvedValue([
    commandOne,
    commandTwo,
  ]);
  vi.spyOn(api.projectCommandGroups, 'findByProjectId').mockResolvedValue([group]);
  vi.spyOn(api.runCommands, 'getStatus').mockResolvedValue(stoppedStatus);
  vi.spyOn(api.runCommands, 'onStatusChange').mockImplementation((listener) => {
    statusListener = listener;
    return () => {};
  });
  vi.spyOn(api.runCommands, 'stopCommand').mockResolvedValue(undefined);
  vi.spyOn(api.runCommands, 'killPortsForCommand').mockResolvedValue(undefined);
  vi.spyOn(api.tasks, 'startPrCommand').mockResolvedValue({
    task: buildTask(),
    created: true,
    runCommandIds: ['command-1', 'command-2'],
    runResult: runningStatus,
  });
  useOverlaysStore.setState({
    activeOverlay: null,
    runningCommandTarget: null,
  });
  useToastStore.setState({ toasts: [] });
  useBackgroundJobsStore.setState({ jobs: [] });
  useTaskMessagesStore.setState({ runCommandRunning: {} });
});

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  queryClient.clear();
  vi.restoreAllMocks();
});

function buildCommand(overrides: Partial<ProjectCommand> = {}): ProjectCommand {
  return {
    id: 'command-1',
    projectId: 'project-1',
    name: 'Command',
    command: 'pnpm dev',
    ports: [],
    portConflictStrategy: 'prompt',
    portOverrideProvider: 'env',
    portOverrideEnvVar: null,
    portOverrideArgs: null,
    envVars: [],
    confirmBeforeRun: false,
    confirmMessage: null,
    isFavorite: false,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function buildGroup(
  overrides: Partial<ProjectCommandGroup> = {},
): ProjectCommandGroup {
  return {
    id: 'group-1',
    projectId: 'project-1',
    name: 'Group',
    commandIds: ['command-1'],
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    type: 'pr-review',
    name: 'Review PR #42',
    prompt: 'Review PR',
    status: 'waiting',
    worktreePath: '/tmp/review-42',
    startCommitHash: 'abc',
    sourceBranch: 'feature',
    branchName: 'review-42',
    prWorkspaceState: 'active',
    hasUnread: false,
    userCompleted: false,
    workItemIds: null,
    workItemUrls: null,
    pullRequestId: '42',
    pullRequestUrl: null,
    pendingMessage: null,
    todoItems: [],
    parentTaskId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderControl(
  props: Partial<ComponentProps<typeof PrRunControl>> = {},
  { strictMode = false }: { strictMode?: boolean } = {},
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  rerender(props, { strictMode });
}

function rerender(
  props: Partial<ComponentProps<typeof PrRunControl>> = {},
  { strictMode = false }: { strictMode?: boolean } = {},
) {
  const control = createElement(PrRunControl, {
    projectId: 'project-1',
    pullRequestId: 42,
    status: 'active',
    readOnly: false,
    ...props,
  });
  flushSync(() => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          RootOverlay,
          null,
          createElement(
            RootKeyboardBindings,
            null,
            strictMode ? createElement(StrictMode, null, control) : control,
          ),
        ),
      ),
    );
  });
}

async function flushUpdates() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForFocusedMenuItem() {
  for (let frame = 0; frame < 5; frame += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const activeElement = document.activeElement;
    if (activeElement?.getAttribute('role') === 'menuitem') {
      return activeElement;
    }
  }
  throw new Error('Dropdown menu item did not receive focus');
}

function button(name: string) {
  const result = Array.from(document.querySelectorAll('button')).find(
    (candidate) =>
      (candidate.getAttribute('aria-label') ?? candidate.textContent?.trim()) ===
      name,
  );
  if (!result) throw new Error(`Button not found: ${name}`);
  return result as HTMLButtonElement;
}

function buttonContaining(text: string) {
  const result = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.includes(text),
  );
  if (!result) throw new Error(`Button not found containing: ${text}`);
  return result as HTMLButtonElement;
}

function click(element: Element) {
  flushSync(() =>
    element.dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );
}

async function openPicker() {
  click(button('Start project'));
  await flushUpdates();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((resolvePromise) => {
      resolve = resolvePromise;
    }),
    resolve,
  };
}

describe('PrRunControl', () => {
  it.each([
    { readOnly: true },
    { status: 'completed' as const },
    { status: 'abandoned' as const },
  ])('hides when unavailable: $status', async (props) => {
    renderControl(props);
    await flushUpdates();
    expect(document.body.textContent).not.toContain('Start project');
  });

  it('hides without saved commands or groups', async () => {
    vi.mocked(api.projectCommands.findByProjectId).mockResolvedValue([]);
    vi.mocked(api.projectCommandGroups.findByProjectId).mockResolvedValue([]);
    renderControl();
    await flushUpdates();
    expect(document.body.textContent).not.toContain('Start project');
  });

  it('hides when every saved group resolves to no executable commands', async () => {
    vi.mocked(api.projectCommands.findByProjectId).mockResolvedValue([]);
    vi.mocked(api.projectCommandGroups.findByProjectId).mockResolvedValue([
      buildGroup({ commandIds: ['deleted-command'] }),
    ]);
    renderControl();
    await flushUpdates();

    expect(document.body.textContent).not.toContain('Start project');
  });

  it('shows command query errors and retries the failed query', async () => {
    vi.mocked(api.projectCommands.findByProjectId)
      .mockRejectedValueOnce(new Error('commands failed'))
      .mockResolvedValueOnce([commandOne]);
    renderControl();
    await flushUpdates();

    expect(document.body.textContent).toContain('Commands unavailable');
    click(button('Retry loading project commands'));
    await flushUpdates();

    expect(api.projectCommands.findByProjectId).toHaveBeenCalledTimes(2);
    expect(api.projectCommandGroups.findByProjectId).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('Start project');
  });

  it('retries both command queries when both fail', async () => {
    vi.mocked(api.projectCommands.findByProjectId)
      .mockRejectedValueOnce(new Error('commands failed'))
      .mockResolvedValueOnce([commandOne]);
    vi.mocked(api.projectCommandGroups.findByProjectId)
      .mockRejectedValueOnce(new Error('groups failed'))
      .mockResolvedValueOnce([]);
    renderControl();
    await flushUpdates();

    click(button('Retry loading project commands'));
    await flushUpdates();

    expect(api.projectCommands.findByProjectId).toHaveBeenCalledTimes(2);
    expect(api.projectCommandGroups.findByProjectId).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('Start project');
  });

  it('shows sorted command and group picker rows', async () => {
    renderControl();
    await flushUpdates();
    await openPicker();
    const text = document.body.textContent ?? '';

    expect(text.indexOf('Full stack')).toBeLessThan(text.indexOf('API server'));
    expect(text.indexOf('API server')).toBeLessThan(text.indexOf('Web server'));
  });

  it('opens the idle picker from the caret', async () => {
    renderControl();
    await flushUpdates();
    click(button('Choose project command'));
    await flushUpdates();

    expect(document.body.textContent).toContain('Full stack');
    expect(document.body.textContent).toContain('API server');
  });

  it('exposes dropdown semantics and restores focus to each initiating segment', async () => {
    renderControl();
    await flushUpdates();
    const caret = button('Choose project command');
    const primary = button('Start project');

    expect(caret.getAttribute('aria-haspopup')).toBe('menu');
    expect(caret.getAttribute('aria-expanded')).toBe('false');
    expect(primary.getAttribute('aria-haspopup')).toBe('menu');
    expect(primary.getAttribute('aria-expanded')).toBe('false');

    click(primary);
    await flushUpdates();
    let menu = document.querySelector('[role="menu"]');
    expect(primary.getAttribute('aria-expanded')).toBe('true');
    expect(primary.getAttribute('aria-controls')).toBe(menu?.id);
    const primaryMenuItem = await waitForFocusedMenuItem();
    primaryMenuItem.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await flushUpdates();
    expect(document.activeElement).toBe(primary);

    click(caret);
    await flushUpdates();

    menu = document.querySelector('[role="menu"]');
    expect(caret.getAttribute('aria-expanded')).toBe('true');
    expect(caret.getAttribute('aria-controls')).toBe(menu?.id);

    const caretMenuItem = await waitForFocusedMenuItem();
    caretMenuItem.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await flushUpdates();
    expect(caret.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(caret);
  });

  it('keeps menu ARIA on only the caret while primary opens running logs', async () => {
    renderControl({ associatedTask: buildTask() });
    await flushUpdates();
    flushSync(() => statusListener?.('task-1', runningStatus));

    const primary = button('View command logs');
    const caret = button('Choose project command');
    expect(primary.hasAttribute('aria-haspopup')).toBe(false);
    expect(primary.hasAttribute('aria-expanded')).toBe(false);
    expect(primary.hasAttribute('aria-controls')).toBe(false);
    expect(caret.getAttribute('aria-haspopup')).toBe('menu');
    expect(caret.getAttribute('aria-expanded')).toBe('false');
  });

  it('confirms before preparation and cancel creates no workspace', async () => {
    vi.mocked(api.projectCommands.findByProjectId).mockResolvedValue([
      { ...commandOne, confirmBeforeRun: true, confirmMessage: 'Proceed?' },
    ]);
    vi.mocked(api.projectCommandGroups.findByProjectId).mockResolvedValue([]);
    renderControl();
    await flushUpdates();
    await openPicker();
    click(button('Web serverRun'));

    expect(document.body.textContent).toContain('Proceed?');
    expect(api.tasks.startPrCommand).not.toHaveBeenCalled();
    click(button('Cancel'));
    expect(api.tasks.startPrCommand).not.toHaveBeenCalled();
    expect(useBackgroundJobsStore.getState().jobs).toHaveLength(0);
  });

  it('starts with exact PR params, prevents duplicates, and opens targeted logs', async () => {
    let resolveStart!: (value: Awaited<ReturnType<typeof api.tasks.startPrCommand>>) => void;
    vi.mocked(api.tasks.startPrCommand).mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    renderControl();
    await flushUpdates();
    await openPicker();
    click(button('API serverRun'));
    expect(button('Start project').disabled).toBe(true);
    click(button('Start project'));

    expect(api.tasks.startPrCommand).toHaveBeenCalledTimes(1);
    expect(api.tasks.startPrCommand).toHaveBeenCalledWith({
      projectId: 'project-1',
      pullRequestId: 42,
      target: { type: 'command', id: 'command-2' },
    });
    resolveStart({
      task: buildTask(),
      created: true,
      runCommandIds: ['command-2'],
      runResult: runningStatus,
    });
    vi.mocked(api.runCommands.getStatus).mockResolvedValue(runningStatus);
    await flushUpdates();

    expect(useOverlaysStore.getState()).toMatchObject({
      activeOverlay: 'running-commands',
      runningCommandTarget: { taskId: 'task-1', runCommandId: 'command-2' },
    });
    expect(useTaskMessagesStore.getState().runCommandRunning['task-1']).toEqual(
      runningStatus,
    );
    expect(useBackgroundJobsStore.getState().jobs[0]).toMatchObject({
      status: 'succeeded',
      taskId: 'task-1',
      projectId: 'project-1',
      details: { pullRequestId: 42, created: true },
    });
    expect(api.runCommands.getStatus).toHaveBeenCalledWith('task-1');
  });

  it('starts a group target and focuses its first selected command', async () => {
    vi.mocked(api.runCommands.getStatus).mockResolvedValue(runningStatus);
    vi.mocked(api.tasks.startPrCommand).mockResolvedValue({
      task: buildTask(),
      created: true,
      runCommandIds: ['command-2', 'command-1'],
      runResult: runningStatus,
    });
    renderControl();
    await flushUpdates();
    await openPicker();
    click(button('Full stackGroupRun'));
    await flushUpdates();

    expect(api.tasks.startPrCommand).toHaveBeenCalledWith({
      projectId: 'project-1',
      pullRequestId: 42,
      target: { type: 'group', id: 'group-1' },
    });
    expect(useOverlaysStore.getState().runningCommandTarget).toEqual({
      taskId: 'task-1',
      runCommandId: 'command-2',
    });
  });

  it('refreshes authoritative status when launch returns the associated task', async () => {
    renderControl({ associatedTask: buildTask() });
    await flushUpdates();
    expect(api.runCommands.getStatus).toHaveBeenCalledTimes(1);

    await openPicker();
    click(button('API serverRun'));
    await flushUpdates();

    expect(api.runCommands.getStatus).toHaveBeenCalledTimes(2);
    expect(api.runCommands.getStatus).toHaveBeenLastCalledWith('task-1');
  });

  it('retries port conflicts through PR IPC with one activity job', async () => {
    vi.mocked(api.tasks.startPrCommand)
      .mockResolvedValueOnce({
        task: buildTask(),
        created: true,
        runCommandIds: ['command-1'],
        runResult: {
          type: 'PortsInUseError',
          message: 'busy',
          portsInUse: [
            { port: 3000, commandId: 'command-1', command: 'web' },
            { port: 3001, commandId: 'command-1', command: 'web' },
          ],
        },
      })
      .mockResolvedValueOnce({
        task: buildTask(),
        created: false,
        runCommandIds: ['command-1'],
        runResult: runningStatus,
      });
    renderControl();
    await flushUpdates();
    await openPicker();
    click(button('Web serverRun'));
    await flushUpdates();

    expect(useOverlaysStore.getState().activeOverlay).toBeNull();
    const activityJobId = useBackgroundJobsStore.getState().jobs[0]?.id;
    expect(useBackgroundJobsStore.getState().jobs[0]).toMatchObject({
      status: 'running',
      taskId: null,
      details: { pullRequestId: 42 },
    });
    click(button('Kill & Start⌘↵'));
    await flushUpdates();

    expect(api.runCommands.killPortsForCommand).toHaveBeenCalledTimes(1);
    expect(api.tasks.startPrCommand).toHaveBeenCalledTimes(2);
    expect(useBackgroundJobsStore.getState().jobs).toHaveLength(1);
    expect(useBackgroundJobsStore.getState().jobs[0]?.id).toBe(activityJobId);
    expect(useBackgroundJobsStore.getState().jobs[0]).toMatchObject({
      status: 'succeeded',
      details: { created: false },
    });
  });

  it('marks a pending port-conflict activity cancelled when the user cancels', async () => {
    vi.mocked(api.tasks.startPrCommand).mockResolvedValue({
      task: buildTask(),
      created: true,
      runCommandIds: ['command-1'],
      runResult: {
        type: 'PortsInUseError',
        message: 'busy',
        portsInUse: [
          { port: 3000, commandId: 'command-1', command: 'web' },
        ],
      },
    });
    renderControl();
    await flushUpdates();
    await openPicker();
    click(button('Web serverRun'));
    await flushUpdates();

    expect(useBackgroundJobsStore.getState().jobs[0]).toMatchObject({
      status: 'running',
      taskId: null,
    });
    expect(api.runCommands.getStatus).toHaveBeenCalledWith('task-1');
    click(buttonContaining('Cancel'));

    expect(useBackgroundJobsStore.getState().jobs[0]).toMatchObject({
      status: 'failed',
      errorMessage: 'Launch cancelled while waiting for port confirmation',
    });
  });

  it('marks pending port-conflict activity failed when killing ports fails', async () => {
    vi.mocked(api.tasks.startPrCommand).mockResolvedValue({
      task: buildTask(),
      created: true,
      runCommandIds: ['command-1'],
      runResult: {
        type: 'PortsInUseError',
        message: 'busy',
        portsInUse: [
          { port: 3000, commandId: 'command-1', command: 'web' },
        ],
      },
    });
    vi.mocked(api.runCommands.killPortsForCommand).mockRejectedValue(
      new Error('kill failed'),
    );
    renderControl();
    await flushUpdates();
    await openPicker();
    click(button('Web serverRun'));
    await flushUpdates();
    const activityJobId = useBackgroundJobsStore.getState().jobs[0]?.id;
    click(button('Kill & Start⌘↵'));
    await flushUpdates();

    expect(useBackgroundJobsStore.getState().jobs).toHaveLength(1);
    expect(useBackgroundJobsStore.getState().jobs[0]).toMatchObject({
      id: activityJobId,
      status: 'failed',
      errorMessage: 'kill failed',
    });
  });

  it('marks pending port-conflict activity failed when retry launch fails', async () => {
    vi.mocked(api.tasks.startPrCommand)
      .mockResolvedValueOnce({
        task: buildTask(),
        created: true,
        runCommandIds: ['command-1'],
        runResult: {
          type: 'PortsInUseError',
          message: 'busy',
          portsInUse: [
            { port: 3000, commandId: 'command-1', command: 'web' },
          ],
        },
      })
      .mockRejectedValueOnce(new Error('retry failed'));
    renderControl();
    await flushUpdates();
    await openPicker();
    click(button('Web serverRun'));
    await flushUpdates();
    const activityJobId = useBackgroundJobsStore.getState().jobs[0]?.id;
    click(button('Kill & Start⌘↵'));
    await flushUpdates();

    expect(useBackgroundJobsStore.getState().jobs).toHaveLength(1);
    expect(useBackgroundJobsStore.getState().jobs[0]).toMatchObject({
      id: activityJobId,
      status: 'failed',
      errorMessage: 'retry failed',
    });
  });

  it('settles pending port decision when PR context becomes ineligible', async () => {
    vi.mocked(api.tasks.startPrCommand).mockResolvedValue({
      task: buildTask(),
      created: true,
      runCommandIds: ['command-1'],
      runResult: {
        type: 'PortsInUseError',
        message: 'busy',
        portsInUse: [
          { port: 3000, commandId: 'command-1', command: 'web' },
        ],
      },
    });
    renderControl();
    await flushUpdates();
    await openPicker();
    click(button('Web serverRun'));
    await flushUpdates();

    rerender({ status: 'completed' });
    await flushUpdates();

    expect(useBackgroundJobsStore.getState().jobs[0]).toMatchObject({
      status: 'failed',
      errorMessage:
        'Launch cancelled while waiting for port confirmation because the pull request context changed',
    });
    expect(useOverlaysStore.getState().activeOverlay).toBeNull();
  });

  it('settles pending port decision when the component unmounts', async () => {
    vi.mocked(api.tasks.startPrCommand).mockResolvedValue({
      task: buildTask(),
      created: true,
      runCommandIds: ['command-1'],
      runResult: {
        type: 'PortsInUseError',
        message: 'busy',
        portsInUse: [
          { port: 3000, commandId: 'command-1', command: 'web' },
        ],
      },
    });
    renderControl();
    await flushUpdates();
    await openPicker();
    click(button('Web serverRun'));
    await flushUpdates();
    root?.unmount();
    root = null;

    expect(useBackgroundJobsStore.getState().jobs[0]).toMatchObject({
      status: 'failed',
      errorMessage:
        'Launch cancelled while waiting for port confirmation because the view closed',
    });
    expect(useOverlaysStore.getState().activeOverlay).toBeNull();
  });

  it('settles stale launch activity without applying UI after context changes', async () => {
    const start = deferred<Awaited<ReturnType<typeof api.tasks.startPrCommand>>>();
    vi.mocked(api.tasks.startPrCommand).mockReturnValue(start.promise);
    renderControl({ associatedTask: buildTask() });
    await flushUpdates();
    await openPicker();
    click(button('API serverRun'));

    rerender({
      projectId: 'project-2',
      pullRequestId: 99,
      associatedTask: buildTask({
        id: 'task-2',
        projectId: 'project-2',
        pullRequestId: '99',
        worktreePath: '/tmp/review-99',
      }),
    });
    start.resolve({
      task: buildTask(),
      created: true,
      runCommandIds: ['command-2'],
      runResult: runningStatus,
    });
    await flushUpdates();

    expect(useBackgroundJobsStore.getState().jobs[0]).toMatchObject({
      status: 'succeeded',
      taskId: 'task-1',
    });
    expect(useOverlaysStore.getState().activeOverlay).toBeNull();
    expect(useTaskMessagesStore.getState().runCommandRunning['task-1']).toBeUndefined();
  });

  it('settles launch activity without applying UI after unmount', async () => {
    const start = deferred<Awaited<ReturnType<typeof api.tasks.startPrCommand>>>();
    vi.mocked(api.tasks.startPrCommand).mockReturnValue(start.promise);
    renderControl();
    await flushUpdates();
    await openPicker();
    click(button('API serverRun'));
    root?.unmount();
    root = null;

    start.resolve({
      task: buildTask(),
      created: true,
      runCommandIds: ['command-2'],
      runResult: runningStatus,
    });
    await flushUpdates();

    expect(useBackgroundJobsStore.getState().jobs[0]).toMatchObject({
      status: 'succeeded',
      taskId: 'task-1',
    });
    expect(useOverlaysStore.getState().activeOverlay).toBeNull();
    expect(useTaskMessagesStore.getState().runCommandRunning['task-1']).toBeUndefined();
  });

  it('completes launch UI state under StrictMode effect replay', async () => {
    const start = deferred<Awaited<ReturnType<typeof api.tasks.startPrCommand>>>();
    vi.mocked(api.tasks.startPrCommand).mockReturnValue(start.promise);
    vi.mocked(api.runCommands.getStatus).mockResolvedValue(runningStatus);
    renderControl({}, { strictMode: true });
    await flushUpdates();
    await openPicker();
    click(button('API serverRun'));

    start.resolve({
      task: buildTask(),
      created: true,
      runCommandIds: ['command-2'],
      runResult: runningStatus,
    });
    await flushUpdates();

    expect(useOverlaysStore.getState().runningCommandTarget).toEqual({
      taskId: 'task-1',
      runCommandId: 'command-2',
    });
    expect(useTaskMessagesStore.getState().runCommandRunning['task-1']).toEqual(
      runningStatus,
    );
  });

  it('keeps launch valid when associated task cache updates during preparation', async () => {
    const start = deferred<Awaited<ReturnType<typeof api.tasks.startPrCommand>>>();
    vi.mocked(api.tasks.startPrCommand).mockReturnValue(start.promise);
    renderControl();
    await flushUpdates();
    await openPicker();
    click(button('API serverRun'));

    rerender({ associatedTask: buildTask() });
    start.resolve({
      task: buildTask(),
      created: true,
      runCommandIds: ['command-2'],
      runResult: runningStatus,
    });
    await flushUpdates();

    expect(useOverlaysStore.getState().runningCommandTarget).toEqual({
      taskId: 'task-1',
      runCommandId: 'command-2',
    });
  });

  it.each([
    ['closed PR', { status: 'completed' as const }],
    ['read-only PR', { readOnly: true }],
  ])('discards launch UI side effects after %s eligibility change', async (_, update) => {
    const start = deferred<Awaited<ReturnType<typeof api.tasks.startPrCommand>>>();
    vi.mocked(api.tasks.startPrCommand).mockReturnValue(start.promise);
    renderControl();
    await flushUpdates();
    await openPicker();
    click(button('API serverRun'));

    rerender(update);
    start.resolve({
      task: buildTask(),
      created: true,
      runCommandIds: ['command-2'],
      runResult: runningStatus,
    });
    await flushUpdates();

    expect(useBackgroundJobsStore.getState().jobs[0]?.status).toBe('succeeded');
    expect(useOverlaysStore.getState().activeOverlay).toBeNull();
    expect(useTaskMessagesStore.getState().runCommandRunning['task-1']).toBeUndefined();
  });

  it('opens logs from primary and stops a running group', async () => {
    renderControl({ associatedTask: buildTask() });
    await flushUpdates();
    flushSync(() => statusListener?.('task-1', runningStatus));
    click(button('View command logs'));
    expect(useOverlaysStore.getState().runningCommandTarget).toEqual({
      taskId: 'task-1',
      runCommandId: 'command-1',
    });
    useOverlaysStore.getState().closeAll();

    click(button('Choose project command'));
    await flushUpdates();
    click(button('Full stackGroupStop'));
    await flushUpdates();
    expect(api.runCommands.stopCommand).toHaveBeenCalledTimes(2);
  });

  it('toasts failures and reconciles replacement associated tasks', async () => {
    vi.mocked(api.runCommands.stopCommand).mockRejectedValue(new Error('stop failed'));
    renderControl({ associatedTask: buildTask() });
    await flushUpdates();
    flushSync(() => statusListener?.('task-1', runningStatus));
    click(button('Choose project command'));
    await flushUpdates();
    click(button('Web serverStop'));
    await flushUpdates();
    expect(useToastStore.getState().toasts[0]?.message).toBe('stop failed');

    rerender({ associatedTask: buildTask({ id: 'task-2', worktreePath: '/tmp/new' }) });
    await flushUpdates();
    expect(api.runCommands.getStatus).toHaveBeenCalledWith('task-2');

    rerender({ associatedTask: null });
    await flushUpdates();
    expect(document.body.textContent).toContain('Start project');
  });

  it('reconciles a changed worktree path for the same associated task', async () => {
    renderControl({ associatedTask: buildTask() });
    await flushUpdates();
    expect(api.runCommands.getStatus).toHaveBeenCalledTimes(1);

    rerender({
      associatedTask: buildTask({ worktreePath: '/tmp/restored-review-42' }),
    });
    await flushUpdates();

    expect(api.runCommands.getStatus).toHaveBeenCalledTimes(2);
    expect(api.runCommands.getStatus).toHaveBeenLastCalledWith('task-1');
  });

  it('keeps a newer status event when an older status fetch resolves', async () => {
    const statusRequest = deferred<RunStatus>();
    vi.mocked(api.runCommands.getStatus).mockReturnValue(statusRequest.promise);
    renderControl({ associatedTask: buildTask() });
    await flushUpdates();

    expect(
      vi.mocked(api.runCommands.onStatusChange).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(api.runCommands.getStatus).mock.invocationCallOrder[0]);
    flushSync(() => statusListener?.('task-1', runningStatus));
    statusRequest.resolve(stoppedStatus);
    await flushUpdates();

    expect(document.body.textContent).toContain('View logs');
  });

  it('marks failed preparation and shows an error toast', async () => {
    vi.mocked(api.tasks.startPrCommand).mockRejectedValue(new Error('prepare failed'));
    renderControl();
    await flushUpdates();
    await openPicker();
    click(button('API serverRun'));
    await flushUpdates();

    expect(useToastStore.getState().toasts[0]?.message).toBe('prepare failed');
    expect(useBackgroundJobsStore.getState().jobs[0]).toMatchObject({
      status: 'failed',
      errorMessage: 'prepare failed',
    });
    expect(document.body.textContent).toContain('Start project');
  });
});

describe('RunningCommandsOverlay target', () => {
  it('keeps fast-exit target logs selected after production removes stopped status', async () => {
    useTaskMessagesStore
      .getState()
      .appendRunCommandLogBatch(
        'task-1',
        'target-command',
        'stdout',
        'target finished\n',
        0,
      );
    useTaskMessagesStore.setState({
      runCommandRunning: {
        'task-2': {
          isRunning: true,
          commands: [
            {
              id: 'other-running',
              name: 'Other running',
              command: 'running',
              status: 'running',
            },
          ],
        },
      },
    });
    useOverlaysStore.getState().openRunningCommands({
      taskId: 'task-1',
      runCommandId: 'target-command',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(
            RootOverlay,
            null,
            createElement(
              RootKeyboardBindings,
              null,
              createElement(RunningCommandsOverlay, { onClose: vi.fn() }),
            ),
          ),
        ),
      );
    });
    await flushUpdates();

    expect(document.body.textContent).toContain('target-command');
    expect(document.body.textContent).toContain('target finished');
    expect(document.body.textContent).toContain('Other running');
    expect(document.body.textContent).toContain('stopped');
    expect(document.body.textContent).toContain('1 running');
    expect(document.body.textContent).not.toContain('2 running');
    expect(
      document.querySelector('[data-testid="running-commands-footer"]')
        ?.textContent,
    ).not.toContain('Stop');

    button('Close').dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Backspace',
        metaKey: true,
        bubbles: true,
      }),
    );
    await flushUpdates();
    expect(api.runCommands.stopCommand).not.toHaveBeenCalled();
  });

  it('exposes modal semantics, unnested controls, labels, and focus restoration', async () => {
    useTaskMessagesStore.setState({
      runCommandRunning: {
        'task-1': {
          isRunning: true,
          commands: [
            {
              id: 'command-1',
              name: 'Web server',
              command: 'pnpm web',
              status: 'running',
            },
          ],
        },
      },
    });
    const opener = document.createElement('button');
    opener.textContent = 'Open commands';
    document.body.appendChild(opener);
    opener.focus();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(
            RootOverlay,
            null,
            createElement(
              RootKeyboardBindings,
              null,
              createElement(RunningCommandsOverlay, { onClose: vi.fn() }),
            ),
          ),
        ),
      );
    });
    await flushUpdates();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const titleId = dialog?.getAttribute('aria-labelledby');
    expect(document.getElementById(titleId ?? '')?.textContent).toBe(
      'Running Commands',
    );
    expect(dialog?.querySelector('button button')).toBeNull();
    expect(button('Stop Web server')).toBeDefined();
    expect(dialog?.contains(document.activeElement)).toBe(true);

    root.unmount();
    root = null;
    await flushUpdates();
    expect(document.activeElement).toBe(opener);
  });

  it('disables and announces a row stop button while stopping', async () => {
    const stopRequest = deferred<void>();
    vi.mocked(api.runCommands.stopCommand).mockReturnValue(stopRequest.promise);
    useTaskMessagesStore.setState({
      runCommandRunning: {
        'task-1': {
          isRunning: true,
          commands: [
            {
              id: 'command-1',
              name: 'Web server',
              command: 'pnpm web',
              status: 'running',
            },
          ],
        },
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(
            RootOverlay,
            null,
            createElement(
              RootKeyboardBindings,
              null,
              createElement(RunningCommandsOverlay, { onClose: vi.fn() }),
            ),
          ),
        ),
      );
    });
    await flushUpdates();

    click(button('Stop Web server'));
    await flushUpdates();

    const stoppingButton = button('Stopping Web server');
    expect(stoppingButton.disabled).toBe(true);
    expect(stoppingButton.getAttribute('aria-busy')).toBe('true');
    expect(
      document.querySelector('[data-testid="running-commands-footer"]')
        ?.textContent,
    ).not.toContain('Stop');

    stopRequest.resolve();
    await flushUpdates();
  });
});
