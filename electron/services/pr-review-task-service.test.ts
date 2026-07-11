import { describe, expect, it, vi } from 'vitest';

import type { Project, Task } from '@shared/types';

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
import { buildReadOnlyPrReviewSessionRules } from './pr-review-agent-service';
import {
  completePrReviewTasksForMergedPr,
  createOrGetPrReviewTask,
  fetchPrReviewSourceBranch,
} from './pr-review-task-service';
import { StepService } from './step-service';

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
    hasUnread: false,
    userCompleted: false,
    sessionRules: buildReadOnlyPrReviewSessionRules(),
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
    }),
    fetchSourceBranch: vi.fn().mockResolvedValue(undefined),
    createWorktree: vi.fn().mockResolvedValue({
      worktreePath: '/repo/.worktrees/review-pr-12',
      startCommitHash: 'abc123',
      branchName: 'review-pr-12',
    }),
    createTask: vi.fn(async (data) => makeTask(data)),
    updateTask: vi.fn(async (id, data) => makeTask({ id, ...data })),
    ...overrides,
  };
}

describe('createOrGetPrReviewTask', () => {
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
    expect(deps.findProjectById).not.toHaveBeenCalled();
    expect(deps.getPullRequest).not.toHaveBeenCalled();
    expect(deps.fetchSourceBranch).not.toHaveBeenCalled();
    expect(deps.createWorktree).not.toHaveBeenCalled();
    expect(deps.createTask).not.toHaveBeenCalled();
    expect(deps.updateTask).not.toHaveBeenCalled();
  });

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
      sourceBranch: 'feature/fix-bug',
      pullRequestUrl: 'https://example.test/pr/12',
      sessionRules: buildReadOnlyPrReviewSessionRules(),
    });
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
        sourceBranch: 'feature/fix-bug',
      }),
    );
    expect(deps.createTask).not.toHaveBeenCalled();
  });

  it('does not recreate a worktree for a completed pr-review task', async () => {
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
    ).rejects.toThrow('PR review task is completed');

    expect(deps.createWorktree).not.toHaveBeenCalled();
    expect(deps.updateTask).not.toHaveBeenCalled();
  });

  it('creates a pr-review task with read-only rules and no default steps or autostart', async () => {
    const deps = makeDeps();

    const result = await createOrGetPrReviewTask(
      { projectId: 'project-1', pullRequestId: 12 },
      deps,
    );

    expect(result.created).toBe(true);
    expect(result.task).toMatchObject({
      type: 'pr-review',
      prompt: 'Review PR #12: Fix bug',
      name: 'Review: Fix bug',
      worktreePath: '/repo/.worktrees/review-pr-12',
      startCommitHash: 'abc123',
      branchName: 'review-pr-12',
      sourceBranch: 'feature/fix-bug',
      pullRequestId: '12',
      pullRequestUrl: 'https://example.test/pr/12',
      sessionRules: buildReadOnlyPrReviewSessionRules(),
    });
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
        sessionRules: buildReadOnlyPrReviewSessionRules(),
      }),
    );
    expect(StepService.create).not.toHaveBeenCalled();
    expect(agentService.start).not.toHaveBeenCalled();
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

