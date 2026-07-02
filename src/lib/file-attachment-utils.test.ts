import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_FILE_ATTACHMENT_SIZE,
  MAX_INLINE_PASTED_PROMPT_LENGTH,
  PASTED_PROMPT_ATTACHMENT_FILENAME,
  processAttachmentFile,
  processAttachmentPath,
  processPastedPromptAttachment,
  shouldAttachPastedPromptContent,
} from './file-attachment-utils';

function stubFsApi(overrides: {
  getPathForFile?: (file: File) => string | null;
  getFileSize?: (filePath: string) => Promise<number | null>;
  copyAttachmentFile?: (
    projectPath: string,
    sourcePath: string,
  ) => Promise<{ filePath: string; filename: string }>;
  writeAttachmentFile?: (
    projectPath: string,
    filename: string,
    content: string,
    encoding?: 'utf-8' | 'base64',
  ) => Promise<string>;
}) {
  vi.stubGlobal('window', {
    api: {
      fs: {
        getPathForFile: overrides.getPathForFile ?? (() => null),
        getFileSize: overrides.getFileSize ?? (async () => null),
        copyAttachmentFile:
          overrides.copyAttachmentFile ??
          (async () => ({ filePath: '', filename: '' })),
        writeAttachmentFile: overrides.writeAttachmentFile ?? (async () => ''),
      },
    },
  });
}

describe('processAttachmentFile', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attaches oversized files by original path without copying', async () => {
    const copyAttachmentFile = vi.fn();
    stubFsApi({
      getPathForFile: () => '/Users/patrick/Downloads/large.zip',
      copyAttachmentFile,
    });
    const onAttach = vi.fn();
    const onError = vi.fn();
    const file = {
      name: 'large.zip',
      size: MAX_FILE_ATTACHMENT_SIZE + 1,
    } as File;

    await processAttachmentFile(file, '/repo', onAttach, onError);

    expect(onAttach).toHaveBeenCalledWith({
      type: 'file',
      filePath: '/Users/patrick/Downloads/large.zip',
      filename: 'large.zip',
    });
    expect(copyAttachmentFile).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('uses Electron webUtils path for normal path-backed copy', async () => {
    const copyAttachmentFile = vi.fn(async () => ({
      filePath: '/repo/.jean-claude/tmp/abc-small.txt',
      filename: 'small.txt',
    }));
    stubFsApi({
      getPathForFile: () => '/Users/patrick/Downloads/small.txt',
      copyAttachmentFile,
    });
    const onAttach = vi.fn();

    await processAttachmentFile(
      { name: 'small.txt', size: 1024 } as File,
      '/repo',
      onAttach,
    );

    expect(copyAttachmentFile).toHaveBeenCalledWith(
      '/repo',
      '/Users/patrick/Downloads/small.txt',
    );
    expect(onAttach).toHaveBeenCalledWith({
      type: 'file',
      filePath: '/repo/.jean-claude/tmp/abc-small.txt',
      filename: 'small.txt',
    });
  });

  it('copies main-process picker paths directly', async () => {
    const copyAttachmentFile = vi.fn(async () => ({
      filePath: '/repo/.jean-claude/tmp/abc-picked.txt',
      filename: 'picked.txt',
    }));
    stubFsApi({ copyAttachmentFile });
    const onAttach = vi.fn();

    await processAttachmentPath(
      '/Users/patrick/Downloads/picked.txt',
      '/repo',
      onAttach,
    );

    expect(copyAttachmentFile).toHaveBeenCalledWith(
      '/repo',
      '/Users/patrick/Downloads/picked.txt',
    );
    expect(onAttach).toHaveBeenCalledWith({
      type: 'file',
      filePath: '/repo/.jean-claude/tmp/abc-picked.txt',
      filename: 'picked.txt',
    });
  });

  it('attaches oversized picker paths without copying', async () => {
    const copyAttachmentFile = vi.fn();
    stubFsApi({
      getFileSize: async () => MAX_FILE_ATTACHMENT_SIZE + 1,
      copyAttachmentFile,
    });
    const onAttach = vi.fn();

    await processAttachmentPath(
      '/Users/patrick/Downloads/large.zip',
      '/repo',
      onAttach,
    );

    expect(copyAttachmentFile).not.toHaveBeenCalled();
    expect(onAttach).toHaveBeenCalledWith({
      type: 'file',
      filePath: '/Users/patrick/Downloads/large.zip',
      filename: 'large.zip',
    });
  });

  it('detects pasted content that should become a file attachment', () => {
    expect(
      shouldAttachPastedPromptContent(
        'x'.repeat(MAX_INLINE_PASTED_PROMPT_LENGTH),
      ),
    ).toBe(false);
    expect(
      shouldAttachPastedPromptContent(
        'x'.repeat(MAX_INLINE_PASTED_PROMPT_LENGTH + 1),
      ),
    ).toBe(true);
  });

  it('writes long pasted content as an attachment file', async () => {
    const writeAttachmentFile = vi.fn(async () =>
      '/repo/.jean-claude/tmp/abc-pasted-content.md',
    );
    stubFsApi({ writeAttachmentFile });
    const onAttach = vi.fn();

    await processPastedPromptAttachment('long paste', '/repo', onAttach);

    expect(writeAttachmentFile).toHaveBeenCalledWith(
      '/repo',
      PASTED_PROMPT_ATTACHMENT_FILENAME,
      'long paste',
    );
    expect(onAttach).toHaveBeenCalledWith({
      type: 'file',
      filePath: '/repo/.jean-claude/tmp/abc-pasted-content.md',
      filename: PASTED_PROMPT_ATTACHMENT_FILENAME,
    });
  });

  it('rejects pasted content over the attachment size limit', async () => {
    const writeAttachmentFile = vi.fn();
    stubFsApi({ writeAttachmentFile });
    const onAttach = vi.fn();
    const onError = vi.fn();

    await processPastedPromptAttachment(
      'x'.repeat(MAX_FILE_ATTACHMENT_SIZE + 1),
      '/repo',
      onAttach,
      onError,
    );

    expect(writeAttachmentFile).not.toHaveBeenCalled();
    expect(onAttach).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      'Pasted content too large (50.0 MB, max 50 MB)',
    );
  });
});
