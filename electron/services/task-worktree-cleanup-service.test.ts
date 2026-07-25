import { describe, expect, it, vi } from 'vitest';

import type { Task } from '@shared/types';

import {
  cleanupPrWorkspaceGitForDeletion,
  cleanupTaskForDeletion,
  cleanupTaskWorktree,
  completeTaskWithWorktreeCleanup,
  ensureTaskCommandsStopped,
  shouldUsePrReviewWorkspaceCleanup,
} from './task-worktree-cleanup-service';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    type: 'agent',
    name: 'Task',
    prompt: 'Task',
    status: 'waiting',
    worktreePath: '/repo/.worktrees/task-1',
    startCommitHash: 'abc',
    sourceBranch: 'main',
    branchName: 'task-1',
    prWorkspaceState: null,
    hasUnread: false,
    userCompleted: false,
    workItemIds: null,
    workItemUrls: null,
    pullRequestId: null,
    pullRequestUrl: null,
    pendingMessage: null,
    todoItems: [],
    parentTaskId: null,
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
    ...overrides,
  };
}

describe('shouldUsePrReviewWorkspaceCleanup', () => {
  it('requires both PR review type and pull request identity', () => {
    expect(
      shouldUsePrReviewWorkspaceCleanup(
        makeTask({ type: 'pr-review', pullRequestId: '12' }),
      ),
    ).toBe(true);
    expect(
      shouldUsePrReviewWorkspaceCleanup(
        makeTask({ type: 'pr-review', pullRequestId: null }),
      ),
    ).toBe(false);
    expect(
      shouldUsePrReviewWorkspaceCleanup(
        makeTask({ type: 'agent', pullRequestId: '12' }),
      ),
    ).toBe(false);
  });
});

describe('cleanupTaskWorktree', () => {
  it('stops commands before closing editors and deleting worktree', async () => {
    const order: string[] = [];
    const task = makeTask();
    const deps = {
      stopCommandsForTask: vi.fn(async () => {
        order.push('stop');
      }),
      pathExists: vi.fn().mockResolvedValue(true),
      closeEditorWindowsForTaskWorktree: vi.fn(async () => {
        order.push('close');
        return undefined;
      }),
      cleanupWorktree: vi.fn(async () => {
        order.push('cleanup');
      }),
      cleanupMissingWorktree: vi.fn(),
      clearWorktreeMetadata: vi.fn(async () => {
        order.push('clear');
      }),
    };

    await cleanupTaskWorktree(
      {
        task: { ...task, worktreePath: task.worktreePath! },
        projectPath: '/repo',
        keepBranch: false,
      },
      deps,
    );

    expect(order).toEqual(['stop', 'close', 'cleanup', 'clear']);
    expect(deps.cleanupWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ force: true, branchCleanup: 'delete' }),
    );
  });

  it('preserves worktree and metadata when a command fails to stop', async () => {
    const task = makeTask();
    const deps = {
      stopCommandsForTask: vi.fn().mockResolvedValue(false),
      pathExists: vi.fn(),
      closeEditorWindowsForTaskWorktree: vi.fn(),
      cleanupWorktree: vi.fn(),
      cleanupMissingWorktree: vi.fn(),
      clearWorktreeMetadata: vi.fn(),
    };

    await expect(
      cleanupTaskWorktree(
        {
          task: { ...task, worktreePath: task.worktreePath! },
          projectPath: '/repo',
          keepBranch: false,
        },
        deps,
      ),
    ).rejects.toThrow('stop');
    expect(deps.pathExists).not.toHaveBeenCalled();
    expect(deps.closeEditorWindowsForTaskWorktree).not.toHaveBeenCalled();
    expect(deps.cleanupWorktree).not.toHaveBeenCalled();
    expect(deps.clearWorktreeMetadata).not.toHaveBeenCalled();
  });

  it('persists verified identity before removal and uses it for branch retry', async () => {
    const task = makeTask();
    let verified:
      | { worktreePath: string; branchName: string }
      | undefined;
    const deps = {
      stopCommandsForTask: vi.fn().mockResolvedValue(true),
      pathExists: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      closeEditorWindowsForTaskWorktree: vi.fn(),
      cleanupWorktree: vi.fn(async (params) => {
        await params.onVerified?.();
        throw new Error('branch delete failed');
      }),
      cleanupMissingWorktree: vi.fn(),
      clearWorktreeMetadata: vi.fn(),
      getVerifiedCleanupIdentity: vi.fn(async () => verified),
      markCleanupIdentityVerified: vi.fn(async (_id, identity) => {
        verified = identity;
      }),
      clearCleanupIdentity: vi.fn(),
    };
    const params = {
      task: { ...task, worktreePath: task.worktreePath! },
      projectPath: '/repo',
      keepBranch: false,
    };

    await expect(cleanupTaskWorktree(params, deps)).rejects.toThrow(
      'branch delete failed',
    );
    expect(verified).toEqual({
      worktreePath: task.worktreePath,
      branchName: task.branchName,
    });
    await cleanupTaskWorktree(params, deps);

    expect(deps.cleanupMissingWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: task.worktreePath,
        branchName: task.branchName,
        allowUnregistered: true,
      }),
    );
    expect(deps.clearWorktreeMetadata).toHaveBeenCalledTimes(1);
    expect(deps.clearCleanupIdentity).toHaveBeenCalledWith(task.id);
  });
});

