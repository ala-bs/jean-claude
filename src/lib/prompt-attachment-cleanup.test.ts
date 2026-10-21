// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteRelocatedAttachmentFiles } from './prompt-attachment-cleanup';

const deleteAttachmentFile = vi.fn().mockResolvedValue(undefined);

describe('deleteRelocatedAttachmentFiles', () => {
  beforeEach(() => {
    deleteAttachmentFile.mockClear();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { fs: { deleteAttachmentFile } },
    });
  });

  it('deletes a source only when the created worktree task no longer references it', async () => {
    await deleteRelocatedAttachmentFiles({
      projectPath: '/project',
      worktreePath: '/worktree',
      prompt: '<file name="moved" path="/worktree/moved" /><file name="kept" path="/project/kept" />',
      files: [
        { type: 'file', filename: 'moved', filePath: '/project/moved' },
        { type: 'file', filename: 'kept', filePath: '/project/kept' },
      ],
    });

    expect(deleteAttachmentFile).toHaveBeenCalledExactlyOnceWith(
      '/project',
      '/project/moved',
    );
  });

  it('retains the source for a task without a worktree', async () => {
    await deleteRelocatedAttachmentFiles({
      projectPath: '/project',
      worktreePath: null,
      prompt: '',
      files: [{ type: 'file', filename: 'file', filePath: '/project/file' }],
    });

    expect(deleteAttachmentFile).not.toHaveBeenCalled();
  });
});
