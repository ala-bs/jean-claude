import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

import type { Task, TaskStep } from '@shared/types';

import {
  deleteAllPrWorkspaces,
  deletePrWorkspaceTask,
  type PrWorkspaceDeletionDeps,
  routeTaskDeletion,
} from './pr-workspace-deletion-service';
import {
  sendMessageWithPrReviewLifecycle,
  startAgentWithPrReviewLifecycle,
  withPrLifecycleLock,
} from './pr-review-task-service';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    type: 'pr-review',
    name: 'Review PR',
    prompt: 'Review PR',
    status: 'running',
    worktreePath: '/repo/.worktrees/task-1',
    startCommitHash: 'abc',
    sourceBranch: 'main',
    branchName: 'review-1',
    prWorkspaceState: 'cleanup-pending',
    hasUnread: false,
    userCompleted: false,
    workItemIds: null,
    workItemUrls: null,
    pullRequestId: '12',
    pullRequestUrl: null,
    pendingMessage: null,
    todoItems: [],
    parentTaskId: null,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
    ...overrides,
  };
}

function makeStep(taskId: string, id = `${taskId}-step`): TaskStep {
  return {
    id,
    taskId,
    name: 'Step',
    type: 'agent',
    dependsOn: [],
    promptTemplate: 'Review',
    resolvedPrompt: null,
    status: 'running',
    sessionId: null,
    agentBackend: null,
    modelPreference: null,
    interactionMode: 'plan',
    thinkingEffort: null,
    output: null,
    images: null,
    meta: {},
    sessionRules: {},
    autoStart: false,
    sortOrder: 0,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
  };
}

function makeDeps(tasks = [makeTask()]): PrWorkspaceDeletionDeps {
  const current = new Map(tasks.map((task) => [task.id, task]));
  return {
    findTaskById: vi.fn(async (taskId: string) => current.get(taskId)),
    findPrReviewTasksByPullRequest: vi.fn(async ({ projectId, pullRequestId }) =>
      [...current.values()].filter(
        (task) =>
          task.type === 'pr-review' &&
          task.projectId === projectId &&
          task.pullRequestId === pullRequestId,
      ),
    ),
    findStepsByTaskIds: vi.fn(async (taskIds: string[]) =>
      Object.fromEntries(
        taskIds.map((taskId) => [taskId, [makeStep(taskId)]]),
      ),
    ),
    findProjectById: vi.fn(async () => ({ id: 'project-1', path: '/repo' })),
    stopCommandsForTask: vi.fn().mockResolvedValue(true),
    stopAgent: vi.fn(),
    closeEditorWindowsForTaskWorktree: vi.fn(),
    cleanupPrWorkspaceGit: vi.fn(async ({ task }) => ({
      task: makeTask({
        ...task,
        worktreePath: null,
        branchName: null,
        startCommitHash: null,
        sourceBranch: null,
      }),
      changed: true,
    })),
    deleteTasks: vi.fn(async (taskIds: string[]) => {
      taskIds.forEach((taskId) => current.delete(taskId));
    }),
    emitTaskUpsert: vi.fn(),
    emitTaskDelete: vi.fn(),
  };
}