describe('destructive task cleanup', () => {
  it('clears metadata only after verified PR Git cleanup succeeds', async () => {
    const task = makeTask({ type: 'pr-review', pullRequestId: '12' });
    const clearedTask = makeTask({
      ...task,
      worktreePath: null,
      branchName: null,
      startCommitHash: null,
      sourceBranch: null,
    });
    const deps = {
      pathExists: vi.fn().mockResolvedValue(true),
      cleanupWorktree: vi.fn(async (params) => params.onVerified?.()),
      cleanupMissingWorktree: vi.fn(),
      clearWorktreeMetadata: vi.fn().mockResolvedValue(clearedTask),
      getVerifiedCleanupIdentity: vi.fn(),
      markCleanupIdentityVerified: vi.fn(),
      clearCleanupIdentity: vi.fn(),
    };

    await expect(
      cleanupPrWorkspaceGitForDeletion({ task, projectPath: '/repo' }, deps),
    ).resolves.toEqual({ task: clearedTask, changed: true });
    expect(deps.markCleanupIdentityVerified).toHaveBeenCalledWith(task.id, {
      worktreePath: task.worktreePath,
      branchName: task.branchName,
    });
    expect(deps.clearWorktreeMetadata).toHaveBeenCalledWith(task.id, {
      worktreePath: null,
      branchName: null,
      startCommitHash: null,
      sourceBranch: null,
    });
    expect(deps.clearCleanupIdentity).toHaveBeenCalledWith(task.id);
  });

  it('retains cleanup identity and metadata when PR branch deletion fails', async () => {
    const task = makeTask({ type: 'pr-review', pullRequestId: '12' });
    const deps = {
      pathExists: vi.fn().mockResolvedValue(true),
      cleanupWorktree: vi.fn(async (params) => {
        await params.onVerified?.();
        throw new Error('branch delete failed');
      }),
      cleanupMissingWorktree: vi.fn(),
      clearWorktreeMetadata: vi.fn(),
      getVerifiedCleanupIdentity: vi.fn(),
      markCleanupIdentityVerified: vi.fn(),
      clearCleanupIdentity: vi.fn(),
    };

    await expect(
      cleanupPrWorkspaceGitForDeletion({ task, projectPath: '/repo' }, deps),
    ).rejects.toThrow('branch delete failed');
    expect(deps.markCleanupIdentityVerified).toHaveBeenCalled();
    expect(deps.clearWorktreeMetadata).not.toHaveBeenCalled();
    expect(deps.clearCleanupIdentity).not.toHaveBeenCalled();
  });

  it('aborts before destructive action when commands fail to stop', async () => {
    const action = vi.fn();
    await expect(
      ensureTaskCommandsStopped('task-1', vi.fn().mockResolvedValue(false)),
    ).rejects.toThrow('stop');
    expect(action).not.toHaveBeenCalled();
  });

  it('passes authoritative branch for forced task deletion cleanup', async () => {
    const task = makeTask();
    const deps = {
      stopCommandsForTask: vi.fn().mockResolvedValue(true),
      pathExists: vi.fn().mockResolvedValue(true),
      closeEditorWindowsForTaskWorktree: vi.fn(),
      cleanupWorktree: vi.fn(),
      cleanupMissingWorktree: vi.fn(),
    };

    await cleanupTaskForDeletion(
      { task, projectPath: '/repo', force: true },
      deps,
    );

    expect(deps.cleanupWorktree).toHaveBeenCalledWith({
      worktreePath: task.worktreePath,
      projectPath: '/repo',
      branchName: task.branchName,
      skipIfChanges: false,
      branchCleanup: 'delete',
      force: true,
    });
  });

  it('does not close or delete when task commands fail to stop', async () => {
    const task = makeTask();
    const deps = {
      stopCommandsForTask: vi.fn().mockResolvedValue(false),
      pathExists: vi.fn(),
      closeEditorWindowsForTaskWorktree: vi.fn(),
      cleanupWorktree: vi.fn(),
      cleanupMissingWorktree: vi.fn(),
    };

    await expect(
      cleanupTaskForDeletion(
        { task, projectPath: '/repo', force: true },
        deps,
      ),
    ).rejects.toThrow('stop');
    expect(deps.closeEditorWindowsForTaskWorktree).not.toHaveBeenCalled();
    expect(deps.cleanupWorktree).not.toHaveBeenCalled();
  });

  it('cleans verified stale registration when worktree directory is missing', async () => {
    const task = makeTask();
    const deps = {
      stopCommandsForTask: vi.fn().mockResolvedValue(true),
      pathExists: vi.fn().mockResolvedValue(false),
      closeEditorWindowsForTaskWorktree: vi.fn(),
      cleanupWorktree: vi.fn(),
      cleanupMissingWorktree: vi.fn(),
    };

    await cleanupTaskForDeletion(
      { task, projectPath: '/repo', force: true },
      deps,
    );

    expect(deps.cleanupWorktree).not.toHaveBeenCalled();
    expect(deps.cleanupMissingWorktree).toHaveBeenCalledWith({
      worktreePath: task.worktreePath,
      projectPath: '/repo',
      branchName: task.branchName,
      throwOnError: true,
      allowUnregistered: false,
    });
  });
});

