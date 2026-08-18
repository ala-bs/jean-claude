import { describe, expect, it } from 'vitest';

import {
  resolveTaskBranchName,
  validateTaskBranchRename,
  validateTaskSourceBranchChange,
} from './task-source-branch-validation';

const branches = [{ name: 'main' }, { name: 'develop' }];

const worktreeTask = {
  type: 'agent' as const,
  worktreePath: '/root/.jean-claude/worktrees/proj/my-task',
  branchName: 'jean-claude/my-task',
};

describe('resolveTaskBranchName', () => {
  it('prefers the stored branch name', () => {
    expect(resolveTaskBranchName(worktreeTask)).toBe('jean-claude/my-task');
  });

  it('derives the branch from the worktree path when missing', () => {
    expect(
      resolveTaskBranchName({ ...worktreeTask, branchName: null }),
    ).toBe('jean-claude/my-task');
  });

  it('returns null without a worktree', () => {
    expect(
      resolveTaskBranchName({ branchName: null, worktreePath: null }),
    ).toBeNull();
  });
});

describe('validateTaskSourceBranchChange', () => {
  it('accepts an existing branch', () => {
    expect(() =>
      validateTaskSourceBranchChange({
        task: worktreeTask,
        sourceBranch: 'develop',
        branches,
      }),
    ).not.toThrow();
  });

  it('rejects pr-review tasks', () => {
    expect(() =>
      validateTaskSourceBranchChange({
        task: { ...worktreeTask, type: 'pr-review' },
        sourceBranch: 'develop',
        branches,
      }),
    ).toThrow(/PR review tasks/);
  });

  it('rejects tasks without a worktree', () => {
    expect(() =>
      validateTaskSourceBranchChange({
        task: { ...worktreeTask, worktreePath: null },
        sourceBranch: 'develop',
        branches,
      }),
    ).toThrow(/worktree tasks/);
  });

  it('rejects the task branch itself, even when branchName is null', () => {
    expect(() =>
      validateTaskSourceBranchChange({
        task: { ...worktreeTask, branchName: null },
        sourceBranch: 'jean-claude/my-task',
        branches: [...branches, { name: 'jean-claude/my-task' }],
      }),
    ).toThrow(/task branch itself/);
  });

  it('rejects branches missing from the repository', () => {
    expect(() =>
      validateTaskSourceBranchChange({
        task: worktreeTask,
        sourceBranch: 'nope',
        branches,
      }),
    ).toThrow(/not found in repository/);
  });

  it('rejects blank branch names', () => {
    expect(() =>
      validateTaskSourceBranchChange({
        task: worktreeTask,
        sourceBranch: '  ',
        branches,
      }),
    ).toThrow(/required/);
  });
});

describe('validateTaskBranchRename', () => {
  const renamableTask = {
    ...worktreeTask,
    sourceBranch: 'main',
    status: 'completed' as const,
    pullRequestId: null,
  };

  it('rejects renaming a task that has a pull request', () => {
    expect(() =>
      validateTaskBranchRename({
        task: { ...renamableTask, pullRequestId: '42' },
        newBranch: 'feature/new',
        branches,
      }),
    ).toThrow(/pull request/);
  });

  it('rejects renaming while a session is running', () => {
    expect(() =>
      validateTaskBranchRename({
        task: { ...renamableTask, status: 'running' },
        newBranch: 'feature/new',
        branches,
      }),
    ).toThrow(/Stop the running session/);
  });

  it('returns the current branch for a valid rename', () => {
    expect(
      validateTaskBranchRename({
        task: renamableTask,
        newBranch: ' feature/new ',
        branches,
      }),
    ).toBe('jean-claude/my-task');
  });

  it('rejects pr-review tasks', () => {
    expect(() =>
      validateTaskBranchRename({
        task: { ...renamableTask, type: 'pr-review' },
        newBranch: 'feature/new',
        branches,
      }),
    ).toThrow(/cannot rename/);
  });

  it('rejects blank, unchanged, source, and existing branch names', () => {
    const cases: [string, RegExp][] = [
      ['  ', /required/],
      ['jean-claude/my-task', /unchanged/],
      ['main', /source branch/],
      ['develop', /already exists/],
    ];
    for (const [newBranch, matcher] of cases) {
      expect(() =>
        validateTaskBranchRename({ task: renamableTask, newBranch, branches }),
      ).toThrow(matcher);
    }
  });

  it('rejects tasks without a worktree', () => {
    expect(() =>
      validateTaskBranchRename({
        task: { ...renamableTask, worktreePath: null, branchName: null },
        newBranch: 'feature/new',
        branches,
      }),
    ).toThrow(/Only worktree tasks/);
  });
});
