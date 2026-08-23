import { describe, expect, it, vi } from 'vitest';

import type { Project, Task } from '@shared/types';
import type {
  ProjectCommand,
  ProjectCommandGroup,
} from '@shared/run-command-types';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(
    (
      _file: string,
      _args: string[],
      _options: Record<string, unknown>,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => callback(null, '', ''),
  ),
}));

vi.mock('child_process', () => ({
  execFile: mocks.execFile,
}));

import { agentService } from './agent-service';
import {
  cleanPrReviewWorkspace,
  createOrGetPrReviewTask,
  fetchPrReviewSourceBranch,
  reconcilePrWorkspaceState,
  runCommandWithPrReviewLifecycle,
  runTaskDestructiveWithPrReviewLifecycle,
  sendMessageWithPrReviewLifecycle,
  startAgentWithPrReviewLifecycle,
  startPrCommand,
} from './pr-review-task-service';
import { StepService } from './step-service';
import { completeTaskWithWorktreeCleanup } from './task-worktree-cleanup-service';

vi.mock('./step-service', () => ({
  StepService: {
    create: vi.fn(),
  },
}));

vi.mock('./agent-service', () => ({
  agentService: {
    start: vi.fn(),
  },
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    type: 'pr-review',
    name: 'Review: Fix bug',
    prompt: 'Review PR #12: Fix bug',
    status: 'waiting',
    worktreePath: '/repo/.worktrees/review-pr-12',
    startCommitHash: 'abc123',
    sourceBranch: 'feature/fix-bug',
    branchName: 'review-pr-12',
    prWorkspaceState: 'active',
    hasUnread: false,
    userCompleted: false,
    workItemIds: null,
    workItemUrls: null,
    pullRequestId: '12',
    pullRequestUrl: 'https://example.test/pr/12',
    pendingMessage: null,
    todoItems: [],
    parentTaskId: null,
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Jean-Claude',
    path: '/repo',
    color: '#000000',
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    archivedAt: null,
    repoProviderId: 'provider-1',
    repoProjectId: 'repo-project-1',
    repoId: 'repo-1',
    ...overrides,
  } as Project;
}

function makeDeps(overrides: Partial<Parameters<typeof createOrGetPrReviewTask>[1]> = {}) {
  return {
    findActivePrReviewTask: vi.fn().mockResolvedValue(undefined),
    findProjectById: vi.fn().mockResolvedValue(makeProject()),
    getPullRequest: vi.fn().mockResolvedValue({
      pullRequestId: 12,
      title: 'Fix bug',
      sourceRefName: 'refs/heads/feature/fix-bug',
      url: 'https://example.test/pr/12',
      status: 'active',
    }),
    fetchSourceBranch: vi.fn().mockResolvedValue(undefined),
    resolveMergeBase: vi.fn().mockResolvedValue(null),
    createWorktree: vi.fn().mockResolvedValue({
      worktreePath: '/repo/.worktrees/review-pr-12',
      startCommitHash: 'abc123',
      branchName: 'review-pr-12',
    }),
    cleanupWorktree: vi.fn(),
    getPullRequestWorkItems: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(async (data) => makeTask(data)),
    updateTask: vi.fn(async (id, data) => makeTask({ id, ...data })),
    setPrWorkspaceState: vi.fn(async (id) =>
      makeTask({ id, prWorkspaceState: 'active' }),
    ),
    emitTaskUpsert: vi.fn(),
    ...overrides,
  };
}

function makeCommand(
  overrides: Partial<ProjectCommand> = {},
): ProjectCommand {
  return {
    id: 'web',
    projectId: 'project-1',
    name: 'Web',
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
    createdAt: '2026-07-05T00:00:00.000Z',
    ...overrides,
  };
}

function makeGroup(
  overrides: Partial<ProjectCommandGroup> = {},
): ProjectCommandGroup {
  return {
    id: 'full-stack',
    projectId: 'project-1',
    name: 'Full stack',
    commandIds: ['web', 'api', 'web'],
    sortOrder: 0,
    createdAt: '2026-07-05T00:00:00.000Z',
    ...overrides,
  };
}

function makeStartDeps(overrides: Record<string, unknown> = {}) {
  const creationDeps = makeDeps();
  return {
    ...creationDeps,
    findCommandById: vi.fn(async (id: string) =>
      id === 'missing' ? undefined : makeCommand({ id }),
    ),
    findCommandGroupById: vi.fn().mockResolvedValue(makeGroup()),
    resetLogs: vi.fn(),
    startCommand: vi.fn().mockResolvedValue({ isRunning: true, commands: [] }),
    startGroup: vi.fn().mockResolvedValue({ isRunning: true, commands: [] }),
    ...overrides,
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

describe('createOrGetPrReviewTask', () => {
  it('anchors the review diff on the PR target branch', async () => {
    const deps = makeDeps({
      getPullRequest: vi.fn().mockResolvedValue({
        pullRequestId: 12,
        title: 'Fix bug',
        sourceRefName: 'refs/heads/feature/fix-bug',
        targetRefName: 'refs/heads/main',
        url: 'https://example.test/pr/12',
        status: 'active',
      }),
      resolveMergeBase: vi.fn().mockResolvedValue('base999'),
    });

    await createOrGetPrReviewTask(
      { projectId: 'project-1', pullRequestId: 12 },
      deps,
    );

    expect(deps.fetchSourceBranch).toHaveBeenCalledWith({
      projectPath: '/repo',
      sourceBranch: 'main',
    });
    expect(deps.createWorktree).toHaveBeenCalledWith(
      '/repo',
      'project-1',
      'Jean-Claude',
      'Review PR #12',
      'Review: Fix bug',
      'origin/feature/fix-bug',
    );
    expect(deps.resolveMergeBase).toHaveBeenCalledWith({
      worktreePath: '/repo/.worktrees/review-pr-12',
      sourceBranch: 'origin/main',
    });
    expect(deps.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceBranch: 'origin/main',
        startCommitHash: 'base999',
      }),
    );
  });

  it('links the PR work items onto the created task', async () => {
    const deps = makeDeps({
      getPullRequestWorkItems: vi.fn().mockResolvedValue([
        { id: 101, url: 'https://example.test/wi/101' },
        { id: '102', url: null },
      ]),
    });

    await createOrGetPrReviewTask(
      { projectId: 'project-1', pullRequestId: 12 },
      deps,
    );

    expect(deps.getPullRequestWorkItems).toHaveBeenCalledWith({
      providerId: 'provider-1',
      projectId: 'repo-project-1',
      repoId: 'repo-1',
      pullRequestId: 12,
    });
    expect(deps.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemIds: ['101', '102'],
        // Positionally aligned with ids, so consumers can zip by index.
        workItemUrls: ['https://example.test/wi/101', ''],
      }),
    );
  });

  it('creates the workspace unlinked when fetching PR work items fails', async () => {
    const deps = makeDeps({
      getPullRequestWorkItems: vi
        .fn()
        .mockRejectedValue(new Error('azure exploded')),
    });

    await createOrGetPrReviewTask(
      { projectId: 'project-1', pullRequestId: 12 },
      deps,
    );

    expect(deps.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ workItemIds: null, workItemUrls: null }),
    );
  });

  it('leaves work items untouched when reusing an existing workspace', async () => {
    const existing = makeTask({
      id: 'task-existing',
      worktreePath: '/repo/.worktrees/review-pr-12',
      prWorkspaceState: 'active',
      workItemIds: null,
    });
    const deps = makeDeps({
      findActivePrReviewTask: vi.fn().mockResolvedValue(existing),
    });

    await createOrGetPrReviewTask(
      { projectId: 'project-1', pullRequestId: 12 },
      deps,
    );

    expect(deps.getPullRequestWorkItems).not.toHaveBeenCalled();
    expect(deps.updateTask).not.toHaveBeenCalled();
  });

  it('falls back to the project default branch when the PR has no target branch', async () => {
    const deps = makeDeps({
      findProjectById: vi
        .fn()
        .mockResolvedValue(makeProject({ defaultBranch: 'develop' })),
      resolveMergeBase: vi.fn().mockResolvedValue('base111'),
    });

    await createOrGetPrReviewTask(
      { projectId: 'project-1', pullRequestId: 12 },
      deps,
    );

    expect(deps.resolveMergeBase).toHaveBeenCalledWith({
      worktreePath: '/repo/.worktrees/review-pr-12',
      sourceBranch: 'origin/develop',
    });
    expect(deps.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceBranch: 'origin/develop',
        startCommitHash: 'base111',
      }),
    );
  });

  it('never anchors the diff on the source branch when no base branch is known', async () => {
    const deps = makeDeps();

    await createOrGetPrReviewTask(
      { projectId: 'project-1', pullRequestId: 12 },
      deps,
    );

    expect(deps.fetchSourceBranch).toHaveBeenCalledTimes(1);
    expect(deps.resolveMergeBase).not.toHaveBeenCalled();
    expect(deps.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceBranch: null,
        startCommitHash: 'abc123',
      }),
    );
  });

  it.each([
    ['returns no merge-base', vi.fn().mockResolvedValue(null)],
    ['throws', vi.fn().mockRejectedValue(new Error('git exploded'))],
  ])(
    'keeps the worktree start commit when merge-base %s',
    async (_label, resolveMergeBase) => {
      const deps = makeDeps({
        getPullRequest: vi.fn().mockResolvedValue({
          pullRequestId: 12,
          title: 'Fix bug',
          sourceRefName: 'refs/heads/feature/fix-bug',
          targetRefName: 'refs/heads/main',
          url: null,
          status: 'active',
        }),
        resolveMergeBase,
      });

      await createOrGetPrReviewTask(
        { projectId: 'project-1', pullRequestId: 12 },
        deps,
      );

      expect(deps.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceBranch: 'origin/main',
          startCommitHash: 'abc123',
        }),
      );
    },
  );

  it('ignores a non-branch target ref instead of building a nonsense base', async () => {
    const deps = makeDeps({
      getPullRequest: vi.fn().mockResolvedValue({
        pullRequestId: 12,
        title: 'Fix bug',
        sourceRefName: 'refs/heads/feature/fix-bug',
        targetRefName: 'refs/pull/12/merge',
        url: null,
        status: 'active',
      }),
    });

    await createOrGetPrReviewTask(
      { projectId: 'project-1', pullRequestId: 12 },
      deps,
    );

    expect(deps.resolveMergeBase).not.toHaveBeenCalled();
    expect(deps.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ sourceBranch: null }),
    );
  });

  it('returns an existing active pr-review task without creating a worktree', async () => {
    const existingTask = makeTask({ id: 'existing-task' });
    const deps = makeDeps({
      findActivePrReviewTask: vi.fn().mockResolvedValue(existingTask),
    });

    await expect(
      createOrGetPrReviewTask(
        { projectId: 'project-1', pullRequestId: 12 },
        deps,
      ),
    ).resolves.toEqual({ task: existingTask, created: false });

    expect(deps.findActivePrReviewTask).toHaveBeenCalledWith({
      projectId: 'project-1',
      pullRequestId: '12',
    });
    expect(deps.findProjectById).toHaveBeenCalledWith('project-1');
    expect(deps.getPullRequest).toHaveBeenCalledTimes(1);
    expect(deps.fetchSourceBranch).not.toHaveBeenCalled();
    expect(deps.createWorktree).not.toHaveBeenCalled();
    expect(deps.createTask).not.toHaveBeenCalled();
    expect(deps.updateTask).not.toHaveBeenCalled();
  });

  it.each([
    ['cleanup-pending', 'completed', true, 'waiting'],
    ['kept', 'completed', true, 'waiting'],
    ['cleanup-pending', 'running', false, 'running'],
    ['kept', 'waiting', false, 'waiting'],
  ] as const)(
    'reactivates an existing %s %s workspace as %s',
    async (prWorkspaceState, status, userCompleted, expectedStatus) => {
      const existingTask = makeTask({
        id: 'existing-task',
        prWorkspaceState,
        status,
        userCompleted,
      });
      const activeTask = makeTask({
        ...existingTask,
        id: 'existing-task',
        prWorkspaceState: 'active',
        status: expectedStatus,
        userCompleted: false,
      });
      const deps = makeDeps({
        findActivePrReviewTask: vi.fn().mockResolvedValue(existingTask),
        setPrWorkspaceState: vi.fn().mockResolvedValue(activeTask),
      });

      await expect(
        createOrGetPrReviewTask(
          { projectId: 'project-1', pullRequestId: 12 },
          deps,
        ),
      ).resolves.toEqual({ task: activeTask, created: false });
      expect(deps.setPrWorkspaceState).toHaveBeenCalledWith(
        existingTask.id,
        'active',
      );
      expect(deps.updateTask).not.toHaveBeenCalled();
      expect(deps.createWorktree).not.toHaveBeenCalled();
    },
  );

  it('recreates a worktree for an existing pr-review task after cleanup', async () => {
    const existingTask = makeTask({
      id: 'existing-task',
      worktreePath: null,
      startCommitHash: null,
      branchName: null,
      sourceBranch: null,
    });
    const deps = makeDeps({
      findActivePrReviewTask: vi.fn().mockResolvedValue(existingTask),
      updateTask: vi.fn(async (id, data) =>
        makeTask({ ...existingTask, id, ...data }),
      ),
    });

    const result = await createOrGetPrReviewTask(
      { projectId: 'project-1', pullRequestId: 12 },
      deps,
    );

    expect(result.created).toBe(false);
    expect(result.task).toMatchObject({
      id: 'existing-task',
      userCompleted: false,
      worktreePath: '/repo/.worktrees/review-pr-12',
      startCommitHash: 'abc123',
      branchName: 'review-pr-12',
      sourceBranch: null,
      pullRequestUrl: 'https://example.test/pr/12',
    });
    expect(result.task).not.toHaveProperty('sessionRules');
    expect(deps.createWorktree).toHaveBeenCalledWith(
      '/repo',
      'project-1',
      'Jean-Claude',
      'Review PR #12',
      'Review: Fix bug',
      'origin/feature/fix-bug',
    );
    expect(deps.updateTask).toHaveBeenCalledWith(
      'existing-task',
      expect.objectContaining({
        worktreePath: '/repo/.worktrees/review-pr-12',
        startCommitHash: 'abc123',
        branchName: 'review-pr-12',
        sourceBranch: null,
        prWorkspaceState: 'active',
        prWorkspacePendingAt: null,
      }),
    );
    expect(deps.createTask).not.toHaveBeenCalled();
  });

  it('creates a fresh task when a completed review task was fully cleaned', async () => {
    const existingTask = makeTask({
      id: 'existing-task',
      status: 'completed',
      userCompleted: true,
      worktreePath: null,
      startCommitHash: null,
      branchName: null,
      sourceBranch: null,
    });
    const deps = makeDeps({
      findActivePrReviewTask: vi.fn().mockResolvedValue(existingTask),
    });

    await expect(
      createOrGetPrReviewTask(
        { projectId: 'project-1', pullRequestId: 12 },
        deps,
      ),
    ).resolves.toMatchObject({ created: true });

    expect(deps.createWorktree).toHaveBeenCalled();
    expect(deps.createTask).toHaveBeenCalled();
    expect(deps.updateTask).not.toHaveBeenCalled();
  });

  it('does not mutate a completed review task that still has workspace metadata', async () => {
    const existingTask = makeTask({ status: 'completed', userCompleted: true });
    const deps = makeDeps({
      findActivePrReviewTask: vi.fn().mockResolvedValue(existingTask),
    });

    await expect(
      createOrGetPrReviewTask(
        { projectId: 'project-1', pullRequestId: 12 },
        deps,
      ),
    ).rejects.toThrow('completed');
    expect(deps.updateTask).not.toHaveBeenCalled();
    expect(deps.createTask).not.toHaveBeenCalled();
  });

  it('creates a pr-review task without task-level rules or default steps', async () => {
    const deps = makeDeps();

    const result = await createOrGetPrReviewTask(
      { projectId: 'project-1', pullRequestId: 12 },
      deps,
    );

    expect(result.created).toBe(true);
    expect(result.task).toMatchObject({
      type: 'pr-review',
      prWorkspaceState: 'active',
      prompt: 'Review PR #12: Fix bug',
      name: 'Review: Fix bug',
      worktreePath: '/repo/.worktrees/review-pr-12',
      startCommitHash: 'abc123',
      branchName: 'review-pr-12',
      sourceBranch: null,
      pullRequestId: '12',
      pullRequestUrl: 'https://example.test/pr/12',
    });
    expect(result.task).not.toHaveProperty('sessionRules');
    expect(deps.createWorktree).toHaveBeenCalledWith(
      '/repo',
      'project-1',
      'Jean-Claude',
      'Review PR #12',
      'Review: Fix bug',
      'origin/feature/fix-bug',
    );
    expect(deps.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pr-review',
        prWorkspaceState: 'active',
      }),
    );
    expect(vi.mocked(deps.createTask).mock.calls[0][0]).not.toHaveProperty(
      'sessionRules',
    );
    expect(StepService.create).not.toHaveBeenCalled();
    expect(agentService.start).not.toHaveBeenCalled();
  });

  it('cleans an exact restored worktree when task update fails and retry succeeds', async () => {
    const existingTask = makeTask({
      worktreePath: null,
      startCommitHash: null,
      branchName: null,
      sourceBranch: null,
    });
    const order: string[] = [];
    const deps = makeDeps({
      findActivePrReviewTask: vi.fn().mockResolvedValue(existingTask),
      createWorktree: vi.fn(async () => {
        order.push('worktree');
        return {
          worktreePath: '/repo/.worktrees/review-pr-12',
          startCommitHash: 'abc123',
          branchName: 'review-pr-12',
        };
      }),
      updateTask: vi
        .fn()
        .mockImplementationOnce(async () => {
          order.push('persist-fail');
          throw new Error('update failed');
        })
        .mockImplementationOnce(async (id, data) => {
          order.push('persist-success');
          return makeTask({ id, ...data });
        }),
      cleanupWorktree: vi.fn(async () => {
        order.push('cleanup');
      }),
    });

    await expect(
      createOrGetPrReviewTask({ projectId: 'project-1', pullRequestId: 12 }, deps),
    ).rejects.toThrow('update failed');
    expect(deps.emitTaskUpsert).not.toHaveBeenCalled();
    expect(deps.cleanupWorktree).toHaveBeenCalledWith({
      worktreePath: '/repo/.worktrees/review-pr-12',
      projectPath: '/repo',
      branchName: 'review-pr-12',
      branchCleanup: 'delete',
      force: true,
    });

    await expect(
      createOrGetPrReviewTask({ projectId: 'project-1', pullRequestId: 12 }, deps),
    ).resolves.toMatchObject({ created: false });
    expect(order).toEqual([
      'worktree',
      'persist-fail',
      'cleanup',
      'worktree',
      'persist-success',
    ]);
  });

  it('cleans a new worktree when task insert fails so retry has no orphan', async () => {
    const deps = makeDeps({
      createTask: vi
        .fn()
        .mockRejectedValueOnce(new Error('insert failed'))
        .mockImplementationOnce(async (data) => makeTask(data)),
    });

    await expect(
      createOrGetPrReviewTask({ projectId: 'project-1', pullRequestId: 12 }, deps),
    ).rejects.toThrow('insert failed');
    expect(deps.emitTaskUpsert).not.toHaveBeenCalled();
    expect(deps.cleanupWorktree).toHaveBeenCalledWith({
      worktreePath: '/repo/.worktrees/review-pr-12',
      projectPath: '/repo',
      branchName: 'review-pr-12',
      branchCleanup: 'delete',
      force: true,
    });

    await expect(
      createOrGetPrReviewTask({ projectId: 'project-1', pullRequestId: 12 }, deps),
    ).resolves.toMatchObject({ created: true });
    expect(deps.createWorktree).toHaveBeenCalledTimes(2);
    expect(deps.cleanupWorktree).toHaveBeenCalledTimes(1);
  });

  it('preserves persistence and cleanup failures with orphan context', async () => {
    const persistenceError = new Error('insert failed');
    const cleanupError = new Error('branch delete failed');
    const deps = makeDeps({
      createTask: vi.fn().mockRejectedValue(persistenceError),
      cleanupWorktree: vi.fn().mockRejectedValue(cleanupError),
    });

    const error = await createOrGetPrReviewTask(
      { projectId: 'project-1', pullRequestId: 12 },
      deps,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({
      message: expect.stringContaining('/repo/.worktrees/review-pr-12'),
      cause: persistenceError,
      errors: [persistenceError, cleanupError],
    });
    expect(deps.emitTaskUpsert).not.toHaveBeenCalled();
  });

  it('aborts when the fetched PR becomes abandoned before worktree creation', async () => {
    const deps = makeDeps({
      getPullRequest: vi
        .fn()
        .mockResolvedValueOnce({
          pullRequestId: 12,
          title: 'Fix bug',
          sourceRefName: 'refs/heads/feature/fix-bug',
          status: 'active',
        })
        .mockResolvedValueOnce({
          pullRequestId: 12,
          title: 'Fix bug',
          sourceRefName: 'refs/heads/feature/fix-bug',
          status: 'abandoned',
        }),
    });

    await deps.getPullRequest({
      providerId: 'provider-1',
      projectId: 'repo-project-1',
      repoId: 'repo-1',
      pullRequestId: 12,
    });
    await expect(
      createOrGetPrReviewTask(
        { projectId: 'project-1', pullRequestId: 12 },
        deps,
      ),
    ).rejects.toThrow('active');
    expect(deps.createWorktree).not.toHaveBeenCalled();
    expect(deps.createTask).not.toHaveBeenCalled();
  });

  it('fetches the PR source branch with git args instead of shell interpolation', async () => {
    const sourceBranch = 'feature/$(touch injected)";rm -rf x';

    await fetchPrReviewSourceBranch({
      projectPath: '/repo',
      sourceBranch,
    });

    expect(mocks.execFile).toHaveBeenCalledWith(
      'git',
      [
        'fetch',
        'origin',
        `+refs/heads/${sourceBranch}:refs/remotes/origin/${sourceBranch}`,
      ],
      { cwd: '/repo', encoding: 'utf-8' },
      expect.any(Function),
    );
  });
});

