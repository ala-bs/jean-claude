import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addCommentMock,
  addFileCommentMock,
  addReplyMock,
  captureMock,
  captureEnabledMock,
  commitFileContentMock,
  fileContentMock,
  findProjectMock,
  reportFailureMock,
  threadsMock,
} = vi.hoisted(() => ({
  addCommentMock: vi.fn(),
  addFileCommentMock: vi.fn(),
  addReplyMock: vi.fn(),
  captureMock: vi.fn(),
  captureEnabledMock: vi.fn(),
  commitFileContentMock: vi.fn(),
  fileContentMock: vi.fn(),
  findProjectMock: vi.fn(),
  reportFailureMock: vi.fn(),
  threadsMock: vi.fn(),
}));

vi.mock('../database/repositories', () => ({
  ProjectRepository: { findById: findProjectMock },
}));
vi.mock('./azure-devops-service', () => ({
  addPullRequestComment: addCommentMock,
  addPullRequestFileComment: addFileCommentMock,
  addThreadReply: addReplyMock,
  getFileContentAtCommit: commitFileContentMock,
  getPullRequestFileContent: fileContentMock,
  getPullRequestThreads: threadsMock,
}));
vi.mock('./agent-memory-capture-service', () => ({
  captureAgentMemoryEventSafe: captureMock,
  isAgentMemoryCaptureEnabled: captureEnabledMock,
  reportAgentMemoryCaptureFailure: reportFailureMock,
}));

import {
  addPullRequestCommentWithAgentMemory,
  addPullRequestFileCommentWithAgentMemory,
  addThreadReplyWithAgentMemory,
  stripPullRequestEvidenceArtifacts,
} from './pr-agent-memory-capture-service';

const repository = {
  localProjectId: 'local-project-1',
  providerId: 'provider-1',
  projectId: 'azure-project-1',
  repoId: 'repo-1',
  pullRequestId: 42,
};
const author = {
  id: 'user-1',
  displayName: 'User',
  uniqueName: 'user@example.com',
};
const comment = (id: number, content: string) => ({
  id,
  content,
  commentType: 'text' as const,
  author,
  usersLiked: [],
  publishedDate: '2026-07-18T12:00:00.000Z',
  lastUpdatedDate: '2026-07-18T12:00:00.000Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  findProjectMock.mockResolvedValue({
    id: repository.localProjectId,
    repoProviderId: repository.providerId,
    repoProjectId: repository.projectId,
    repoId: repository.repoId,
  });
  captureMock.mockResolvedValue(undefined);
  captureEnabledMock.mockResolvedValue(true);
  reportFailureMock.mockReturnValue(undefined);
});