describe('PR workspace deletion phase boundaries', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs every command stop and aborts before agents when one fails', async () => {
    const tasks = [makeTask(), makeTask({ id: 'task-2', branchName: 'review-2' })];
    const deps = makeDeps(tasks);
    vi.mocked(deps.stopCommandsForTask)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('command error'));

    await expect(
      deleteAllPrWorkspaces({ projectId: 'project-1', pullRequestId: 12 }, deps),
    ).rejects.toThrow('commands');

    expect(deps.stopCommandsForTask).toHaveBeenCalledTimes(2);
    expect(deps.stopAgent).not.toHaveBeenCalled();
    expect(deps.closeEditorWindowsForTaskWorktree).not.toHaveBeenCalled();
    expect(deps.deleteTasks).not.toHaveBeenCalled();
  });

  it('stops every running agent and aborts before editors when one fails', async () => {
    const tasks = [makeTask(), makeTask({ id: 'task-2', branchName: 'review-2' })];
    const deps = makeDeps(tasks);
    vi.mocked(deps.stopAgent)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('agent error'));

    await expect(
      deleteAllPrWorkspaces({ projectId: 'project-1', pullRequestId: 12 }, deps),
    ).rejects.toThrow('agents');

    expect(deps.stopAgent).toHaveBeenCalledTimes(2);
    expect(deps.closeEditorWindowsForTaskWorktree).not.toHaveBeenCalled();
    expect(deps.cleanupPrWorkspaceGit).not.toHaveBeenCalled();
    expect(deps.deleteTasks).not.toHaveBeenCalled();
  });

  it('completes all commands, agents, editors, and Git before bulk DB deletion', async () => {
    const tasks = [makeTask(), makeTask({ id: 'task-2', branchName: 'review-2' })];
    const deps = makeDeps(tasks);
    const order: string[] = [];
    vi.mocked(deps.stopCommandsForTask).mockImplementation(async (id) => {
      order.push(`command:${id}`);
      return true;
    });
    vi.mocked(deps.stopAgent).mockImplementation(async (id) => {
      order.push(`agent:${id}`);
    });
    vi.mocked(deps.closeEditorWindowsForTaskWorktree).mockImplementation(async (task) => {
      order.push(`editor:${task.id}`);
      return undefined;
    });
    vi.mocked(deps.cleanupPrWorkspaceGit).mockImplementation(async ({ task }) => {
      order.push(`git:${task.id}`);
      return { task, changed: false };
    });
    vi.mocked(deps.deleteTasks).mockImplementation(async () => {
      order.push('db');
    });

    await deleteAllPrWorkspaces({ projectId: 'project-1', pullRequestId: 12 }, deps);

    expect(order).toEqual([
      'command:task-1',
      'command:task-2',
      'agent:task-1-step',
      'agent:task-2-step',
      'editor:task-1',
      'editor:task-2',
      'git:task-1',
      'git:task-2',
      'db',
    ]);
    expect(deps.emitTaskDelete).toHaveBeenCalledWith({
      taskId: 'task-1',
      projectId: 'project-1',
      stepIds: ['task-1-step'],
    });
  });

  it('deletes current workspace in commands, agents, editors, Git, DB order', async () => {
    const deps = makeDeps();
    const order: string[] = [];
    vi.mocked(deps.stopCommandsForTask).mockImplementation(async () => {
      order.push('commands');
      return true;
    });
    vi.mocked(deps.stopAgent).mockImplementation(async () => {
      order.push('agents');
    });
    vi.mocked(deps.closeEditorWindowsForTaskWorktree).mockImplementation(
      async () => {
        order.push('editors');
        return undefined;
      },
    );
    vi.mocked(deps.cleanupPrWorkspaceGit).mockImplementation(async ({ task }) => {
      order.push('git');
      return { task, changed: false };
    });
    vi.mocked(deps.deleteTasks).mockImplementation(async () => {
      order.push('db');
    });

    await deletePrWorkspaceTask({ taskId: 'task-1' }, deps);

    expect(order).toEqual(['commands', 'agents', 'editors', 'git', 'db']);
  });

  it('keeps current workspace intact when command shutdown fails', async () => {
    const deps = makeDeps();
    vi.mocked(deps.stopCommandsForTask).mockResolvedValue(false);

    await expect(
      deletePrWorkspaceTask({ taskId: 'task-1' }, deps),
    ).rejects.toThrow('commands');

    expect(deps.stopAgent).not.toHaveBeenCalled();
    expect(deps.closeEditorWindowsForTaskWorktree).not.toHaveBeenCalled();
    expect(deps.cleanupPrWorkspaceGit).not.toHaveBeenCalled();
    expect(deps.deleteTasks).not.toHaveBeenCalled();
  });

  it('keeps all DB history after partial Git failure and emits only cleaned metadata', async () => {
    const tasks = [makeTask(), makeTask({ id: 'task-2', branchName: 'review-2' })];
    const deps = makeDeps(tasks);
    const cleaned = makeTask({
      worktreePath: null,
      branchName: null,
      startCommitHash: null,
      sourceBranch: null,
    });
    vi.mocked(deps.cleanupPrWorkspaceGit)
      .mockResolvedValueOnce({ task: cleaned, changed: true })
      .mockRejectedValueOnce(new Error('branch delete failed'));

    await expect(
      deleteAllPrWorkspaces({ projectId: 'project-1', pullRequestId: 12 }, deps),
    ).rejects.toThrow('branch delete failed');

    expect(deps.emitTaskUpsert).toHaveBeenCalledWith(cleaned);
    expect(deps.deleteTasks).not.toHaveBeenCalled();
    expect(deps.emitTaskDelete).not.toHaveBeenCalled();
  });

  it('continues Git cleanup and DB deletion when cleanup metadata emit fails', async () => {
    const tasks = [makeTask(), makeTask({ id: 'task-2', branchName: 'review-2' })];
    const deps = makeDeps(tasks);
    vi.mocked(deps.cleanupPrWorkspaceGit).mockImplementation(async ({ task }) => ({
      task: makeTask({ ...task, worktreePath: null, branchName: null }),
      changed: true,
    }));
    vi.mocked(deps.emitTaskUpsert).mockImplementationOnce(() => {
      throw new Error('window closed');
    });

    await expect(
      deleteAllPrWorkspaces({ projectId: 'project-1', pullRequestId: 12 }, deps),
    ).resolves.toEqual({
      action: 'deleted',
      taskIds: ['task-1', 'task-2'],
    });

    expect(deps.cleanupPrWorkspaceGit).toHaveBeenCalledTimes(2);
    expect(deps.emitTaskUpsert).toHaveBeenCalledTimes(2);
    expect(deps.deleteTasks).toHaveBeenCalledWith(['task-1', 'task-2']);
    expect(deps.emitTaskDelete).toHaveBeenCalledTimes(2);
  });
});

