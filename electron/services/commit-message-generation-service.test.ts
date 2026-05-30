import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  generateTextMock,
  getWorktreeCommitLogMock,
  getWorktreeDiffMock,
  getWorktreeUnifiedDiffMock,
  resolveAiSkillSlotMock,
} = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  getWorktreeCommitLogMock: vi.fn(),
  getWorktreeDiffMock: vi.fn(),
  getWorktreeUnifiedDiffMock: vi.fn(),
  resolveAiSkillSlotMock: vi.fn(),
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
}));

import { generateMergeMessageForTask } from './commit-message-generation-service';

const task = {
  worktreePath: '/tmp/worktree',
  startCommitHash: 'abc123',
  sourceBranch: 'main',
  branchName: 'feature/test',
  projectId: 'project-1',
};

const project = {
  aiSkillSlots: {
    'merge-commit-message': {
      backend: 'opencode' as const,
      model: 'default',
      skillName: null,
    },
  },
};

describe('generateMergeMessageForTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAiSkillSlotMock.mockResolvedValue(
      project.aiSkillSlots['merge-commit-message'],
    );
    getWorktreeCommitLogMock.mockResolvedValue('abc123 test commit');
    getWorktreeDiffMock.mockResolvedValue({
      files: [{ path: 'file.ts', status: 'modified' }],
    });
    getWorktreeUnifiedDiffMock.mockResolvedValue(
      'diff --git a/file.ts b/file.ts',
    );
  });

  it('returns undefined when merge message generation is not configured', async () => {
    resolveAiSkillSlotMock.mockResolvedValue(undefined);

    await expect(
      generateMergeMessageForTask(task, project, 'main'),
    ).resolves.toBeUndefined();
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('formats a generated merge message', async () => {
    generateTextMock.mockResolvedValue({
      title: 'fix: abort failed ai merge messages',
      body: '- Stop fallback squash commits',
    });

    await expect(
      generateMergeMessageForTask(task, project, 'main'),
    ).resolves.toBe(
      'fix: abort failed ai merge messages\n\n- Stop fallback squash commits',
    );
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ throwOnError: true }),
    );
  });

  it('rejects when configured AI generation returns no valid message', async () => {
    generateTextMock.mockResolvedValue(null);

    await expect(
      generateMergeMessageForTask(task, project, 'main'),
    ).rejects.toThrow(
      'Failed to generate merge commit message: AI did not return a valid merge commit message',
    );
  });

  it('rejects when configured AI generation returns a blank title', async () => {
    generateTextMock.mockResolvedValue({
      title: '   ',
      body: '- Body without title',
    });

    await expect(
      generateMergeMessageForTask(task, project, 'main'),
    ).rejects.toThrow(
      'Failed to generate merge commit message: AI did not return a valid merge commit message',
    );
  });

  it('rejects when configured AI generation returns a blank body', async () => {
    generateTextMock.mockResolvedValue({
      title: 'fix: valid title',
      body: '   ',
    });

    await expect(
      generateMergeMessageForTask(task, project, 'main'),
    ).rejects.toThrow(
      'Failed to generate merge commit message: AI did not return a valid merge commit message',
    );
  });

  it('rejects when configured AI generation lacks diff context', async () => {
    await expect(
      generateMergeMessageForTask(
        { ...task, startCommitHash: null },
        project,
        'main',
      ),
    ).rejects.toThrow(
      'Failed to generate merge commit message: task is missing worktree diff context',
    );
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('rejects when configured AI generation has no changed files', async () => {
    getWorktreeDiffMock.mockResolvedValue({ files: [] });

    await expect(
      generateMergeMessageForTask(task, project, 'main'),
    ).rejects.toThrow(
      'Failed to generate merge commit message: task has no changed files for merge message generation',
    );
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('rejects with backend errors when configured AI generation fails', async () => {
    generateTextMock.mockRejectedValue(new Error('OpenCode session failed'));

    await expect(
      generateMergeMessageForTask(task, project, 'main'),
    ).rejects.toThrow(
      'Failed to generate merge commit message: OpenCode session failed',
    );
  });
});