describe('startPrCommand', () => {
  it('launches a fresh task after a cleaned completed review', async () => {
    const completedTask = makeTask({
      status: 'completed',
      userCompleted: true,
      worktreePath: null,
      branchName: null,
      startCommitHash: null,
      sourceBranch: null,
    });
    const deps = makeStartDeps({
      findActivePrReviewTask: vi.fn().mockResolvedValue(completedTask),
    });

    await expect(
      startPrCommand(
        {
          projectId: 'project-1',
          pullRequestId: 12,
          target: { type: 'command', id: 'web' },
        },
        deps,
      ),
    ).resolves.toMatchObject({ created: true });
    expect(deps.createTask).toHaveBeenCalled();
    expect(deps.updateTask).not.toHaveBeenCalled();
    expect(deps.startCommand).toHaveBeenCalled();
  });
  it('creates a workspace and starts an owned command from its worktree', async () => {
    const deps = makeStartDeps();

    const result = await startPrCommand(
      {
        projectId: 'project-1',
        pullRequestId: 12,
        target: { type: 'command', id: 'web' },
      },
      deps,
    );

    expect(result.created).toBe(true);
    expect(result.runCommandIds).toEqual(['web']);
    expect(deps.startCommand).toHaveBeenCalledWith(
      {
        taskId: 'task-1',
        projectId: 'project-1',
        workingDir: '/repo/.worktrees/review-pr-12',
        runCommandId: 'web',
      },
      { afterStop: expect.any(Function) },
    );
    const afterStop = deps.startCommand.mock.calls[0][1].afterStop;
    await afterStop();
    expect(deps.resetLogs).toHaveBeenCalledWith('task-1', ['web']);
  });

  it('reuses an existing review workspace', async () => {
    const task = makeTask({ id: 'existing-task' });
    const deps = makeStartDeps({
      findActivePrReviewTask: vi.fn().mockResolvedValue(task),
    });

    await expect(
      startPrCommand(
        {
          projectId: 'project-1',
          pullRequestId: 12,
          target: { type: 'command', id: 'web' },
        },
        deps,
      ),
    ).resolves.toMatchObject({ task, created: false });
    expect(deps.createWorktree).not.toHaveBeenCalled();
  });

  it('emits one authoritative upsert when Start Project restores a kept workspace', async () => {
    const keptTask = makeTask({
      id: 'existing-task',
      prWorkspaceState: 'kept',
    });
    const activeTask = makeTask({
      ...keptTask,
      prWorkspaceState: 'active',
    });
    const deps = makeStartDeps({
      findActivePrReviewTask: vi.fn().mockResolvedValue(keptTask),
      setPrWorkspaceState: vi.fn().mockResolvedValue(activeTask),
    });

    await expect(
      startPrCommand(
        {
          projectId: 'project-1',
          pullRequestId: 12,
          target: { type: 'command', id: 'web' },
        },
        deps,
      ),
    ).resolves.toMatchObject({ task: activeTask, created: false });
    expect(deps.emitTaskUpsert).toHaveBeenCalledOnce();
    expect(deps.emitTaskUpsert).toHaveBeenCalledWith(activeTask);
    expect(deps.startCommand).toHaveBeenCalled();
  });

  it('rejects an archived project with an existing review workspace', async () => {
    const task = makeTask({ id: 'existing-task' });
    const deps = makeStartDeps({
      findProjectById: vi
        .fn()
        .mockResolvedValue(makeProject({ archivedAt: '2026-07-13T00:00:00.000Z' })),
      findActivePrReviewTask: vi.fn().mockResolvedValue(task),
    });

    await expect(
      startPrCommand(
        {
          projectId: 'project-1',
          pullRequestId: 12,
          target: { type: 'command', id: 'web' },
        },
        deps,
      ),
    ).rejects.toThrow('archived');
    expect(deps.getPullRequest).not.toHaveBeenCalled();
    expect(deps.startCommand).not.toHaveBeenCalled();
  });

  it.each(['completed', 'abandoned'] as const)(
    'requires an active PR instead of %s',
    async (status) => {
      const deps = makeStartDeps({
        getPullRequest: vi.fn().mockResolvedValue({
          title: 'Fix bug',
          sourceRefName: 'feature/fix-bug',
          status,
        }),
      });

      await expect(
        startPrCommand(
          {
            projectId: 'project-1',
            pullRequestId: 12,
            target: { type: 'command', id: 'web' },
          },
          deps,
        ),
      ).rejects.toThrow('active');
      expect(deps.findActivePrReviewTask).not.toHaveBeenCalled();
    },
  );

  it('revalidates active status before creating a workspace', async () => {
    const deps = makeStartDeps({
      getPullRequest: vi
        .fn()
        .mockResolvedValueOnce({
          title: 'Fix bug',
          sourceRefName: 'feature/fix-bug',
          status: 'active',
        })
        .mockResolvedValueOnce({
          title: 'Fix bug',
          sourceRefName: 'feature/fix-bug',
          status: 'abandoned',
        }),
    });

    await expect(
      startPrCommand(
        {
          projectId: 'project-1',
          pullRequestId: 12,
          target: { type: 'command', id: 'web' },
        },
        deps,
      ),
    ).rejects.toThrow('active');
    expect(deps.createWorktree).not.toHaveBeenCalled();
    expect(deps.startCommand).not.toHaveBeenCalled();
  });

  it('revalidates active status before reusing a workspace', async () => {
    const deps = makeStartDeps({
      findActivePrReviewTask: vi.fn().mockResolvedValue(makeTask()),
      getPullRequest: vi
        .fn()
        .mockResolvedValueOnce({
          title: 'Fix bug',
          sourceRefName: 'feature/fix-bug',
          status: 'active',
        })
        .mockResolvedValueOnce({
          title: 'Fix bug',
          sourceRefName: 'feature/fix-bug',
          status: 'abandoned',
        }),
    });

    await expect(
      startPrCommand(
        {
          projectId: 'project-1',
          pullRequestId: 12,
          target: { type: 'command', id: 'web' },
        },
        deps,
      ),
    ).rejects.toThrow('active');
    expect(deps.startCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['foreign', makeCommand({ projectId: 'project-2' })],
  ])('rejects a %s command before workspace creation', async (_case, command) => {
    const deps = makeStartDeps({
      findCommandById: vi.fn().mockResolvedValue(command),
    });

    await expect(
      startPrCommand(
        {
          projectId: 'project-1',
          pullRequestId: 12,
          target: { type: 'command', id: 'web' },
        },
        deps,
      ),
    ).rejects.toThrow('Command web not found for project project-1');
    expect(deps.findActivePrReviewTask).not.toHaveBeenCalled();
  });

  it('resolves a group server-side and deduplicates members in order', async () => {
    const deps = makeStartDeps();

    const result = await startPrCommand(
      {
        projectId: 'project-1',
        pullRequestId: 12,
        target: { type: 'group', id: 'full-stack' },
      },
      deps,
    );

    expect(deps.findCommandById.mock.calls.map(([id]) => id)).toEqual([
      'web',
      'api',
    ]);
    expect(result.runCommandIds).toEqual(['web', 'api']);
    expect(deps.startGroup).toHaveBeenCalledWith(
      expect.objectContaining({ runCommandIds: ['web', 'api'] }),
      { afterStop: expect.any(Function) },
    );
    const afterStop = deps.startGroup.mock.calls[0][1].afterStop;
    await afterStop();
    expect(deps.resetLogs).toHaveBeenCalledWith('task-1', ['web', 'api']);
  });

  it.each([
    ['missing group', undefined],
    ['foreign group', makeGroup({ projectId: 'project-2' })],
    ['empty group', makeGroup({ commandIds: [] })],
  ])('rejects a %s before workspace creation', async (_case, group) => {
    const deps = makeStartDeps({
      findCommandGroupById: vi.fn().mockResolvedValue(group),
    });

    await expect(
      startPrCommand(
        {
          projectId: 'project-1',
          pullRequestId: 12,
          target: { type: 'group', id: 'full-stack' },
        },
        deps,
      ),
    ).rejects.toThrow();
    expect(deps.findActivePrReviewTask).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['foreign', makeCommand({ id: 'api', projectId: 'project-2' })],
  ])('rejects a group with a %s member', async (_case, command) => {
    const deps = makeStartDeps({
      findCommandById: vi.fn(async (id: string) =>
        id === 'api' ? command : makeCommand({ id }),
      ),
    });

    await expect(
      startPrCommand(
        {
          projectId: 'project-1',
          pullRequestId: 12,
          target: { type: 'group', id: 'full-stack' },
        },
        deps,
      ),
    ).rejects.toThrow('Command api not found for project project-1');
    expect(deps.findActivePrReviewTask).not.toHaveBeenCalled();
  });

  it('passes through port conflicts with the retained workspace', async () => {
    const runResult = {
      type: 'PortsInUseError' as const,
      message: 'Ports in use: 3000',
      portsInUse: [
        { port: 3000, commandId: 'web', command: 'pnpm dev' },
      ],
    };
    const deps = makeStartDeps({
      startCommand: vi.fn().mockResolvedValue(runResult),
    });

    await expect(
      startPrCommand(
        {
          projectId: 'project-1',
          pullRequestId: 12,
          target: { type: 'command', id: 'web' },
        },
        deps,
      ),
    ).resolves.toMatchObject({
      created: true,
      runCommandIds: ['web'],
      runResult,
    });
  });

  it('serializes starts for the same project and PR', async () => {
    const firstStart = deferred<{ isRunning: boolean; commands: [] }>();
    let activeTask: Task | undefined;
    const deps = makeStartDeps({
      findActivePrReviewTask: vi.fn(async () => activeTask),
      createTask: vi.fn(async (data) => {
        activeTask = makeTask(data);
        return activeTask;
      }),
      startCommand: vi
        .fn()
        .mockImplementationOnce(() => firstStart.promise)
        .mockResolvedValue({ isRunning: true, commands: [] }),
    });
    const params = {
      projectId: 'project-1',
      pullRequestId: 12,
      target: { type: 'command' as const, id: 'web' },
    };

    const first = startPrCommand(params, deps);
    await vi.waitFor(() => expect(deps.startCommand).toHaveBeenCalledTimes(1));
    const second = startPrCommand(params, deps);
    await Promise.resolve();
    expect(deps.startCommand).toHaveBeenCalledTimes(1);

    firstStart.resolve({ isRunning: true, commands: [] });
    await Promise.all([first, second]);
    expect(deps.createTask).toHaveBeenCalledTimes(1);
    expect(deps.startCommand).toHaveBeenCalledTimes(2);
  });

  it('allows different PR lifecycle keys to proceed concurrently', async () => {
    const firstStart = deferred<{ isRunning: boolean; commands: [] }>();
    const deps = makeStartDeps({
      startCommand: vi
        .fn()
        .mockImplementationOnce(() => firstStart.promise)
        .mockResolvedValue({ isRunning: true, commands: [] }),
    });

    const first = startPrCommand(
      {
        projectId: 'project-1',
        pullRequestId: 12,
        target: { type: 'command', id: 'web' },
      },
      deps,
    );
    await vi.waitFor(() => expect(deps.startCommand).toHaveBeenCalledTimes(1));
    const second = startPrCommand(
      {
        projectId: 'project-1',
        pullRequestId: 13,
        target: { type: 'command', id: 'web' },
      },
      deps,
    );
    await vi.waitFor(() => expect(deps.startCommand).toHaveBeenCalledTimes(2));

    firstStart.resolve({ isRunning: true, commands: [] });
    await Promise.all([first, second]);
  });

  it('recovers the lifecycle queue after a rejected operation', async () => {
    const deps = makeStartDeps({
      startCommand: vi
        .fn()
        .mockRejectedValueOnce(new Error('spawn failed'))
        .mockResolvedValue({ isRunning: true, commands: [] }),
    });
    const params = {
      projectId: 'project-1',
      pullRequestId: 12,
      target: { type: 'command' as const, id: 'web' },
    };

    await expect(startPrCommand(params, deps)).rejects.toThrow('spawn failed');
    await expect(startPrCommand(params, deps)).resolves.toMatchObject({
      runResult: { isRunning: true },
    });
  });
});

describe('reconcilePrWorkspaceState', () => {
  function makeReconcileDeps({
    status = 'completed',
    tasks = [makeTask()],
  }: {
    status?: 'active' | 'completed' | 'abandoned';
    tasks?: Task[];
  } = {}) {
    return {
      findPrReviewTasksByPullRequest: vi.fn().mockResolvedValue(tasks),
      revalidatePullRequestStatus: vi.fn().mockResolvedValue(status),
      markPrWorkspacesKept: vi.fn(async ({ taskIds }: { taskIds: string[] }) =>
        taskIds.map((id) =>
          makeTask({
            ...tasks.find((task) => task.id === id),
            id,
            prWorkspaceState: 'kept',
          }),
        ),
      ),
      reactivatePrWorkspaces: vi.fn(async (taskIds: string[]) =>
        taskIds.map((id) => {
          const task = tasks.find((candidate) => candidate.id === id);
          return makeTask({
            ...task,
            id,
            prWorkspaceState: 'active',
            status: task?.status === 'completed' ? 'waiting' : task?.status,
            userCompleted: false,
          });
        }),
      ),
      emitTaskUpsert: vi.fn(),
    };
  }

  it('leaves active workspaces untouched for an active PR', async () => {
    const deps = makeReconcileDeps({ status: 'active' });

    await expect(
      reconcilePrWorkspaceState(
        { projectId: 'project-1', pullRequestId: 12 },
        deps,
      ),
    ).resolves.toEqual([]);
    expect(deps.markPrWorkspacesKept).not.toHaveBeenCalled();
    expect(deps.reactivatePrWorkspaces).not.toHaveBeenCalled();
    expect(deps.emitTaskUpsert).not.toHaveBeenCalled();
  });

  it('isolates authoritative status errors without reading or changing tasks', async () => {
    const deps = makeReconcileDeps();
    vi.mocked(deps.revalidatePullRequestStatus).mockRejectedValue(
      new Error('provider unavailable'),
    );

    await expect(
      reconcilePrWorkspaceState(
        { projectId: 'project-1', pullRequestId: 12 },
        deps,
      ),
    ).resolves.toEqual([]);
    expect(deps.findPrReviewTasksByPullRequest).not.toHaveBeenCalled();
    expect(deps.markPrWorkspacesKept).not.toHaveBeenCalled();
    expect(deps.reactivatePrWorkspaces).not.toHaveBeenCalled();
  });

  it.each(['completed', 'abandoned'] as const)(
    'marks every active workspace kept when PR is %s without destructive work',
    async (status) => {
      const tasks = [
        makeTask({ id: 'first' }),
        makeTask({ id: 'kept', prWorkspaceState: 'kept' }),
        makeTask({ id: 'second' }),
      ];
      const destructive = {
        stopCommandsForTask: vi.fn(),
        stopAgent: vi.fn(),
        closeEditorWindowsForTaskWorktree: vi.fn(),
        cleanupWorktree: vi.fn(),
        updateTaskStatus: vi.fn(),
        compactRawMessages: vi.fn(),
        deleteTask: vi.fn(),
      };
      const deps = { ...makeReconcileDeps({ status, tasks }), ...destructive };

      const changed = await reconcilePrWorkspaceState(
        { projectId: 'project-1', pullRequestId: 12 },
        deps,
      );

      expect(changed.map((task) => task.id)).toEqual(['first', 'second']);
      expect(deps.markPrWorkspacesKept).toHaveBeenCalledOnce();
      expect(deps.markPrWorkspacesKept).toHaveBeenCalledWith({
        projectId: 'project-1',
        pullRequestId: '12',
        taskIds: ['first', 'second'],
      });
      expect(deps.emitTaskUpsert).toHaveBeenCalledTimes(2);
      for (const sideEffect of Object.values(destructive)) {
        expect(sideEffect).not.toHaveBeenCalled();
      }

      vi.mocked(deps.findPrReviewTasksByPullRequest).mockResolvedValue([
        ...changed,
        tasks[1],
      ]);
      await expect(
        reconcilePrWorkspaceState(
          { projectId: 'project-1', pullRequestId: 12 },
          deps,
        ),
      ).resolves.toEqual([]);
      expect(deps.markPrWorkspacesKept).toHaveBeenCalledOnce();
      expect(deps.emitTaskUpsert).toHaveBeenCalledTimes(2);
    },
  );

  it('emits nothing when the grouped kept transition fails', async () => {
    const deps = makeReconcileDeps({
      tasks: [makeTask({ id: 'first' }), makeTask({ id: 'second' })],
    });
    vi.mocked(deps.markPrWorkspacesKept).mockRejectedValue(
      new Error('transaction rolled back'),
    );

    await expect(
      reconcilePrWorkspaceState(
        { projectId: 'project-1', pullRequestId: 12 },
        deps,
      ),
    ).rejects.toThrow('rolled back');
    expect(deps.emitTaskUpsert).not.toHaveBeenCalled();
  });

  it('leaves kept and legacy pending workspaces unchanged on repeated closure', async () => {
    const deps = makeReconcileDeps({
      tasks: [
        makeTask({ id: 'kept', prWorkspaceState: 'kept' }),
        makeTask({ id: 'pending', prWorkspaceState: 'cleanup-pending' }),
      ],
    });

    await expect(
      reconcilePrWorkspaceState(
        { projectId: 'project-1', pullRequestId: 12 },
        deps,
      ),
    ).resolves.toEqual([]);
    expect(deps.markPrWorkspacesKept).not.toHaveBeenCalled();
  });

  it('reactivates pending and kept workspaces when PR reopens', async () => {
    const deps = makeReconcileDeps({
      status: 'active',
      tasks: [
        makeTask({
          id: 'pending',
          prWorkspaceState: 'cleanup-pending',
          status: 'completed',
          userCompleted: true,
        }),
        makeTask({
          id: 'kept',
          prWorkspaceState: 'kept',
          status: 'running',
          userCompleted: false,
        }),
        makeTask({
          id: 'waiting',
          prWorkspaceState: 'cleanup-pending',
          status: 'waiting',
          userCompleted: false,
        }),
      ],
    });

    const changed = await reconcilePrWorkspaceState(
      { projectId: 'project-1', pullRequestId: 12 },
      deps,
    );
    expect(changed.every((task) => task.prWorkspaceState === 'active')).toBe(true);
    expect(changed.map(({ id, status, userCompleted }) => ({ id, status, userCompleted }))).toEqual([
      { id: 'pending', status: 'waiting', userCompleted: false },
      { id: 'kept', status: 'running', userCompleted: false },
      { id: 'waiting', status: 'waiting', userCompleted: false },
    ]);
    expect(deps.reactivatePrWorkspaces).toHaveBeenCalledWith([
      'pending',
      'kept',
      'waiting',
    ]);
    expect(deps.markPrWorkspacesKept).not.toHaveBeenCalled();
    expect(deps.emitTaskUpsert).toHaveBeenCalledTimes(3);

    const restored = changed[0];
    const command = vi.fn().mockResolvedValue('started');
    await runCommandWithPrReviewLifecycle(
      {
        taskId: restored.id,
        projectId: restored.projectId,
        workingDir: restored.worktreePath!,
        runCommandId: 'web',
      },
      command,
      { findTaskById: vi.fn().mockResolvedValue(restored) },
    );
    const agent = vi.fn();
    await startAgentWithPrReviewLifecycle('restored-step', agent, {
      findStepById: vi
        .fn()
        .mockResolvedValue({ id: 'restored-step', taskId: restored.id }),
      findTaskById: vi.fn().mockResolvedValue(restored),
    });
    expect(command).toHaveBeenCalled();
    expect(agent).toHaveBeenCalledWith('restored-step');

    vi.mocked(deps.revalidatePullRequestStatus).mockResolvedValue('completed');
    vi.mocked(deps.findPrReviewTasksByPullRequest).mockResolvedValue(changed);
    await expect(
      reconcilePrWorkspaceState(
        { projectId: 'project-1', pullRequestId: 12 },
        deps,
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ prWorkspaceState: 'kept' }),
      ]),
    );
  });

  it('revalidates status and re-fetches tasks after a queued launch', async () => {
    const startGate = deferred<{ isRunning: boolean; commands: [] }>();
    const startDeps = makeStartDeps({
      startCommand: vi.fn().mockReturnValue(startGate.promise),
    });
    const start = startPrCommand(
      {
        projectId: 'project-1',
        pullRequestId: 12,
        target: { type: 'command', id: 'web' },
      },
      startDeps,
    );
    await vi.waitFor(() => expect(startDeps.startCommand).toHaveBeenCalled());
    const deps = makeReconcileDeps({ status: 'completed' });
    const reconciliation = reconcilePrWorkspaceState(
      { projectId: 'project-1', pullRequestId: 12 },
      deps,
    );
    expect(deps.revalidatePullRequestStatus).not.toHaveBeenCalled();

    startGate.resolve({ isRunning: true, commands: [] });
    await expect(Promise.all([start, reconciliation])).resolves.toBeDefined();
    expect(deps.revalidatePullRequestStatus).toHaveBeenCalled();
    expect(deps.findPrReviewTasksByPullRequest).toHaveBeenCalled();
    expect(deps.markPrWorkspacesKept).toHaveBeenCalled();
  });
});

