import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';

import {
  deleteAttachmentFile,
  isManagedAttachmentPath,
} from './attachment-file-deletion';

const PROJECT = path.resolve('/tmp/project');
const managed = (name: string) =>
  path.join(PROJECT, '.jean-claude', 'tmp', name);

describe('isManagedAttachmentPath', () => {
  it('accepts files inside the managed tmp dir', () => {
    expect(
      isManagedAttachmentPath({
        projectPath: PROJECT,
        filePath: managed('ab12cd34-pasted-content.md'),
      }),
    ).toBe(true);
  });

  it("refuses a user's original file attached by path", () => {
    expect(
      isManagedAttachmentPath({
        projectPath: PROJECT,
        filePath: path.resolve('/Users/someone/Desktop/huge.zip'),
      }),
    ).toBe(false);
  });

  it('refuses traversal out of the tmp dir', () => {
    expect(
      isManagedAttachmentPath({
        projectPath: PROJECT,
        filePath: managed('../../../.git/config'),
      }),
    ).toBe(false);
  });

  it('refuses project files outside tmp', () => {
    expect(
      isManagedAttachmentPath({
        projectPath: PROJECT,
        filePath: path.join(PROJECT, 'src/index.ts'),
      }),
    ).toBe(false);
  });

  it('refuses the tmp dir itself', () => {
    expect(
      isManagedAttachmentPath({
        projectPath: PROJECT,
        filePath: path.join(PROJECT, '.jean-claude', 'tmp'),
      }),
    ).toBe(false);
  });

  it('refuses a sibling dir with the same prefix', () => {
    expect(
      isManagedAttachmentPath({
        projectPath: PROJECT,
        filePath: path.join(PROJECT, '.jean-claude', 'tmpdata', 'x.md'),
      }),
    ).toBe(false);
  });

  it('refuses empty paths', () => {
    expect(
      isManagedAttachmentPath({ projectPath: '', filePath: managed('a.md') }),
    ).toBe(false);
    expect(
      isManagedAttachmentPath({ projectPath: PROJECT, filePath: '' }),
    ).toBe(false);
  });
});

describe('deleteAttachmentFile', () => {
  it('unlinks a managed file', async () => {
    const unlink = vi.fn(async () => {});
    const target = managed('ab12cd34-notes.md');

    await expect(
      deleteAttachmentFile({
        projectPath: PROJECT,
        filePath: target,
        unlink,
      }),
    ).resolves.toBe(true);
    expect(unlink).toHaveBeenCalledWith(target);
  });

  it('never unlinks a path outside the managed dir', async () => {
    const unlink = vi.fn(async () => {});

    await expect(
      deleteAttachmentFile({
        projectPath: PROJECT,
        filePath: path.resolve('/Users/someone/Desktop/huge.zip'),
        unlink,
      }),
    ).resolves.toBe(false);
    expect(unlink).not.toHaveBeenCalled();
  });

  it('treats an already-missing file as success', async () => {
    const unlink = vi.fn(async () => {
      const err = new Error('missing') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    await expect(
      deleteAttachmentFile({
        projectPath: PROJECT,
        filePath: managed('gone.md'),
        unlink,
      }),
    ).resolves.toBe(true);
  });

  it('reports failure for other unlink errors', async () => {
    const unlink = vi.fn(async () => {
      const err = new Error('denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    });

    await expect(
      deleteAttachmentFile({
        projectPath: PROJECT,
        filePath: managed('locked.md'),
        unlink,
      }),
    ).resolves.toBe(false);
  });
});