describe('local PR Agent Memory posting boundary', () => {
  it('captures only after Azure succeeds using returned provider IDs', async () => {
    let resolvePost!: (value: unknown) => void;
    addCommentMock.mockReturnValue(
      new Promise((resolve) => {
        resolvePost = resolve;
      }),
    );
    const posted = addPullRequestCommentWithAgentMemory({
      ...repository,
      content: 'Keep this API stable',
    });

    expect(captureMock).not.toHaveBeenCalled();
    resolvePost({
      id: 73,
      status: 'active',
      comments: [comment(11, 'Keep this API stable')],
    });
    await posted;

    await vi.waitFor(() =>
      expect(captureMock).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'pr-comment',
          sourceId:
            'pr-comment:provider-1:azure-project-1:repo-1:42:73:11',
          projectId: 'local-project-1',
          text: 'Keep this API stable',
        }),
      ),
    );

    addCommentMock.mockRejectedValueOnce(new Error('Azure rejected post'));
    await expect(
      addPullRequestCommentWithAgentMemory({
        ...repository,
        content: 'Not posted',
      }),
    ).rejects.toThrow('Azure rejected post');
    expect(captureMock).toHaveBeenCalledTimes(1);
  });

  it('derives exact selected file lines from provider context, not renderer text', async () => {
    const returnedThread = {
      id: 74,
      status: 'active',
      threadContext: {
        filePath: '/src/app.ts',
        rightFileStart: { line: 2 },
        rightFileEnd: { line: 4 },
      },
      comments: [comment(12, 'Prefer explicit naming')],
    };
    addFileCommentMock.mockResolvedValue(returnedThread);
    threadsMock.mockResolvedValue([returnedThread]);
    fileContentMock.mockResolvedValue('first\nsecond\nthird\nfourth\nfifth');

    await addPullRequestFileCommentWithAgentMemory({
      ...repository,
      filePath: 'renderer/lie.ts',
      line: 99,
      lineEnd: 100,
      selectedLines: 'renderer supplied unrelated text',
      content: 'Prefer explicit naming',
    });

    await vi.waitFor(() =>
      expect(threadsMock).toHaveBeenCalledWith(expect.objectContaining(repository)),
    );
    await vi.waitFor(() =>
      expect(fileContentMock).toHaveBeenCalledWith({
        providerId: 'provider-1',
        projectId: 'azure-project-1',
        repoId: 'repo-1',
        pullRequestId: 42,
        filePath: '/src/app.ts',
        version: 'head',
      }),
    );
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId:
          'pr-comment:provider-1:azure-project-1:repo-1:42:74:12',
        context: {
          pullRequestId: '42',
          filePath: '/src/app.ts',
          lineStart: 2,
          lineEnd: 4,
          selectedLines: 'second\nthird\nfourth',
          threadContext: null,
        },
      }),
    );
  });

  it('uses file-thread iteration content when head changed after posting', async () => {
    const postedThread = {
      id: 74,
      status: 'active',
      threadContext: {
        filePath: '/src/app.ts',
        rightFileStart: { line: 2 },
        rightFileEnd: { line: 3 },
      },
      comments: [comment(12, 'Review original lines')],
    };
    addFileCommentMock.mockResolvedValue(postedThread);
    threadsMock.mockResolvedValue([
      {
        ...postedThread,
        threadContext: {
          ...postedThread.threadContext,
          originalCommitId: 'thread-iteration-commit',
        },
      },
    ]);
    commitFileContentMock.mockResolvedValue(
      'original first\noriginal second\noriginal third\noriginal fourth',
    );
    fileContentMock.mockResolvedValue(
      'new head first\nnew head second\nnew head third\nnew head fourth',
    );

    await addPullRequestFileCommentWithAgentMemory({
      ...repository,
      filePath: '/src/app.ts',
      line: 2,
      lineEnd: 3,
      selectedLines: 'original second\noriginal third',
      content: 'Review original lines',
    });

    await vi.waitFor(() => expect(captureMock).toHaveBeenCalled());
    expect(commitFileContentMock).toHaveBeenCalledWith({
      providerId: 'provider-1',
      projectId: 'azure-project-1',
      repoId: 'repo-1',
      commitId: 'thread-iteration-commit',
      filePath: '/src/app.ts',
      version: 'current',
    });
    expect(fileContentMock).not.toHaveBeenCalled();
    expect(captureMock.mock.calls[0][0].context.selectedLines).toBe(
      'original second\noriginal third',
    );
  });

  it('does not fall back to head when historical content fetch fails', async () => {
    const result = {
      id: 74,
      status: 'active',
      threadContext: {
        filePath: '/src/app.ts',
        rightFileStart: { line: 2 },
        rightFileEnd: { line: 3 },
        originalCommitId: 'thread-iteration-commit',
      },
      comments: [comment(12, 'Review original lines')],
    };
    addFileCommentMock.mockResolvedValue(result);
    commitFileContentMock.mockRejectedValue(new Error('historical fetch failed'));
    fileContentMock.mockResolvedValue('new first\nnew second\nnew third');

    await expect(
      addPullRequestFileCommentWithAgentMemory({
        ...repository,
        filePath: '/src/app.ts',
        line: 2,
        lineEnd: 3,
        selectedLines: 'old second\nold third',
        content: 'Review original lines',
      }),
    ).resolves.toBe(result);
    await vi.waitFor(() =>
      expect(reportFailureMock).toHaveBeenCalledWith(
        { source: 'pr-comment', projectId: 'local-project-1' },
        expect.objectContaining({ message: 'historical fetch failed' }),
      ),
    );

    expect(fileContentMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('captures latest prior thread only, excluding newly posted reply', async () => {
    addReplyMock.mockResolvedValue(comment(99, 'New reply'));
    const oldPrefix = 'old'.repeat(4_000);
    const latest = 'latest'.repeat(4_000);
    threadsMock.mockResolvedValue([
      {
        id: 75,
        status: 'active',
        comments: [
          comment(1, oldPrefix),
          comment(2, `Bearer secret-token ${latest}`),
          comment(99, 'New reply'),
          comment(100, 'Later comment'),
        ],
      },
    ]);

    await addThreadReplyWithAgentMemory({
      ...repository,
      threadId: 75,
      content: 'New reply',
    });

    await vi.waitFor(() => expect(captureMock).toHaveBeenCalled());
    const input = captureMock.mock.calls[0][0];
    expect(input.sourceId).toBe(
      'pr-reply:provider-1:azure-project-1:repo-1:42:75:99',
    );
    expect(input.text).toBe('New reply');
    expect(input.context.threadContext).toContain(latest.slice(-10_000));
    expect(input.context.threadContext).not.toContain('New reply');
    expect(input.context.threadContext).not.toContain('Later comment');
    expect(input.context.threadContext.length).toBeGreaterThan(20_000);
  });

  it('derives file-thread reply selection when provider context is safe', async () => {
    addReplyMock.mockResolvedValue(comment(99, 'Reply'));
    threadsMock.mockResolvedValue([
      {
        id: 75,
        status: 'active',
        threadContext: {
          filePath: '/src/app.ts',
          rightFileStart: { line: 2 },
          rightFileEnd: { line: 3 },
          originalCommitId: 'old-thread-commit',
        },
        comments: [comment(1, 'Prior teammate text'), comment(99, 'Reply')],
      },
    ]);
    commitFileContentMock.mockResolvedValue(
      'old first\nold second\nold third\nold fourth',
    );
    fileContentMock.mockResolvedValue(
      'new first\nnew second\nnew third\nnew fourth',
    );

    await addThreadReplyWithAgentMemory({
      ...repository,
      threadId: 75,
      content: 'Reply',
    });

    await vi.waitFor(() =>
      expect(captureMock).toHaveBeenCalledWith(
        expect.objectContaining({
          context: {
            pullRequestId: '42',
            threadId: '75',
            filePath: '/src/app.ts',
            lineStart: 2,
            lineEnd: 3,
            selectedLines: 'old second\nold third',
            threadContext: 'Prior teammate text',
          },
        }),
      ),
    );
    expect(commitFileContentMock).toHaveBeenCalledWith({
      providerId: 'provider-1',
      projectId: 'azure-project-1',
      repoId: 'repo-1',
      commitId: 'old-thread-commit',
      filePath: '/src/app.ts',
      version: 'current',
    });
    expect(fileContentMock).not.toHaveBeenCalled();
  });

  it('strips uploaded image markdown and attachment URLs from evidence', async () => {
    const attachment =
      'https://dev.azure.com/org/project/_apis/git/repositories/repo/pullRequests/42/attachments/image.png?api-version=7.1-preview.1';
    expect(
      stripPullRequestEvidenceArtifacts(
        `Keep this text\n\n![image.png](${attachment})\nRaw ${attachment}`,
      ),
    ).toBe('Keep this text\n\nRaw');

    const submittedContent = `Keep this text\n\n![image.png](${attachment})`;
    addCommentMock.mockResolvedValue({
      id: 73,
      status: 'active',
      comments: [comment(11, submittedContent)],
    });
    await addPullRequestCommentWithAgentMemory({
      ...repository,
      content: submittedContent,
    });
    await vi.waitFor(() =>
      expect(captureMock).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Keep this text' }),
      ),
    );
  });

  it('removes image payload bypasses while preserving surrounding prose', () => {
    const payload = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=';
    const absoluteAttachment =
      'https://dev.azure.com/org/project/_apis/git/repositories/repo/pullRequests/42/attachments/upload.png?api-version=7.1-preview.1';
    const input = [
      `Before ![inline](data:image/png;base64,${payload}) after.`,
      'Nested ![plot](https://example.test/image_(1).png "plot") remains prose.',
      'Reference ![screen][shot] remains prose.',
      `[shot]: blob:local-preview-${payload}`,
      `Unused image payload [unused]: data:image/webp;base64,${payload}`,
      `HTML before <img\n src="file:///tmp/${payload}.png" alt="secret"> HTML after.`,
      `Raw data:image/jpeg;base64,${payload} data removed.`,
      `Encoded data%3Aimage%2Fpng%3Bbase64%2C${payload} removed.`,
      `Blob blob:preview-${payload} removed.`,
      `File file:///tmp/${payload}.png removed.`,
      `Azure [attachment](${absoluteAttachment}) removed.`,
      'Relative /_apis/wit/attachments/70ecf9b9-300f-48ea-a5a8-80d9c00b6209?fileName=upload.png removed.',
      'Short relative /70ecf9b9-300f-48ea-a5a8-80d9c00b6209?fileName=upload.png removed.',
      `Uploaded ![upload.png](${absoluteAttachment}) removed.`,
      '[docs]: https://example.test/docs',
      'Keep final prose.',
    ].join('\n');

    const sanitized = stripPullRequestEvidenceArtifacts(input);

    expect(sanitized).toContain('Before  after.');
    expect(sanitized).toContain('Nested  remains prose.');
    expect(sanitized).toContain('Reference  remains prose.');
    expect(sanitized).toContain('HTML before  HTML after.');
    expect(sanitized).toContain('[docs]: https://example.test/docs');
    expect(sanitized).toContain('Keep final prose.');
    expect(sanitized).not.toContain(payload);
    expect(sanitized).not.toMatch(/!\[|<img|data(?:%3a|:)|blob:|file:/i);
    expect(sanitized).not.toMatch(/attachments|fileName=upload\.png/i);
  });

  it('selects the unique returned comment matching submitted content', async () => {
    addCommentMock.mockResolvedValue({
      id: 73,
      status: 'active',
      comments: [
        comment(10, 'Unrelated provider comment'),
        comment(11, 'Submitted feedback'),
      ],
    });

    await addPullRequestCommentWithAgentMemory({
      ...repository,
      content: 'Submitted feedback',
    });

    await vi.waitFor(() => expect(captureMock).toHaveBeenCalled());
    expect(captureMock.mock.calls[0][0].sourceId).toContain(':73:11');
  });

  it.each([
    {
      name: 'zero thread ID',
      result: {
        id: 0,
        status: 'active',
        comments: [comment(11, 'Submitted feedback')],
      },
    },
    {
      name: 'unsafe comment ID',
      result: {
        id: 73,
        status: 'active',
        comments: [
          comment(Number.MAX_SAFE_INTEGER + 1, 'Submitted feedback'),
        ],
      },
    },
    {
      name: 'ambiguous matching comments',
      result: {
        id: 73,
        status: 'active',
        comments: [
          comment(11, 'Submitted feedback'),
          comment(12, 'Submitted feedback'),
        ],
      },
    },
  ])('skips capture for $name while preserving post success', async ({ result }) => {
    addCommentMock.mockResolvedValue(result);

    await expect(
      addPullRequestCommentWithAgentMemory({
        ...repository,
        content: 'Submitted feedback',
      }),
    ).resolves.toBe(result);
    await vi.waitFor(() => expect(reportFailureMock).toHaveBeenCalled());

    expect(captureMock).not.toHaveBeenCalled();
    expect(reportFailureMock).toHaveBeenCalledWith(
      { source: 'pr-comment', projectId: 'local-project-1' },
      expect.any(Error),
    );
  });

  it('skips capture for malformed returned reply ID without fetching context', async () => {
    const result = comment(0, 'Reply');
    addReplyMock.mockResolvedValue(result);

    await expect(
      addThreadReplyWithAgentMemory({
        ...repository,
        threadId: 75,
        content: 'Reply',
      }),
    ).resolves.toBe(result);
    await vi.waitFor(() => expect(reportFailureMock).toHaveBeenCalled());

    expect(threadsMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
    expect(reportFailureMock).toHaveBeenCalledWith(
      { source: 'pr-reply', projectId: 'local-project-1' },
      expect.any(Error),
    );
  });

  it('validates local project association and isolates capture failures', async () => {
    const result = {
      id: 73,
      status: 'active',
      comments: [comment(11, 'Posted')],
    };
    addCommentMock.mockResolvedValue(result);
    findProjectMock.mockResolvedValueOnce({
      id: 'local-project-1',
      repoProviderId: 'different-provider',
      repoProjectId: 'azure-project-1',
      repoId: 'repo-1',
    });

    await expect(
      addPullRequestCommentWithAgentMemory({
        ...repository,
        content: 'Posted',
      }),
    ).resolves.toBe(result);
    expect(captureMock).not.toHaveBeenCalled();
    expect(reportFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'pr-comment', projectId: 'local-project-1' }),
      expect.any(Error),
    );

    findProjectMock.mockResolvedValueOnce({
      id: repository.localProjectId,
      repoProviderId: repository.providerId,
      repoProjectId: repository.projectId,
      repoId: repository.repoId,
    });
    captureMock.mockRejectedValueOnce(new Error('disk full'));
    const secondResult = {
      ...result,
      comments: [comment(11, 'Posted again')],
    };
    addCommentMock.mockResolvedValueOnce(secondResult);
    await expect(
      addPullRequestCommentWithAgentMemory({
        ...repository,
        content: 'Posted again',
      }),
    ).resolves.toBe(secondResult);
    expect(reportFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'pr-comment', projectId: 'local-project-1' }),
      expect.objectContaining({ message: 'disk full' }),
    );
  });

  it('logs reply-context fetch failure without changing successful post result', async () => {
    const result = comment(99, 'Posted reply');
    addReplyMock.mockResolvedValue(result);
    threadsMock.mockRejectedValue(new Error('thread fetch failed'));

    await expect(
      addThreadReplyWithAgentMemory({
        ...repository,
        threadId: 75,
        content: 'Posted reply',
      }),
    ).resolves.toBe(result);
    await vi.waitFor(() =>
      expect(reportFailureMock).toHaveBeenCalledWith(
        { source: 'pr-reply', projectId: 'local-project-1' },
        expect.objectContaining({ message: 'thread fetch failed' }),
      ),
    );
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('does nothing for remote thread fetches or posts without a local project ID', async () => {
    const result = {
      id: 73,
      status: 'active',
      comments: [comment(11, 'AI annotation')],
    };
    addCommentMock.mockResolvedValue(result);

    await addPullRequestCommentWithAgentMemory({
      providerId: repository.providerId,
      projectId: repository.projectId,
      repoId: repository.repoId,
      pullRequestId: repository.pullRequestId,
      content: 'AI annotation',
    });

    expect(findProjectMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
    expect(threadsMock).not.toHaveBeenCalled();
  });

  it('does not fetch reply context when Agent Memory is disabled', async () => {
    captureEnabledMock.mockResolvedValue(false);
    addReplyMock.mockResolvedValue(comment(99, 'Reply'));

    await addThreadReplyWithAgentMemory({
      ...repository,
      threadId: 75,
      content: 'Reply',
    });
    await vi.waitFor(() => expect(captureEnabledMock).toHaveBeenCalled());

    expect(threadsMock).not.toHaveBeenCalled();
    expect(fileContentMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });
});
