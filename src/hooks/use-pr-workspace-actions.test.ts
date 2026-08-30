// @vitest-environment happy-dom
/* eslint-disable sort-imports */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cache$, resetCache } from '@/cache/cache-store';
import { ingestStep, selectStep } from '@/cache/domains/steps';
import { ingestTask, selectTask } from '@/cache/domains/tasks';
import { handleCacheEvent } from '@/cache/cache-listener';
import { setDocumentResource } from '@/cache/cache-actions';
import { api } from '@/lib/api';
import { useOverlaysStore } from '@/stores/overlays';
import { useTaskMessagesStore } from '@/stores/task-messages';
import type { Task, TaskStep } from '@shared/types';
import type { FeedItem } from '@shared/feed-types';

import { usePrWorkspaceActions } from './use-pr-workspace-actions';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe('usePrWorkspaceActions', () => {
  let container: HTMLDivElement;
  let root: Root;
  let actions: ReturnType<typeof usePrWorkspaceActions>;
  let queryClient: QueryClient;

  beforeEach(() => {
    resetCache();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });

    function Harness() {
      actions = usePrWorkspaceActions();
      return null;
    }

    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness),
        ),
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
    useOverlaysStore.setState({ activeOverlay: null, runningCommandTarget: null });
    useTaskMessagesStore.setState({
      steps: {},
      runCommandLogs: {},
      runCommandRunning: {},
      pendingRequestsByTaskId: {},
    });
    vi.restoreAllMocks();
  });

  it('deletes current task with exact API params and clears task context', async () => {
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    ingestTask(createTask());
    ingestStep(createStep());
    setDocumentResource('feed:tasks', [createFeedItem()], 1);
    queryClient.setQueryData(['tasks', 'review-1'], createTask());
    queryClient.setQueryData(['steps', 'step-1'], createStep());
    queryClient.setQueryData(['steps', { taskId: 'review-1' }], [createStep()]);
    const messages = useTaskMessagesStore.getState();
    messages.loadStep('step-1', 'review-1', [], 'running');
    messages.setPermission('step-1', {
      taskId: 'review-1',
      requestId: 'permission-1',
      toolName: 'Bash',
      input: { command: 'pnpm test' },
    });
    messages.setQuestion('step-1', {
      taskId: 'review-1',
      requestId: 'question-1',
      questions: [],
    });
    messages.setPendingRequestForTask({
      taskId: 'review-1',
      stepId: 'step-1',
      request: {
        type: 'question',
        question: {
          taskId: 'review-1',
          requestId: 'question-1',
          questions: [],
        },
      },
    });
    expect(useTaskMessagesStore.getState().steps['step-1']).toMatchObject({
      pendingPermission: { requestId: 'permission-1' },
      pendingQuestion: { requestId: 'question-1' },
    });
    expect(
      useTaskMessagesStore.getState().pendingRequestsByTaskId['review-1'],
    ).toBeDefined();
    useOverlaysStore.getState().openRunningCommands({
      taskId: 'review-1',
      runCommandId: 'command-1',
    });
    useTaskMessagesStore.setState({
      runCommandLogs: {
        'review-1': {
          'command-1': {
            chunks: [],
            pendingLines: { stdout: null, stderr: null },
            trailingText: { stdout: '', stderr: '' },
            totalLineCount: 0,
            updatedAt: 1,
            version: 1,
          },
        },
      },
      runCommandRunning: {
        'review-1': { isRunning: true, commands: [] },
      },
    });
    const deleteCurrent = vi
      .spyOn(api.tasks, 'deletePrWorkspaceTask')
      .mockImplementation(async () => {
        handleCacheEvent(
          {
            type: 'task.delete',
            taskId: 'review-1',
            projectId: 'project-1',
            stepIds: ['step-1'],
          },
          queryClient,
        );
        return { action: 'deleted', taskIds: ['review-1'] };
      });

    await act(async () => {
      await actions.deleteCurrent.mutateAsync({ taskId: 'review-1' });
    });

    expect(deleteCurrent).toHaveBeenCalledWith({ taskId: 'review-1' });
    expect(selectTask('review-1')).toBeUndefined();
    expect(selectStep('step-1')).toBeUndefined();
    expect(useTaskMessagesStore.getState().steps['step-1']).toBeUndefined();
    expect(
      useTaskMessagesStore.getState().pendingRequestsByTaskId['review-1'],
    ).toBeUndefined();
    expect(useTaskMessagesStore.getState().runCommandLogs['review-1']).toBeUndefined();
    expect(useTaskMessagesStore.getState().runCommandRunning['review-1']).toBeUndefined();
    expect(queryClient.getQueryData(['tasks', 'review-1'])).toBeUndefined();
    expect(queryClient.getQueryData(['steps', 'step-1'])).toBeUndefined();
    expect(
      queryClient.getQueryData(['steps', { taskId: 'review-1' }]),
    ).toBeUndefined();
    expect(
      (cache$.documents['feed:tasks'].data.get() as FeedItem[] | undefined) ?? [],
    ).toEqual([]);
    expect(useOverlaysStore.getState()).toMatchObject({
      activeOverlay: null,
      runningCommandTarget: null,
    });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['tasks'] });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['feed', 'tasks'],
    });
  });

  it('deletes all matching PR workspaces without deleting linked agent tasks', async () => {
    ingestTask(createTask());
    ingestTask(createTask({ id: 'review-2' }));
    ingestTask(createTask({ id: 'agent-1', type: 'agent' }));
    ingestTask(createTask({ id: 'other-pr', pullRequestId: '43' }));
    const deleteAll = vi
      .spyOn(api.tasks, 'deleteAllPrWorkspaces')
      .mockResolvedValue({
        action: 'deleted',
        taskIds: ['review-1', 'review-2'],
      });

    await act(async () => {
      await actions.deleteAll.mutateAsync({
        projectId: 'project-1',
        pullRequestId: 42,
      });
    });

    expect(deleteAll).toHaveBeenCalledWith({
      projectId: 'project-1',
      pullRequestId: 42,
    });
    expect(selectTask('review-1')).toBeUndefined();
    expect(selectTask('review-2')).toBeUndefined();
    expect(selectTask('agent-1')).toBeDefined();
    expect(selectTask('other-pr')).toBeDefined();
  });
});

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'review-1',
    projectId: 'project-1',
    type: 'pr-review',
    name: 'PR #42',
    prompt: 'Review PR',
    status: 'waiting',
    worktreePath: '/repo/.worktrees/pr-42',
    startCommitHash: 'abc123',
    sourceBranch: 'main',
    branchName: 'review-42',
    prWorkspaceState: 'active',
    hasUnread: false,
    userCompleted: false,
    workItemIds: null,
    workItemUrls: null,
    pullRequestId: '42',
    pullRequestUrl: 'https://example.test/pr/42',
    pendingMessage: null,
    todoItems: [],
    parentTaskId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createFeedItem(): FeedItem {
  return {
    id: 'task:review-1',
    source: 'task',
    attention: 'waiting',
    timestamp: '2026-01-01T00:00:00.000Z',
    projectId: 'project-1',
    projectName: 'Jean-Claude',
    projectColor: '#123456',
    projectPriority: 'normal',
    title: 'PR #42',
    taskId: 'review-1',
  };
}

function createStep(): TaskStep {
  return {
    id: 'step-1',
    taskId: 'review-1',
    name: 'Review',
    type: 'agent',
    dependsOn: [],
    promptTemplate: 'Review',
    resolvedPrompt: 'Review',
    status: 'ready',
    sessionId: null,
    interactionMode: 'ask',
    modelPreference: null,
    thinkingEffort: null,
    agentBackend: 'claude-code',
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