describe('PR workspace deletion selection and lifecycle', () => {
  it('deletes current task only, leaves other tasks untouched, and is idempotent', async () => {
    const current = makeTask();
    const sibling = makeTask({ id: 'task-2', branchName: 'review-2' });
    const linkedAgent = makeTask({
      id: 'agent-1',
      type: 'agent',
      prWorkspaceState: null,
    });
    const deps = makeDeps([current, sibling, linkedAgent]);

    await deletePrWorkspaceTask({ taskId: current.id }, deps);
    await deletePrWorkspaceTask({ taskId: current.id }, deps);

    expect(deps.stopCommandsForTask).toHaveBeenCalledTimes(1);
    expect(deps.stopCommandsForTask).toHaveBeenCalledWith(current.id);
    expect(deps.deleteTasks).toHaveBeenCalledTimes(1);
    expect(deps.deleteTasks).toHaveBeenCalledWith([current.id]);
  });

  it('delete-all selects every PR workspace task for pair and is idempotent', async () => {
    const tasks = [
      makeTask({ id: 'pending', prWorkspaceState: 'cleanup-pending' }),
      makeTask({ id: 'kept', prWorkspaceState: 'kept', branchName: 'review-2' }),
      makeTask({ id: 'active', prWorkspaceState: 'active', branchName: 'review-3' }),
      makeTask({ id: 'agent', type: 'agent', prWorkspaceState: null }),
    ];
    const deps = makeDeps(tasks);

    await expect(
      deleteAllPrWorkspaces({ projectId: 'project-1', pullRequestId: 12 }, deps),
    ).resolves.toEqual({
      action: 'deleted',
      taskIds: ['pending', 'kept', 'active'],
    });
    await expect(
      deleteAllPrWorkspaces({ projectId: 'project-1', pullRequestId: 12 }, deps),
    ).resolves.toEqual({ action: 'deleted', taskIds: [] });

    expect(deps.deleteTasks).toHaveBeenCalledTimes(1);
    expect(deps.deleteTasks).toHaveBeenCalledWith(['pending', 'kept', 'active']);
  });

  it('delete-all leaves a normal linked agent task with the same PR untouched', async () => {
    const workspace = makeTask();
    const linkedAgent = makeTask({
      id: 'agent-1',
      type: 'agent',
      prWorkspaceState: null,
    });
    const deps = makeDeps([workspace, linkedAgent]);

    await deleteAllPrWorkspaces(
      { projectId: 'project-1', pullRequestId: 12 },
      deps,
    );

    expect(deps.stopCommandsForTask).toHaveBeenCalledWith(workspace.id);
    expect(deps.stopCommandsForTask).not.toHaveBeenCalledWith(linkedAgent.id);
    expect(deps.deleteTasks).toHaveBeenCalledWith([workspace.id]);
  });

  it('serializes deletion against existing PR lifecycle operations', async () => {
    const deps = makeDeps();
    const order: string[] = [];
    let release!: () => void;
    const blocked = withPrLifecycleLock('project-1', 12, async () => {
      order.push('first:start');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push('first:end');
    });
    const deletion = deleteAllPrWorkspaces(
      { projectId: 'project-1', pullRequestId: 12 },
      deps,
    ).then(() => order.push('delete'));

    await vi.waitFor(() => expect(order).toEqual(['first:start']));
    expect(deps.findPrReviewTasksByPullRequest).not.toHaveBeenCalled();
    release();
    await Promise.all([blocked, deletion]);

    expect(order).toEqual(['first:start', 'first:end', 'delete']);
  });

  it('waits for pending PR agent start and then stops it before Git cleanup', async () => {
    const deps = makeDeps();
    let releaseStart!: () => void;
    let releaseStop!: () => void;
    const startBoundary = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let markStartEntered!: () => void;
    const startEntered = new Promise<void>((resolve) => {
      markStartEntered = resolve;
    });
    const stopBoundary = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const step = makeStep('task-1');
    const start = startAgentWithPrReviewLifecycle(
      step.id,
      async () => {
        markStartEntered();
        await startBoundary;
      },
      {
        findStepById: vi.fn().mockResolvedValue(step),
        findTaskById: vi
          .fn()
          .mockResolvedValue(makeTask({ prWorkspaceState: 'active' })),
      },
    );
    await startEntered;
    vi.mocked(deps.stopAgent).mockImplementation(() => stopBoundary);
    const deletion = deleteAllPrWorkspaces(
      { projectId: 'project-1', pullRequestId: 12 },
      deps,
    );

    await Promise.resolve();
    expect(deps.findPrReviewTasksByPullRequest).not.toHaveBeenCalled();
    releaseStart();
    await start;
    await vi.waitFor(() => expect(deps.stopAgent).toHaveBeenCalledWith(step.id));
    expect(deps.cleanupPrWorkspaceGit).not.toHaveBeenCalled();
    releaseStop();
    await deletion;

    expect(deps.cleanupPrWorkspaceGit).toHaveBeenCalledOnce();
  });

  it('waits for follow-up session registration then stops it before cleanup', async () => {
    const deps = makeDeps();
    const step = makeStep('task-1');
    let releaseRegistration!: () => void;
    const registrationGate = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    let markFollowUpEntered!: () => void;
    const followUpEntered = new Promise<void>((resolve) => {
      markFollowUpEntered = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let finishFollowUp!: () => void;
    const completion = new Promise<void>((resolve) => {
      finishFollowUp = resolve;
    });
    let runRegistered = false;
    vi.mocked(deps.stopAgent).mockImplementation(() => completion);
    const followUp = sendMessageWithPrReviewLifecycle(
      step.id,
      async () => {
        markFollowUpEntered();
        await registrationGate;
        runRegistered = true;
        markStarted();
        return { started, completion };
      },
      {
        findStepById: vi.fn().mockResolvedValue(step),
        findTaskById: vi
          .fn()
          .mockResolvedValue(makeTask({ prWorkspaceState: 'active' })),
      },
    );
    await followUpEntered;
    const deletion = deleteAllPrWorkspaces(
      { projectId: 'project-1', pullRequestId: 12 },
      deps,
    );

    await Promise.resolve();
    expect(deps.findPrReviewTasksByPullRequest).not.toHaveBeenCalled();
    releaseRegistration();
    await vi.waitFor(() => expect(deps.stopAgent).toHaveBeenCalledWith(step.id));
    expect(runRegistered).toBe(true);
    expect(deps.cleanupPrWorkspaceGit).not.toHaveBeenCalled();
    finishFollowUp();
    await Promise.all([followUp, deletion]);

    expect(deps.cleanupPrWorkspaceGit).toHaveBeenCalledOnce();
  });

  it('cascades real task deletion through steps and message tables', async () => {
    const client = new DatabaseSync(':memory:');
    client.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE tasks (id TEXT PRIMARY KEY);
      CREATE TABLE task_steps (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE TABLE raw_messages (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE TABLE agent_messages (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE
      );
      INSERT INTO tasks VALUES ('task-1');
      INSERT INTO task_steps VALUES ('step-1', 'task-1');
      INSERT INTO raw_messages VALUES ('raw-1', 'task-1');
      INSERT INTO agent_messages VALUES ('message-1', 'task-1');
    `);
    const deps = makeDeps();
    vi.mocked(deps.deleteTasks).mockImplementation(async () => {
      client.prepare("DELETE FROM tasks WHERE id = 'task-1'").run();
    });

    await deleteAllPrWorkspaces(
      { projectId: 'project-1', pullRequestId: 12 },
      deps,
    );

    expect(client.prepare('SELECT * FROM tasks').all()).toHaveLength(0);
    expect(client.prepare('SELECT * FROM task_steps').all()).toHaveLength(0);
    expect(client.prepare('SELECT * FROM raw_messages').all()).toHaveLength(0);
    expect(client.prepare('SELECT * FROM agent_messages').all()).toHaveLength(0);
    client.close();
  });

  it('continues all delete events when one emitter fails after commit', async () => {
    const tasks = [makeTask(), makeTask({ id: 'task-2' })];
    const deps = makeDeps(tasks);
    vi.mocked(deps.emitTaskDelete)
      .mockImplementationOnce(() => {
        throw new Error('window closed');
      })
      .mockImplementationOnce(() => undefined);

    await expect(
      deleteAllPrWorkspaces(
        { projectId: 'project-1', pullRequestId: 12 },
        deps,
      ),
    ).resolves.toEqual({
      action: 'deleted',
      taskIds: ['task-1', 'task-2'],
    });

    expect(deps.deleteTasks).toHaveBeenCalledOnce();
    expect(deps.emitTaskDelete).toHaveBeenCalledTimes(2);
  });
});

describe('generic task deletion routing', () => {
  it('routes PR workspaces through centralized deletion', async () => {
    const deletePr = vi.fn();
    const deleteGeneric = vi.fn();
    await routeTaskDeletion(
      { taskId: 'task-1' },
      {
        findTaskById: vi.fn().mockResolvedValue(makeTask()),
        deletePrWorkspaceTask: deletePr,
        deleteGenericTask: deleteGeneric,
      },
    );
    expect(deletePr).toHaveBeenCalledWith({ taskId: 'task-1' });
    expect(deleteGeneric).not.toHaveBeenCalled();
  });

  it('keeps normal task deletion on existing path', async () => {
    const task = makeTask({ type: 'agent', prWorkspaceState: null });
    const deletePr = vi.fn();
    const deleteGeneric = vi.fn();
    await routeTaskDeletion(
      { taskId: task.id },
      {
        findTaskById: vi.fn().mockResolvedValue(task),
        deletePrWorkspaceTask: deletePr,
        deleteGenericTask: deleteGeneric,
      },
    );
    expect(deleteGeneric).toHaveBeenCalledWith(task);
    expect(deletePr).not.toHaveBeenCalled();
  });
});