describe('sendMessageWithPrReviewLifecycle', () => {
  function setup(task = makeTask()) {
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const beginFollowUp = vi.fn().mockResolvedValue({
      started: Promise.resolve(),
      completion,
    });
    const deps = {
      findStepById: vi
        .fn()
        .mockResolvedValue({ id: 'step-1', taskId: task.id }),
      findTaskById: vi.fn().mockResolvedValue(task),
    };
    return { beginFollowUp, deps, resolveCompletion, rejectCompletion };
  }

  it('resolves on acceptance, not on turn completion, when waitForCompletion is false', async () => {
    const { beginFollowUp, deps, resolveCompletion } = setup();

    // Would hang forever if it awaited `completion`: nothing resolves it here.
    await expect(
      sendMessageWithPrReviewLifecycle('step-1', beginFollowUp, {
        ...deps,
        waitForCompletion: false,
      }),
    ).resolves.toBeUndefined();

    expect(beginFollowUp).toHaveBeenCalledWith('step-1');
    resolveCompletion();
  });

  it('does not surface a turn failure as an unhandled rejection', async () => {
    const { beginFollowUp, deps, rejectCompletion } = setup();

    await sendMessageWithPrReviewLifecycle('step-1', beginFollowUp, {
      ...deps,
      waitForCompletion: false,
    });

    rejectCompletion(new Error('turn aborted'));
    // Flush microtasks: an unobserved rejection would trip vitest here.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('still awaits the whole turn by default', async () => {
    const { beginFollowUp, deps, resolveCompletion } = setup();
    let settled = false;

    const pending = sendMessageWithPrReviewLifecycle(
      'step-1',
      beginFollowUp,
      deps,
    ).then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    resolveCompletion();
    await pending;
    expect(settled).toBe(true);
  });
});