describe('completeTaskWithWorktreeCleanup', () => {
  function makeDeps() {
    return {
      stopCommandsForTask: vi.fn().mockResolvedValue(true),
      closeEditorWindowsForTaskWorktree: vi.fn(),
      cleanupPrReviewWorkspace: vi.fn(),
      cleanupTaskWorktree: vi.fn(),
      markUserCompleted: vi.fn(async (id: string) =>
        makeTask({ id, userCompleted: true }),
      ),
      clearWorktreeMetadata: vi.fn(async (id: string) =>
        makeTask({
          id,
          userCompleted: true,
          worktreePath: null,
          branchName: null,
          startCommitHash: null,
          sourceBranch: null,
        }),
      ),
      cleanupFeatureMapTempDirs: vi.fn(),
      compactRawMessages: vi.fn(),
      emitTaskUpsert: vi.fn(),
    };
  }

  it('cleans PR workspace before marking task completed', async () => {
    const task = makeTask({ type: 'pr-review', pullRequestId: '12' });
    const clearedTask = makeTask({
      ...task,
      worktreePath: null,
      branchName: null,
      startCommitHash: null,
      sourceBranch: null,
    });
    const completedTask = makeTask({
      ...clearedTask,
      userCompleted: true,
    });
    const order: string[] = [];
    const deps = makeDeps();
    deps.cleanupPrReviewWorkspace.mockImplementation(async () => {
      order.push('cleanup');
      return { task: clearedTask, changed: true };
    });
    deps.markUserCompleted.mockImplementation(async () => {
      order.push('complete');
      return completedTask;
    });

    await expect(
      completeTaskWithWorktreeCleanup(
        { task, cleanupWorktree: true },
        deps,
      ),
    ).resolves.toEqual({ task: completedTask });
    expect(order).toEqual(['cleanup', 'complete']);
    expect(deps.clearWorktreeMetadata).not.toHaveBeenCalled();
  });

  it('keeps PR task retryable when synchronous cleanup fails', async () => {
    const task = makeTask({ type: 'pr-review', pullRequestId: '12' });
    const deps = makeDeps();
    deps.cleanupPrReviewWorkspace.mockRejectedValue(new Error('branch mismatch'));

    await expect(
      completeTaskWithWorktreeCleanup(
        { task, cleanupWorktree: true },
        deps,
      ),
    ).rejects.toThrow('branch mismatch');
    expect(task.userCompleted).toBe(false);
    expect(task.worktreePath).toBe('/repo/.worktrees/task-1');
    expect(task.branchName).toBe('task-1');
    expect(deps.markUserCompleted).not.toHaveBeenCalled();
    expect(deps.clearWorktreeMetadata).not.toHaveBeenCalled();
    expect(deps.emitTaskUpsert).not.toHaveBeenCalled();
  });

  it('cleans generic task worktree in the backend before clearing metadata', async () => {
    const task = makeTask();
    const clearedTask = makeTask({
      userCompleted: false,
      worktreePath: null,
      branchName: null,
      startCommitHash: null,
      sourceBranch: null,
    });
    const deps = makeDeps();
    deps.cleanupTaskWorktree = vi.fn().mockResolvedValue({ task: clearedTask });
    deps.markUserCompleted.mockResolvedValue(
      makeTask({
        userCompleted: true,
        worktreePath: null,
        branchName: null,
        startCommitHash: null,
        sourceBranch: null,
      }),
    );

    await expect(
      completeTaskWithWorktreeCleanup(
        { task, cleanupWorktree: true },
        deps,
      ),
    ).resolves.toEqual({
      task: expect.objectContaining({ userCompleted: true }),
    });
    expect(deps.cleanupPrReviewWorkspace).not.toHaveBeenCalled();
    expect(deps.cleanupTaskWorktree).toHaveBeenCalledWith(task);
  });
});
