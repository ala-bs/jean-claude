// @vitest-environment happy-dom

import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Task, TaskStep } from '@shared/types';

import { cache$, resetCache } from '@/cache/cache-store';
import { GlobalPromptFromBackModal } from '@/common/ui/global-prompt-from-back-modal';
import { handleCacheEvent } from '@/cache/cache-listener';
import { Modal } from '@/common/ui/modal';
import { ModalArbitrationProvider } from '@/common/context/modal-arbitration';
import { resetCacheResourceSubscriptionsForTests } from '@/cache/cache-subscriptions';
import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { useOverlaysStore } from '@/stores/overlays';
import { useTaskMessagesStore } from '@/stores/task-messages';
import { useToastStore } from '@/stores/toasts';

import { ClosedPrWorkspaceModal } from '.';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  listPendingPrWorkspaceDecisions: vi.fn(),
  resolveClosedPrWorkspace: vi.fn(),
}));
const cacheMocks = vi.hoisted(() => ({
  setSubscriptions: vi.fn(),
}));
const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  pathname: '/all',
}));
const promptMocks = vi.hoisted(() => ({
  handler: null as ((prompt: {
    id: string;
    title: string;
    message: string;
    inputType?: 'text' | 'password';
  }) => void) | null,
  respond: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: {
    cache: {
      setSubscriptions: cacheMocks.setSubscriptions,
    },
    globalPrompt: {
      onShow: vi.fn((handler) => {
        promptMocks.handler = handler;
        return vi.fn();
      }),
      respond: promptMocks.respond,
    },
    tasks: apiMocks,
  },
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => routerMocks.navigate,
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: routerMocks.pathname } }),
}));

type Decision = {
  projectId: string;
  pullRequestId: number;
  taskIds: string[];
};

const first: Decision = {
  projectId: 'project-1',
  pullRequestId: 41,
  taskIds: ['task-1'],
};
const second: Decision = {
  projectId: 'project-2',
  pullRequestId: 42,
  taskIds: ['task-2'],
};