describe('runCommandWithPrReviewLifecycle', () => {
  it('uses current backend project and worktree instead of renderer values', async () => {
    const task = makeTask();
    const operation = vi.fn().mockResolvedValue('started');

    await expect(
      runCommandWithPrReviewLifecycle(
        {
          taskId: task.id,
          projectId: 'stale-project',
          workingDir: '/stale/worktree',
          runCommandId: 'web',
        },
        operation,
        { findTaskById: vi.fn().mockResolvedValue(task) },
      ),
    ).resolves.toBe('started');

    expect(operation).toHaveBeenCalledWith({
      taskId: task.id,
      projectId: task.projectId,
      workingDir: task.worktreePath,
      runCommandId: 'web',
    });
  });

  it('retains renderer parameters for non-PR tasks', async () => {
    const params = {
      taskId: 'agent-task',
      projectId: 'renderer-project',
      workingDir: '/renderer/worktree',
      runCommandIds: ['web', 'api'],
    };
    const operation = vi.fn().mockResolvedValue('started');

    await runCommandWithPrReviewLifecycle(params, operation, {
      findTaskById: vi.fn().mockResolvedValue(makeTask({ type: 'agent' })),
    });

    expect(operation).toHaveBeenCalledWith(params);
  });

  it('rejects starts for completed PR review tasks', async () => {
    const task = makeTask({ status: 'completed' });
    const operation = vi.fn();

    await expect(
      runCommandWithPrReviewLifecycle(
        {
          taskId: task.id,
          projectId: task.projectId,
          workingDir: task.worktreePath!,
          runCommandId: 'web',
        },
        operation,
        { findTaskById: vi.fn().mockResolvedValue(task) },
      ),
    ).rejects.toThrow('active worktree');
    expect(operation).not.toHaveBeenCalled();
  });

  it('holds cleanup until an in-flight generic PR command start finishes', async () => {
    const task = makeTask();
    const startGate = deferred<string>();
    const operation = vi.fn().mockReturnValue(startGate.promise);
    const start = runCommandWithPrReviewLifecycle(
      {
        taskId: task.id,
        projectId: task.projectId,
        workingDir: task.worktreePath!,
        runCommandId: 'web',
      },
      operation,
      { findTaskById: vi.fn().mockResolvedValue(task) },
    );
    await vi.waitFor(() => expect(operation).toHaveBeenCalled());
    const cleanupDeps = {
      findTaskById: vi.fn().mockResolvedValue(task),
      findProjectById: vi.fn().mockResolvedValue(makeProject()),
      stopCommandsForTask: vi.fn(),
      closeEditorWindowsForTaskWorktree: vi.fn(),
      pathExists: vi.fn().mockResolvedValue(true),
      cleanupWorktree: vi.fn(),
      cleanupMissingWorktree: vi.fn(),
      clearWorktreeMetadata: vi.fn().mockResolvedValue(
        makeTask({ worktreePath: null, branchName: null }),
      ),
      emitTaskUpsert: vi.fn(),
    };
    const cleanup = cleanPrReviewWorkspace(
      {
        projectId: task.projectId,
        pullRequestId: task.pullRequestId!,
        taskId: task.id,
      },
      cleanupDeps,
    );
    await Promise.resolve();
    expect(cleanupDeps.stopCommandsForTask).not.toHaveBeenCalled();

    startGate.resolve('started');
    await Promise.all([start, cleanup]);
    expect(cleanupDeps.cleanupWorktree).toHaveBeenCalled();
  });

  it('rejects a queued generic start after cleanup clears its workspace', async () => {
    let currentTask = makeTask();
    const cleanupGate = deferred<void>();
    const cleanupDeps = {
      findTaskById: vi.fn(async () => currentTask),
      findProjectById: vi.fn().mockResolvedValue(makeProject()),
      stopCommandsForTask: vi.fn(),
      closeEditorWindowsForTaskWorktree: vi.fn(),
      pathExists: vi.fn().mockResolvedValue(true),
      cleanupWorktree: vi.fn().mockReturnValue(cleanupGate.promise),
      cleanupMissingWorktree: vi.fn(),
      clearWorktreeMetadata: vi.fn(async () => {
        currentTask = makeTask({
          worktreePath: null,
          branchName: null,
          startCommitHash: null,
          sourceBranch: null,
        });
        return currentTask;
      }),
      emitTaskUpsert: vi.fn(),
    };
    const cleanup = cleanPrReviewWorkspace(
      {
        projectId: currentTask.projectId,
        pullRequestId: currentTask.pullRequestId!,
        taskId: currentTask.id,
      },
      cleanupDeps,
    );
    await vi.waitFor(() => expect(cleanupDeps.cleanupWorktree).toHaveBeenCalled());
    const operation = vi.fn();
    const start = runCommandWithPrReviewLifecycle(
      {
        taskId: currentTask.id,
        projectId: 'stale-project',
        workingDir: '/stale/worktree',
        runCommandId: 'web',
      },
      operation,
      { findTaskById: vi.fn(async () => currentTask) },
    );

    cleanupGate.resolve();
    await cleanup;
    await expect(start).rejects.toThrow('active worktree');
    expect(operation).not.toHaveBeenCalled();
  });
});

