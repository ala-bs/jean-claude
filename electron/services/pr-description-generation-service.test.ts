import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  generateTextMock,
  getWorktreeCommitLogMock,
  getWorktreeDiffMock,
  getWorktreeUnifiedDiffMock,
  resolveAiSkillSlotMock,
  getDiffBaseInfoMock,
} = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  getWorktreeCommitLogMock: vi.fn(),
  getWorktreeDiffMock: vi.fn(),
  getWorktreeUnifiedDiffMock: vi.fn(),
  resolveAiSkillSlotMock: vi.fn(),
  getDiffBaseInfoMock: vi.fn(),
}));

vi.mock('./ai-generation-service', () => ({
  generateText: generateTextMock,
}));

vi.mock('./ai-skill-slot-resolver', () => ({
  resolveAiSkillSlot: resolveAiSkillSlotMock,
}));

vi.mock('./worktree-service', () => ({
  getWorktreeCommitLog: getWorktreeCommitLogMock,
  getWorktreeDiff: getWorktreeDiffMock,
  getWorktreeUnifiedDiff: getWorktreeUnifiedDiffMock,
  getDiffBaseInfo: getDiffBaseInfoMock,
}));

import { generatePrDescriptionForTask } from './pr-description-generation-service';

const task = {
  worktreePath: '/tmp/worktree',
  startCommitHash: 'abc123',
  sourceBranch: 'main',
  branchName: 'feature/test',
  projectId: 'project-1',
  prompt: 'Fix PR creation fallback',
  workItemIds: ['123'],
};

const project = {
  aiSkillSlots: {
    'pr-description': {
      backend: 'opencode' as const,
      model: 'default',
      skillName: null,
    },
  },
  defaultBranch: 'main',
};

describe('generatePrDescriptionForTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAiSkillSlotMock.mockResolvedValue(
      project.aiSkillSlots['pr-description'],
    );
    getWorktreeCommitLogMock.mockResolvedValue('abc123 test commit');
    getWorktreeDiffMock.mockResolvedValue({
      files: [{ path: 'file.ts', status: 'modified' }],
    });
    getWorktreeUnifiedDiffMock.mockResolvedValue(
      'diff --git a/file.ts b/file.ts',
    );
    getDiffBaseInfoMock.mockResolvedValue({
      baseCommit: 'base1234',
      sourceRef: 'refs/remotes/origin/main',
      headCommit: 'head5678',
      headIsMergedIntoSource: false,
    });
  });

  it('returns undefined when PR description generation is not configured', async () => {
    resolveAiSkillSlotMock.mockResolvedValue(undefined);

    await expect(
      generatePrDescriptionForTask(task, project),
    ).resolves.toBeUndefined();
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('returns a generated PR title and description', async () => {
    generateTextMock.mockResolvedValue({
      title: 'fix: abort failed ai pr creation',
      description: '## What I Did\n- Stop fallback PR titles',
    });

    await expect(generatePrDescriptionForTask(task, project)).resolves.toEqual({
      title: 'fix: abort failed ai pr creation',
      description: '## What I Did\n- Stop fallback PR titles',
    });
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ throwOnError: true }),
    );
  });

  it('rejects when configured AI generation returns no valid PR content', async () => {
    generateTextMock.mockResolvedValue(null);

    await expect(generatePrDescriptionForTask(task, project)).rejects.toThrow(
      'Failed to generate PR title and description: AI did not return a valid PR title and description',
    );
  });

  it('rejects when configured AI generation returns blank PR content', async () => {
    generateTextMock.mockResolvedValue({
      title: '   ',
      description: '   ',
    });

    await expect(generatePrDescriptionForTask(task, project)).rejects.toThrow(
      'Failed to generate PR title and description: AI did not return a valid PR title and description',
    );
  });

  it('rejects when configured AI generation lacks diff context', async () => {
    await expect(
      generatePrDescriptionForTask({ ...task, startCommitHash: null }, project),
    ).rejects.toThrow(
      'Failed to generate PR title and description: task is missing worktree diff context',
    );
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('still generates when the file list is empty but a real diff exists', async () => {
    getWorktreeDiffMock.mockResolvedValue({ files: [] });
    generateTextMock.mockResolvedValue({
      title: 'fix: something',
      description: 'body',
    });

    await expect(generatePrDescriptionForTask(task, project)).resolves.toEqual({
      title: 'fix: something',
      description: 'body',
    });
  });

  it('does not generate from merged-in source commits when the diff is empty', async () => {
    // Classic merge artifact: the branch merged main, so the commit log is full
    // of main's commits while the branch itself changed nothing.
    getWorktreeDiffMock.mockResolvedValue({ files: [] });
    getWorktreeUnifiedDiffMock.mockResolvedValue('');
    getWorktreeCommitLogMock.mockResolvedValue(
      'aaa1111 someone else commit\nbbb2222 another main commit',
    );

    await expect(generatePrDescriptionForTask(task, project)).rejects.toThrow(
      'no changed files or diff found',
    );
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('rejects with a merged-branch explanation when nothing differs from the target', async () => {
    getWorktreeDiffMock.mockResolvedValue({ files: [] });
    getWorktreeCommitLogMock.mockResolvedValue('');
    getWorktreeUnifiedDiffMock.mockResolvedValue('');
    getDiffBaseInfoMock.mockResolvedValue({
      baseCommit: 'head5678',
      sourceRef: 'refs/remotes/origin/main',
      headCommit: 'head5678',
      headIsMergedIntoSource: true,
    });

    await expect(generatePrDescriptionForTask(task, project)).rejects.toThrow(
      'branch feature/test has no changes relative to main',
    );
    await expect(generatePrDescriptionForTask(task, project)).rejects.toThrow(
      'is already contained in origin/main',
    );
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('rejects when the worktree is gone', async () => {
    getWorktreeDiffMock.mockResolvedValue({
      files: [],
      worktreeDeleted: true,
    });
    getWorktreeCommitLogMock.mockResolvedValue('');
    getWorktreeUnifiedDiffMock.mockResolvedValue('');

    await expect(generatePrDescriptionForTask(task, project)).rejects.toThrow(
      'no longer exists',
    );
  });

  it('rejects with backend errors when configured AI generation fails', async () => {
    generateTextMock.mockRejectedValue(new Error('OpenCode session failed'));

    await expect(generatePrDescriptionForTask(task, project)).rejects.toThrow(
      'Failed to generate PR title and description: OpenCode session failed',
    );
  });
});