function createPrTask(id: string, projectId: string, pullRequestId: number): Task {
  return {
    id,
    projectId,
    type: 'pr-review',
    name: `PR #${pullRequestId}`,
    prompt: 'Review pull request',
    status: 'waiting',
    worktreePath: `/repo/.worktrees/${id}`,
    startCommitHash: 'abc123',
    sourceBranch: 'main',
    branchName: `pr-${pullRequestId}`,
    prWorkspaceState: 'cleanup-pending',
    hasUnread: false,
    userCompleted: false,
    workItemIds: null,
    workItemUrls: null,
    pullRequestId: String(pullRequestId),
    pullRequestUrl: `https://example.com/pull/${pullRequestId}`,
    pendingMessage: null,
    todoItems: [],
    parentTaskId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function createStep(id: string, taskId: string): TaskStep {
  return {
    id,
    taskId,
    name: 'Review',
    type: 'agent',
    dependsOn: [],
    promptTemplate: 'Review PR',
    resolvedPrompt: 'Review PR',
    status: 'pending',
    sessionId: null,
    interactionMode: 'auto',
    modelPreference: null,
    thinkingEffort: null,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ClosedPrWorkspaceModal', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  async function renderModal(expectedStatus: 'error' | 'success' = 'success') {
    await act(async () => {
      root.render(
        <RootKeyboardBindings>
          <ModalArbitrationProvider>
            <QueryClientProvider client={queryClient}>
              <ClosedPrWorkspaceModal />
            </QueryClientProvider>
          </ModalArbitrationProvider>
        </RootKeyboardBindings>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(
          queryClient.getQueryState(['pr-workspace-decisions'])?.status,
        ).toBe(expectedStatus);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function flushUi() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }

  beforeEach(() => {
    resetCache();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    apiMocks.listPendingPrWorkspaceDecisions.mockReset();
    apiMocks.resolveClosedPrWorkspace.mockReset();
    apiMocks.resolveClosedPrWorkspace.mockImplementation(async (params) => ({
      action: params.action === 'delete' ? 'deleted' : 'kept',
      taskIds: [...first.taskIds],
    }));
    cacheMocks.setSubscriptions.mockReset().mockResolvedValue(undefined);
    promptMocks.handler = null;
    promptMocks.respond.mockReset();
    routerMocks.navigate.mockReset();
    routerMocks.pathname = '/all';
    resetCacheResourceSubscriptionsForTests();
    useToastStore.setState({ toasts: [] });
    useOverlaysStore.setState({ activeOverlay: null, runningCommandTarget: null });
    useTaskMessagesStore.setState({
      steps: {},
      pendingRequestsByTaskId: {},
      runCommandLogs: {},
      runCommandRunning: {},
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    document.body.innerHTML = '';
  });

  it('opens globally and deduplicates repeated entries for one PR', async () => {
    apiMocks.listPendingPrWorkspaceDecisions.mockResolvedValue([
      first,
      { ...first, taskIds: ['task-1', 'task-3'] },
    ]);

    await renderModal();

    expect(
      document
        .querySelector('[role="dialog"]')
        ?.getAttribute('aria-describedby'),
    ).toBe('closed-pr-workspace-description');
    expect(document.body.textContent).toContain('Pull request #41 is closed');
    expect(document.body.textContent).not.toContain('#42');
  });

  it('focuses the safe action first', async () => {
    apiMocks.listPendingPrWorkspaceDecisions.mockResolvedValue([first]);
    await renderModal();
    await flushUi();

    expect(document.activeElement?.getAttribute('data-action')).toBe('keep');
  });

  it('serializes multiple decisions in backend order', async () => {
    apiMocks.listPendingPrWorkspaceDecisions
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([second]);
    apiMocks.resolveClosedPrWorkspace.mockResolvedValue(undefined);
    await renderModal();

    expect(document.body.textContent).toContain('#41');
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[data-action="keep"]')?.click();
    });
    await flushUi();

    expect(document.body.textContent).toContain('#42');
    expect(apiMocks.resolveClosedPrWorkspace).toHaveBeenCalledWith({
      projectId: 'project-1',
      pullRequestId: 41,
      action: 'keep',
    });
  });

  it('restores unresolved decisions after remount', async () => {
    apiMocks.listPendingPrWorkspaceDecisions.mockResolvedValue([first]);
    await renderModal();
    await act(async () => root.unmount());

    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await renderModal();

    expect(apiMocks.listPendingPrWorkspaceDecisions).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('#41');
  });

  it.each([
    ['keep', 'keep'],
    ['delete', 'delete'],
  ] as const)('sends exact %s API params and waits for authoritative removal', async (buttonAction, action) => {
    const mutation = deferred<{
      action: 'deleted' | 'kept';
      taskIds: string[];
    }>();
    apiMocks.listPendingPrWorkspaceDecisions
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([]);
    apiMocks.resolveClosedPrWorkspace.mockReturnValue(mutation.promise);
    await renderModal();

    act(() => {
      document.querySelector<HTMLButtonElement>(`button[data-action="${buttonAction}"]`)?.click();
    });
    await flushUi();

    expect(apiMocks.resolveClosedPrWorkspace).toHaveBeenCalledWith({
      projectId: 'project-1',
      pullRequestId: 41,
      action,
    });
    expect(
      [...document.querySelectorAll<HTMLButtonElement>('button[data-action]')].every(
        (button) => button.disabled,
      ),
    ).toBe(true);
    expect(document.body.textContent).toContain('#41');

    await act(async () =>
      mutation.resolve({
        action: action === 'delete' ? 'deleted' : 'kept',
        taskIds: [...first.taskIds],
      }),
    );
    await flushUi();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps cached workspace and operational inputs after authoritative resolution', async () => {
    let pending = [first];
    const task = createPrTask('task-1', 'project-1', 41);
    const step = createStep('step-1', task.id);
    const worktreeStatus = {
      exists: true,
      branch: 'pr-41',
      hasChanges: true,
    };
    cache$.tasks[task.id].set(task);
    cache$.steps[step.id].set(step);
    queryClient.setQueryData(['worktree-status', task.id], worktreeStatus);
    apiMocks.listPendingPrWorkspaceDecisions.mockImplementation(async () => pending);
    apiMocks.resolveClosedPrWorkspace.mockImplementation(async (params) => {
      expect(params).toEqual({
        projectId: 'project-1',
        pullRequestId: 41,
        action: 'keep',
      });
      pending = [];
      handleCacheEvent(
        {
          type: 'task.upsert',
          task: {
            ...task,
            prWorkspaceState: 'kept',
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
        },
        queryClient,
      );
    });
    await renderModal();

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[data-action="keep"]')?.click();
    });
    await flushUi();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(cache$.tasks[task.id].prWorkspaceState.get()).toBe('kept');
    expect(cache$.tasks[task.id].status.get()).toBe(task.status);
    expect(cache$.tasks[task.id].worktreePath.get()).toBe(task.worktreePath);
    expect(cache$.tasks[task.id].startCommitHash.get()).toBe(
      task.startCommitHash,
    );
    expect(cache$.tasks[task.id].sourceBranch.get()).toBe(task.sourceBranch);
    expect(cache$.tasks[task.id].branchName.get()).toBe(task.branchName);
    expect(cache$.steps[step.id].get()).toEqual(step);
    expect(queryClient.getQueryData(['worktree-status', task.id])).toEqual(
      worktreeStatus,
    );
  });

  it('reconciles deleted current route and navigates to matching all PR detail', async () => {
    const task = createPrTask('task-1', 'project-1', 41);
    const step = createStep('step-1', task.id);
    cache$.tasks[task.id].set(task);
    cache$.steps[step.id].set(step);
    queryClient.setQueryData(['tasks', task.id], task);
    queryClient.setQueryData(['steps', step.id], step);
    queryClient.setQueryData(['steps', { taskId: task.id }], [step]);
    const messages = useTaskMessagesStore.getState();
    messages.loadStep(step.id, task.id, [], 'running');
    messages.setPendingRequestForTask(task.id, {
      type: 'question',
      question: { taskId: task.id, requestId: 'question-1', questions: [] },
    });
    messages.appendRunCommandLogBatch(task.id, 'command-1', 'stdout', 'run', 0);
    messages.setRunCommandRunning(task.id, { isRunning: true, commands: [] });
    useOverlaysStore.getState().openRunningCommands({
      taskId: task.id,
      runCommandId: 'command-1',
    });
    routerMocks.pathname = '/all/task-1';
    apiMocks.listPendingPrWorkspaceDecisions
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([]);
    apiMocks.resolveClosedPrWorkspace.mockResolvedValue({
      action: 'deleted',
      taskIds: [task.id],
    });
    await renderModal();

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[data-action="delete"]')?.click();
    });
    await flushUi();

    expect(apiMocks.resolveClosedPrWorkspace).toHaveBeenCalledWith({
      projectId: 'project-1',
      pullRequestId: 41,
      action: 'delete',
    });
    expect(cache$.tasks[task.id].get()).toBeUndefined();
    expect(cache$.steps[step.id].get()).toBeUndefined();
    expect(useTaskMessagesStore.getState().steps[step.id]).toBeUndefined();
    expect(
      useTaskMessagesStore.getState().pendingRequestsByTaskId[task.id],
    ).toBeUndefined();
    expect(useTaskMessagesStore.getState().runCommandLogs[task.id]).toBeUndefined();
    expect(useTaskMessagesStore.getState().runCommandRunning[task.id]).toBeUndefined();
    expect(useOverlaysStore.getState().runningCommandTarget).toBeNull();
    expect(queryClient.getQueryData(['tasks', task.id])).toBeUndefined();
    expect(queryClient.getQueryData(['steps', step.id])).toBeUndefined();
    expect(routerMocks.navigate).toHaveBeenCalledWith({
      to: '/all/prs/$projectId/$prId',
      params: { projectId: 'project-1', prId: '41' },
    });
  });

  it('navigates when authoritative deletion includes a kept current-route task', async () => {
    const pendingTask = createPrTask('task-a', 'project-1', 41);
    const keptTask = {
      ...createPrTask('task-b', 'project-1', 41),
      prWorkspaceState: 'kept' as const,
    };
    cache$.tasks[pendingTask.id].set(pendingTask);
    cache$.tasks[keptTask.id].set(keptTask);
    routerMocks.pathname = '/all/task-b';
    apiMocks.listPendingPrWorkspaceDecisions
      .mockResolvedValueOnce([{ ...first, taskIds: [pendingTask.id] }])
      .mockResolvedValueOnce([]);
    apiMocks.resolveClosedPrWorkspace.mockResolvedValue({
      action: 'deleted',
      taskIds: [pendingTask.id, keptTask.id],
    });
    await renderModal();

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[data-action="delete"]')?.click();
    });
    await flushUi();

    expect(cache$.tasks[pendingTask.id].get()).toBeUndefined();
    expect(cache$.tasks[keptTask.id].get()).toBeUndefined();
    expect(routerMocks.navigate).toHaveBeenCalledWith({
      to: '/all/prs/$projectId/$prId',
      params: { projectId: 'project-1', prId: '41' },
    });
  });

  it('keeps failed resolution open and allows retry', async () => {
    apiMocks.listPendingPrWorkspaceDecisions
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([]);
    apiMocks.resolveClosedPrWorkspace
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        action: 'deleted',
        taskIds: [...first.taskIds],
      });
    await renderModal();

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[data-action="delete"]')?.click();
    });
    await flushUi();
    expect(document.body.textContent).toContain('#41');
    expect(document.body.textContent).toContain('network down');
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ type: 'error' });
    expect(document.querySelector<HTMLButtonElement>('button[data-action="delete"]')?.disabled).toBe(false);

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[data-action="delete"]')?.click();
    });
    await flushUi();
    expect(apiMocks.resolveClosedPrWorkspace).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('removes stale prompt after a real reactivation cache event', async () => {
    let pending = [first];
    const task = createPrTask('task-1', 'project-1', 41);
    cache$.tasks[task.id].set(task);
    apiMocks.listPendingPrWorkspaceDecisions.mockImplementation(async () => pending);
    await renderModal();

    pending = [];
    handleCacheEvent(
      {
        type: 'task.upsert',
        task: { ...task, prWorkspaceState: 'active' },
      },
      queryClient,
    );
    await flushUi();

    expect(cache$.tasks[task.id].prWorkspaceState.get()).toBe('active');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('removes a deleted project decision through the real cache event path', async () => {
    let pending = [first];
    apiMocks.listPendingPrWorkspaceDecisions.mockImplementation(async () => pending);
    await renderModal();

    pending = [];
    handleCacheEvent(
      { type: 'project.delete', projectId: first.projectId },
      queryClient,
    );
    await flushUi();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('refetches after async subscriptions close the snapshot registration race', async () => {
    const registration = deferred<void>();
    let pending = [first];
    cacheMocks.setSubscriptions.mockReturnValueOnce(registration.promise);
    apiMocks.listPendingPrWorkspaceDecisions.mockImplementation(async () => pending);
    await renderModal();

    pending = [];
    await act(async () => registration.resolve());
    await vi.waitFor(() => {
      expect(apiMocks.listPendingPrWorkspaceDecisions).toHaveBeenCalledTimes(2);
    });
    await flushUi();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('does not refetch after unmount when async subscription registration finishes', async () => {
    const registration = deferred<void>();
    cacheMocks.setSubscriptions.mockReturnValueOnce(registration.promise);
    apiMocks.listPendingPrWorkspaceDecisions.mockResolvedValue([first]);
    await renderModal();
    expect(apiMocks.listPendingPrWorkspaceDecisions).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
    await act(async () => registration.resolve());
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(apiMocks.listPendingPrWorkspaceDecisions).toHaveBeenCalledOnce();
    root = createRoot(container);
  });

  it('shows an initial load error and retries authoritatively', async () => {
    apiMocks.listPendingPrWorkspaceDecisions
      .mockRejectedValueOnce(new Error('decision service unavailable'))
      .mockResolvedValue([first]);
    await renderModal('error');

    expect(document.body.textContent).toContain('Unable to load PR workspace decisions');
    expect(document.body.textContent).toContain('decision service unavailable');
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[data-action="retry"]')?.click();
    });
    await flushUi();

    expect(document.body.textContent).toContain('#41');
  });

  it('retains stale prompt on refetch error and blocks resolution until retry', async () => {
    const task = createPrTask('task-1', 'project-1', 41);
    cache$.tasks[task.id].set(task);
    apiMocks.listPendingPrWorkspaceDecisions
      .mockResolvedValueOnce([first])
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce([]);
    await renderModal();

    await act(async () => {
      handleCacheEvent(
        {
          type: 'task.upsert',
          task: { ...task, prWorkspaceState: 'active' },
        },
        queryClient,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain(
        'Decision status could not be refreshed',
      );
    });

    expect(document.body.textContent).toContain('#41');
    expect(document.querySelector<HTMLButtonElement>('button[data-action="keep"]')?.disabled).toBe(true);
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[data-action="retry"]')?.click();
    });
    await flushUi();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(apiMocks.resolveClosedPrWorkspace).not.toHaveBeenCalled();
  });

  it('waits behind higher-priority modals and owns focus and dismissal only when shown', async () => {
    apiMocks.listPendingPrWorkspaceDecisions.mockResolvedValue([first]);

    function Harness() {
      const [showOverlayModal, setShowOverlayModal] = useState(true);
      return (
        <>
          <ClosedPrWorkspaceModal />
          <GlobalPromptFromBackModal />
          <Modal
            isOpen={showOverlayModal}
            onClose={() => setShowOverlayModal(false)}
            ariaLabel="Overlay dialog"
          >
            Overlay content
          </Modal>
        </>
      );
    }

    await act(async () => {
      root.render(
        <RootKeyboardBindings>
          <ModalArbitrationProvider>
            <QueryClientProvider client={queryClient}>
              <Harness />
            </QueryClientProvider>
          </ModalArbitrationProvider>
        </RootKeyboardBindings>,
      );
    });
    await vi.waitFor(() => {
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect(document.body.textContent).toContain('Overlay content');
    });

    act(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await flushUi();
    expect(document.body.textContent).toContain('#41');
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);

    act(() => {
      promptMocks.handler?.({
        id: 'prompt-1',
        title: 'Credentials required',
        message: 'Enter token',
        inputType: 'password',
      });
    });
    await flushUi();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.body.textContent).toContain('Credentials required');
    expect(document.activeElement?.tagName).toBe('INPUT');

    act(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await flushUi();
    expect(promptMocks.respond).toHaveBeenCalledWith({
      id: 'prompt-1',
      accepted: false,
      inputValue: '',
    });
    expect(document.body.textContent).toContain('#41');

    const dialog = document.querySelector('[role="dialog"]');
    act(() => dialog?.parentElement?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await flushUi();
    expect(document.body.textContent).toContain('#41');
  });

  it('contains and restores focus for non-input global prompts', async () => {
    await act(async () => {
      root.render(
        <RootKeyboardBindings>
          <ModalArbitrationProvider>
            <button type="button" id="outside-focus">
              Outside
            </button>
            <GlobalPromptFromBackModal />
          </ModalArbitrationProvider>
        </RootKeyboardBindings>,
      );
    });
    const outside = document.querySelector<HTMLButtonElement>('#outside-focus');
    outside?.focus();

    act(() => {
      promptMocks.handler?.({
        id: 'prompt-2',
        title: 'Confirm operation',
        message: 'Continue?',
      });
    });
    await flushUi();

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const accept = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('Accept'),
    );
    expect(document.activeElement).toBe(accept);
    expect(dialog?.contains(document.activeElement)).toBe(true);

    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
    });
    await flushUi();
    expect(dialog?.contains(document.activeElement)).toBe(true);

    outside?.focus();
    await flushUi();
    expect(dialog?.contains(document.activeElement)).toBe(true);

    await act(async () => accept?.click());
    await flushUi();
    expect(promptMocks.respond).toHaveBeenCalledWith({
      id: 'prompt-2',
      accepted: true,
    });
    expect(document.activeElement).toBe(outside);
  });

  it('deletes cached task and steps before authoritative refetch advances queue', async () => {
    let pending = [first, second];
    const task = createPrTask('task-1', 'project-1', 41);
    const step = createStep('step-1', task.id);
    cache$.tasks[task.id].set(task);
    cache$.steps[step.id].set(step);
    apiMocks.listPendingPrWorkspaceDecisions.mockImplementation(async () => pending);
    apiMocks.resolveClosedPrWorkspace.mockImplementation(async (params) => {
      expect(params).toEqual({
        projectId: 'project-1',
        pullRequestId: 41,
        action: 'delete',
      });
      pending = [second];
      handleCacheEvent(
        {
          type: 'task.delete',
          taskId: task.id,
          projectId: task.projectId,
          stepIds: [step.id],
        },
        queryClient,
      );
    });
    await renderModal();

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[data-action="delete"]')?.click();
    });
    await flushUi();

    expect(cache$.tasks[task.id].get()).toBeUndefined();
    expect(cache$.steps[step.id].get()).toBeUndefined();
    expect(document.body.textContent).toContain('#42');
    expect(document.body.textContent).not.toContain('#41');
  });
});