describe('runTaskDestructiveWithPrReviewLifecycle', () => {
  it('allows completed PR review tasks without worktree metadata', async () => {
    const task = makeTask({
      status: 'completed',
      userCompleted: true,
      worktreePath: null,
      branchName: null,
      startCommitHash: null,
      sourceBranch: null,
    });
    const operation = vi.fn().mockResolvedValue('deleted');

    await expect(
      runTaskDestructiveWithPrReviewLifecycle(task, operation, {
        findTaskById: vi.fn().mockResolvedValue(task),
      }),
    ).resolves.toBe('deleted');
    expect(operation).toHaveBeenCalledWith(task);
  });

  it('leaves non-PR task execution unchanged', async () => {
    const task = makeTask({ type: 'agent' });
    const operation = vi.fn().mockResolvedValue('completed');
    const findTaskById = vi.fn();

    await expect(
      runTaskDestructiveWithPrReviewLifecycle(task, operation, {
        findTaskById,
      }),
    ).resolves.toBe('completed');
    expect(findTaskById).not.toHaveBeenCalled();
    expect(operation).toHaveBeenCalledWith(task);
  });

  it.each(['delete', 'complete'])(
    'waits for an in-flight start before %s',
    async () => {
      const task = makeTask();
      const startGate = deferred<string>();
      const spawn = vi.fn().mockReturnValue(startGate.promise);
      const start = runCommandWithPrReviewLifecycle(
        {
          taskId: task.id,
          projectId: task.projectId,
          workingDir: task.worktreePath!,
          runCommandId: 'web',
        },
        spawn,
        { findTaskById: vi.fn().mockResolvedValue(task) },
      );
      await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
      const operation = vi.fn().mockResolvedValue(undefined);
      const destructive = runTaskDestructiveWithPrReviewLifecycle(
        task,
        operation,
        { findTaskById: vi.fn().mockResolvedValue(task) },
      );
      await Promise.resolve();
      expect(operation).not.toHaveBeenCalled();

      startGate.resolve('started');
      await Promise.all([start, destructive]);
      expect(operation).toHaveBeenCalledWith(task);
    },
  );

  it.each(['delete', 'complete'])(
    '%s first makes a queued start fail without spawning',
    async (operationType) => {
      let currentTask: Task | undefined = makeTask();
      const task = currentTask;
      const destructiveGate = deferred<void>();
      const destructiveOperation = vi.fn(async () => {
        await destructiveGate.promise;
        currentTask =
          operationType === 'delete'
            ? undefined
            : makeTask({ status: 'completed', userCompleted: true });
      });
      const destructive = runTaskDestructiveWithPrReviewLifecycle(
        task,
        destructiveOperation,
        { findTaskById: vi.fn(async () => currentTask) },
      );
      await vi.waitFor(() => expect(destructiveOperation).toHaveBeenCalled());
      const spawn = vi.fn();
      const start = runCommandWithPrReviewLifecycle(
        {
          taskId: task.id,
          projectId: task.projectId,
          workingDir: task.worktreePath!,
          runCommandId: 'web',
        },
        spawn,
        { findTaskById: vi.fn(async () => currentTask) },
      );

      destructiveGate.resolve();
      await destructive;
      await expect(start).rejects.toThrow();
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it('recovers lifecycle lock after destructive operation failure', async () => {
    const task = makeTask();
    const deps = { findTaskById: vi.fn().mockResolvedValue(task) };

    await expect(
      runTaskDestructiveWithPrReviewLifecycle(
        task,
        vi.fn().mockRejectedValue(new Error('delete failed')),
        deps,
      ),
    ).rejects.toThrow('delete failed');
    await expect(
      runTaskDestructiveWithPrReviewLifecycle(
        task,
        vi.fn().mockResolvedValue('retried'),
        deps,
      ),
    ).resolves.toBe('retried');
  });

  it('holds toggle completion until an in-flight start finishes', async () => {
    let currentTask = makeTask();
    const startGate = deferred<string>();
    const spawn = vi.fn().mockReturnValue(startGate.promise);
    const start = runCommandWithPrReviewLifecycle(
      {
        taskId: currentTask.id,
        projectId: currentTask.projectId,
        workingDir: currentTask.worktreePath!,
        runCommandId: 'web',
      },
      spawn,
      { findTaskById: vi.fn(async () => currentTask) },
    );
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    const toggle = vi.fn(async (task: Task) => {
      currentTask = makeTask({
        ...task,
        status: 'completed',
        userCompleted: true,
      });
    });
    const toggled = runTaskDestructiveWithPrReviewLifecycle(
      currentTask,
      toggle,
      { findTaskById: vi.fn(async () => currentTask) },
    );
    await Promise.resolve();
    expect(toggle).not.toHaveBeenCalled();

    startGate.resolve('started');
    await Promise.all([start, toggled]);
    expect(toggle).toHaveBeenCalled();
  });

  it('queued start fails after toggle completes task', async () => {
    let currentTask = makeTask();
    const toggleGate = deferred<void>();
    const toggle = vi.fn(async (task: Task) => {
      await toggleGate.promise;
      currentTask = makeTask({
        ...task,
        status: 'completed',
        userCompleted: true,
      });
    });
    const toggled = runTaskDestructiveWithPrReviewLifecycle(
      currentTask,
      toggle,
      { findTaskById: vi.fn(async () => currentTask) },
    );
    await vi.waitFor(() => expect(toggle).toHaveBeenCalled());
    const spawn = vi.fn();
    const start = runCommandWithPrReviewLifecycle(
      {
        taskId: currentTask.id,
        projectId: currentTask.projectId,
        workingDir: currentTask.worktreePath!,
        runCommandId: 'web',
      },
      spawn,
      { findTaskById: vi.fn(async () => currentTask) },
    );

    toggleGate.resolve();
    await toggled;
    await expect(start).rejects.toThrow('active worktree');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('queued start waits for toggle to uncomplete task', async () => {
    let currentTask = makeTask({
      status: 'completed',
      userCompleted: true,
    });
    const toggleGate = deferred<void>();
    const toggle = vi.fn(async (task: Task) => {
      await toggleGate.promise;
      currentTask = makeTask({
        ...task,
        status: 'waiting',
        userCompleted: false,
      });
    });
    const toggled = runTaskDestructiveWithPrReviewLifecycle(
      currentTask,
      toggle,
      { findTaskById: vi.fn(async () => currentTask) },
    );
    await vi.waitFor(() => expect(toggle).toHaveBeenCalled());
    const spawn = vi.fn().mockResolvedValue('started');
    const start = runCommandWithPrReviewLifecycle(
      {
        taskId: currentTask.id,
        projectId: currentTask.projectId,
        workingDir: currentTask.worktreePath!,
        runCommandId: 'web',
      },
      spawn,
      { findTaskById: vi.fn(async () => currentTask) },
    );
    await Promise.resolve();
    expect(spawn).not.toHaveBeenCalled();

    toggleGate.resolve();
    await Promise.all([toggled, start]);
    expect(spawn).toHaveBeenCalled();
  });

  it('holds lifecycle lock through synchronous PR Git cleanup', async () => {
    let currentTask = makeTask();
    const initialTask = currentTask;
    const cleanupGate = deferred<void>();
    const cleanup = vi.fn(async () => {
      await cleanupGate.promise;
      currentTask = makeTask({
        ...currentTask,
        worktreePath: null,
        branchName: null,
        startCommitHash: null,
        sourceBranch: null,
      });
      return { task: currentTask, changed: true };
    });
    const completion = runTaskDestructiveWithPrReviewLifecycle(
      initialTask,
      (task) =>
        completeTaskWithWorktreeCleanup(
          { task, cleanupWorktree: true },
          {
            stopCommandsForTask: vi.fn(),
            closeEditorWindowsForTaskWorktree: vi.fn(),
            cleanupPrReviewWorkspace: cleanup,
            cleanupTaskWorktree: vi.fn(),
            markUserCompleted: vi.fn(async () => {
              currentTask = makeTask({
                ...currentTask,
                status: 'completed',
                userCompleted: true,
              });
              return currentTask;
            }),
            clearWorktreeMetadata: vi.fn(),
            cleanupFeatureMapTempDirs: vi.fn(),
            compactRawMessages: vi.fn(),
            emitTaskUpsert: vi.fn(),
          },
        ),
      { findTaskById: vi.fn(async () => currentTask) },
    );
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalled());
    const spawn = vi.fn();
    const start = runCommandWithPrReviewLifecycle(
      {
        taskId: initialTask.id,
        projectId: initialTask.projectId,
        workingDir: initialTask.worktreePath!,
        runCommandId: 'web',
      },
      spawn,
      { findTaskById: vi.fn(async () => currentTask) },
    );
    await Promise.resolve();
    expect(spawn).not.toHaveBeenCalled();
    expect(currentTask.worktreePath).toBe(initialTask.worktreePath);

    cleanupGate.resolve();
    await completion;
    await expect(start).rejects.toThrow('active worktree');
    expect(spawn).not.toHaveBeenCalled();
    expect(currentTask.worktreePath).toBeNull();
  });
});

describe('cleanPrReviewWorkspace', () => {
  it('cleans under lifecycle lock without completing active task', async () => {
    const task = makeTask();
    const deps = {
      findTaskById: vi.fn().mockResolvedValue(task),
      findProjectById: vi.fn().mockResolvedValue(makeProject()),
      stopCommandsForTask: vi.fn(),
      closeEditorWindowsForTaskWorktree: vi.fn().mockResolvedValue('warning'),
      pathExists: vi.fn().mockResolvedValue(true),
      cleanupWorktree: vi.fn(),
      cleanupMissingWorktree: vi.fn(),
      clearWorktreeMetadata: vi.fn().mockResolvedValue(
        makeTask({ worktreePath: null, branchName: null }),
      ),
      emitTaskUpsert: vi.fn(),
    };

    await expect(
      cleanPrReviewWorkspace(
        {
          projectId: task.projectId,
          pullRequestId: task.pullRequestId!,
          taskId: task.id,
        },
        deps,
      ),
    ).resolves.toEqual({ editorCloseWarning: 'warning' });
    expect(deps.cleanupWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ branchCleanup: 'delete', force: true }),
    );
  });

  it('serializes against start using project and PR metadata', async () => {
    const cleanupGate = deferred<void>();
    const task = makeTask();
    const deps = {
      findTaskById: vi.fn().mockResolvedValue(task),
      findProjectById: vi.fn().mockResolvedValue(makeProject()),
      stopCommandsForTask: vi.fn(),
      closeEditorWindowsForTaskWorktree: vi.fn(),
      pathExists: vi.fn().mockResolvedValue(true),
      cleanupWorktree: vi.fn().mockReturnValue(cleanupGate.promise),
      cleanupMissingWorktree: vi.fn(),
      clearWorktreeMetadata: vi.fn().mockResolvedValue(
        makeTask({ worktreePath: null, branchName: null }),
      ),
      emitTaskUpsert: vi.fn(),
    };
    const cleanup = cleanPrReviewWorkspace(
      {
        projectId: task.projectId,
        pullRequestId: task.pullRequestId!,
        taskId: task.id,
      },
      deps,
    );
    await vi.waitFor(() => expect(deps.cleanupWorktree).toHaveBeenCalled());
    const startDeps = makeStartDeps();
    const start = startPrCommand(
      {
        projectId: 'project-1',
        pullRequestId: 12,
        target: { type: 'command', id: 'web' },
      },
      startDeps,
    );
    expect(startDeps.getPullRequest).not.toHaveBeenCalled();
    cleanupGate.resolve();
    await Promise.all([cleanup, start]);
    expect(startDeps.getPullRequest).toHaveBeenCalled();
  });

  it('waits for an in-flight start before re-fetching and cleaning', async () => {
    const startGate = deferred<{ isRunning: boolean; commands: [] }>();
    const startDeps = makeStartDeps({
      startCommand: vi.fn().mockReturnValue(startGate.promise),
    });
    const task = makeTask();
    const cleanupDeps = {
      findTaskById: vi.fn().mockResolvedValue(task),
      findProjectById: vi.fn().mockResolvedValue(makeProject()),
      stopCommandsForTask: vi.fn(),
      closeEditorWindowsForTaskWorktree: vi.fn(),
      pathExists: vi.fn().mockResolvedValue(true),
      cleanupWorktree: vi.fn(),
      cleanupMissingWorktree: vi.fn(),
      clearWorktreeMetadata: vi.fn().mockResolvedValue(
        makeTask({ worktreePath: null, branchName: null }),
      ),
      emitTaskUpsert: vi.fn(),
    };
    const start = startPrCommand(
      {
        projectId: 'project-1',
        pullRequestId: 12,
        target: { type: 'command', id: 'web' },
      },
      startDeps,
    );
    await vi.waitFor(() => expect(startDeps.startCommand).toHaveBeenCalled());
    const cleanup = cleanPrReviewWorkspace(
      { projectId: 'project-1', pullRequestId: '12', taskId: task.id },
      cleanupDeps,
    );
    await Promise.resolve();
    expect(cleanupDeps.findTaskById).not.toHaveBeenCalled();

    startGate.resolve({ isRunning: true, commands: [] });
    await Promise.all([start, cleanup]);
    expect(cleanupDeps.cleanupWorktree).toHaveBeenCalled();
  });

  it('recovers manual cleanup lock after failure and succeeds on retry', async () => {
    const task = makeTask();
    const deps = {
      findTaskById: vi.fn().mockResolvedValue(task),
      findProjectById: vi.fn().mockResolvedValue(makeProject()),
      stopCommandsForTask: vi.fn(),
      closeEditorWindowsForTaskWorktree: vi.fn(),
      pathExists: vi.fn().mockResolvedValue(true),
      cleanupWorktree: vi
        .fn()
        .mockRejectedValueOnce(new Error('delete failed'))
        .mockResolvedValueOnce(undefined),
      cleanupMissingWorktree: vi.fn(),
      clearWorktreeMetadata: vi.fn().mockResolvedValue(
        makeTask({ worktreePath: null, branchName: null }),
      ),
      emitTaskUpsert: vi.fn(),
    };
    const params = {
      projectId: 'project-1',
      pullRequestId: '12',
      taskId: task.id,
    };

    await expect(cleanPrReviewWorkspace(params, deps)).rejects.toThrow(
      'delete failed',
    );
    await expect(cleanPrReviewWorkspace(params, deps)).resolves.toEqual({
      editorCloseWarning: undefined,
    });
    expect(deps.cleanupWorktree).toHaveBeenCalledTimes(2);
    expect(deps.clearWorktreeMetadata).toHaveBeenCalledTimes(1);
  });

  it('rejects task identity mismatch after acquiring supplied lifecycle lock', async () => {
    const task = makeTask({ id: 'other-task' });
    const deps = {
      findTaskById: vi.fn().mockResolvedValue(task),
      findProjectById: vi.fn(),
      stopCommandsForTask: vi.fn(),
      closeEditorWindowsForTaskWorktree: vi.fn(),
      pathExists: vi.fn(),
      cleanupWorktree: vi.fn(),
      cleanupMissingWorktree: vi.fn(),
      clearWorktreeMetadata: vi.fn(),
      emitTaskUpsert: vi.fn(),
    };

    await expect(
      cleanPrReviewWorkspace(
        { projectId: 'project-1', pullRequestId: '12', taskId: 'task-1' },
        deps,
      ),
    ).rejects.toThrow('does not match');
    expect(deps.stopCommandsForTask).not.toHaveBeenCalled();
  });
});