describe('completePrReviewTasksForMergedPr', () => {
  it('completes linked pr-review tasks and emits task upserts', async () => {
    const task = makeTask({ id: 'review-task', status: 'waiting' });
    const updatedTask = makeTask({
      id: 'review-task',
      status: 'completed',
      userCompleted: true,
    });
    const deps = {
      findPrReviewTasksByPullRequest: vi.fn().mockResolvedValue([task]),
      updateTaskStatus: vi.fn().mockResolvedValue(
        makeTask({ id: 'review-task', status: 'completed' }),
      ),
      markUserCompleted: vi.fn().mockResolvedValue(updatedTask),
      compactRawMessages: vi.fn().mockResolvedValue(undefined),
      emitTaskUpsert: vi.fn(),
    };

    await expect(
      completePrReviewTasksForMergedPr(
        { projectId: 'project-1', pullRequestId: 12 },
        deps,
      ),
    ).resolves.toEqual([updatedTask]);

    expect(deps.findPrReviewTasksByPullRequest).toHaveBeenCalledWith({
      projectId: 'project-1',
      pullRequestId: '12',
    });
    expect(deps.updateTaskStatus).toHaveBeenCalledWith('review-task', {
      status: 'completed',
    });
    expect(deps.markUserCompleted).toHaveBeenCalledWith('review-task');
    expect(deps.compactRawMessages).toHaveBeenCalledWith('review-task');
    expect(deps.emitTaskUpsert).toHaveBeenCalledWith(updatedTask);
  });

  it('does not complete regular agent tasks linked to the PR', async () => {
    const deps = {
      findPrReviewTasksByPullRequest: vi.fn().mockResolvedValue([
        makeTask({
          id: 'agent-task',
          type: 'agent',
          pullRequestId: '12',
          status: 'waiting',
        }),
      ]),
      updateTaskStatus: vi.fn(),
      markUserCompleted: vi.fn(),
      compactRawMessages: vi.fn(),
      emitTaskUpsert: vi.fn(),
    };

    await expect(
      completePrReviewTasksForMergedPr(
        { projectId: 'project-1', pullRequestId: 12 },
        deps,
      ),
    ).resolves.toEqual([]);

    expect(deps.updateTaskStatus).not.toHaveBeenCalled();
    expect(deps.markUserCompleted).not.toHaveBeenCalled();
    expect(deps.compactRawMessages).not.toHaveBeenCalled();
    expect(deps.emitTaskUpsert).not.toHaveBeenCalled();
  });

  it('skips already completed pr-review tasks', async () => {
    const deps = {
      findPrReviewTasksByPullRequest: vi.fn().mockResolvedValue([
        makeTask({
          id: 'review-task',
          status: 'completed',
          userCompleted: true,
        }),
      ]),
      updateTaskStatus: vi.fn(),
      markUserCompleted: vi.fn(),
      compactRawMessages: vi.fn(),
      emitTaskUpsert: vi.fn(),
    };

    await expect(
      completePrReviewTasksForMergedPr(
        { projectId: 'project-1', pullRequestId: 12 },
        deps,
      ),
    ).resolves.toEqual([]);

    expect(deps.updateTaskStatus).not.toHaveBeenCalled();
    expect(deps.markUserCompleted).not.toHaveBeenCalled();
    expect(deps.compactRawMessages).not.toHaveBeenCalled();
    expect(deps.emitTaskUpsert).not.toHaveBeenCalled();
  });

  it('updates status without re-running completion side effects when already user-completed', async () => {
    const updatedTask = makeTask({
      id: 'review-task',
      status: 'completed',
      userCompleted: true,
    });
    const deps = {
      findPrReviewTasksByPullRequest: vi.fn().mockResolvedValue([
        makeTask({
          id: 'review-task',
          status: 'waiting',
          userCompleted: true,
        }),
      ]),
      updateTaskStatus: vi.fn().mockResolvedValue(updatedTask),
      markUserCompleted: vi.fn(),
      compactRawMessages: vi.fn(),
      emitTaskUpsert: vi.fn(),
    };

    await expect(
      completePrReviewTasksForMergedPr(
        { projectId: 'project-1', pullRequestId: 12 },
        deps,
      ),
    ).resolves.toEqual([updatedTask]);

    expect(deps.updateTaskStatus).toHaveBeenCalledWith('review-task', {
      status: 'completed',
    });
    expect(deps.markUserCompleted).not.toHaveBeenCalled();
    expect(deps.compactRawMessages).not.toHaveBeenCalled();
    expect(deps.emitTaskUpsert).toHaveBeenCalledWith(updatedTask);
  });
});
