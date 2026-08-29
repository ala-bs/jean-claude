// @vitest-environment happy-dom
/* eslint-disable sort-imports */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptImagePart } from '@shared/agent-backend-types';
import { getImageMimeType } from '@shared/image-types';

const {
  addPrFileCommentsSpy,
  createPullRequestSpy,
  getPullRequestSpy,
  processImageFileSpy,
  taskSummaryState,
  generatePrDescriptionSpy,
  attachmentFiles,
  prDraftState,
  updatePullRequestDescriptionSpy,
  uploadPullRequestAttachmentSpy,
} = vi.hoisted(() => ({
  addPrFileCommentsSpy: vi.fn(),
  createPullRequestSpy: vi.fn(),
  getPullRequestSpy: vi.fn(),
  processImageFileSpy: vi.fn(),
  taskSummaryState: { value: undefined as unknown },
  generatePrDescriptionSpy: vi.fn(),
  attachmentFiles: new Map<string, string>(),
  prDraftState: { value: undefined as unknown },
  updatePullRequestDescriptionSpy: vi.fn(),
  uploadPullRequestAttachmentSpy: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@/features/common/ui-video-gif-converter', () => ({
  isVideoFile: () => false,
  VideoGifConverter: () => null,
}));

vi.mock('@/hooks/use-create-pull-request', () => ({
  useAddPrFileComments: () => ({ mutateAsync: addPrFileCommentsSpy }),
  useCreatePullRequest: () => ({ mutateAsync: createPullRequestSpy }),
}));

// Draft images round-trip through `<worktreePath>/.jean-claude/tmp`, so the
// fs bridge is emulated faithfully rather than stubbed away: the tests assert
// on the exact bytes that come back out of it.
vi.mock('@/lib/api', () => ({
  api: {
    azureDevOps: {
      updatePullRequestDescription: updatePullRequestDescriptionSpy,
      uploadPullRequestAttachment: uploadPullRequestAttachmentSpy,
      getPullRequest: getPullRequestSpy,
    },
    fs: {
      // Mirrors electron/ipc/handlers.ts `fs:writeAttachmentFile`: uuid prefix
      // plus the same filename sanitizer. Kept faithful so the test cannot
      // pass on a filename production would mangle.
      writeAttachmentFile: vi.fn(
        async (basePath: string, filename: string, content: string) => {
          const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
          const filePath = `${basePath}/.jean-claude/tmp/abcd1234-${safe}`;
          attachmentFiles.set(filePath, content);
          return filePath;
        },
      ),
      // Mirrors `fs:readImageAsDataUrl`, including returning null for an
      // extension `getImageMimeType` does not recognise.
      readImageAsDataUrl: vi.fn(async (filePath: string) => {
        const data = attachmentFiles.get(filePath);
        if (data === undefined) return null;
        const mime = getImageMimeType(filePath);
        if (!mime) return null;
        return `data:${mime};base64,${data}`;
      }),
      deleteAttachmentFile: vi.fn(async (_base: string, filePath: string) => {
        attachmentFiles.delete(filePath);
        return true;
      }),
    },
    debug: { log: vi.fn() },
  },
}));

vi.mock('@/hooks/use-generate-pr-description', () => ({
  useGeneratePrDescription: () => ({
    isPending: false,
    mutateAsync: generatePrDescriptionSpy,
  }),
}));

vi.mock('@/hooks/use-task-summary', () => ({
  useGenerateSummary: () => ({
    data: undefined,
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useTaskSummary: () => ({ data: taskSummaryState.value }),
}));

vi.mock('@/hooks/use-settings', () => ({
  useAiSkillSlotsSetting: () => ({ data: undefined }),
}));

vi.mock('@/hooks/use-projects', () => ({
  useProject: () => ({
    data: {
      defaultBranch: 'main',
      repoId: 'repo-id',
      repoProjectId: 'repo-project-id',
      repoProviderId: 'provider-id',
    },
  }),
}));

vi.mock('@/hooks/use-tasks', () => ({
  useTask: () => ({
    data: {
      branchName: 'feature/media',
      name: 'Media previews',
      prompt: 'Add media previews',
      sourceBranch: 'main',
      workItemIds: [],
      worktreePath: '/worktrees/media',
    },
  }),
}));

vi.mock('@/hooks/use-worktree-diff', () => ({
  useWorktreeStatus: () => ({ data: { hasUncommittedChanges: false } }),
  useWorktreeCommits: () => ({ data: [{ hash: 'abc123' }] }),
}));

vi.mock('@/common/hooks/use-commands', () => ({ useCommands: vi.fn() }));

// Stateful, because draft images are now persisted through this store rather
// than held in component state.
vi.mock('@/stores/navigation', () => ({
  usePrDraftState: () => ({
    prDraft: prDraftState.value,
    setPrDraft: (draft: Record<string, unknown>) => {
      const merged = {
        ...(prDraftState.value as Record<string, unknown> | undefined),
        ...draft,
      };
      prDraftState.value = merged;
    },
    clearPrDraft: () => {
      prDraftState.value = undefined;
    },
  }),
}));

vi.mock('@/stores/background-jobs', () => ({
  useBackgroundJobsStore: (selector: (state: object) => unknown) =>
    selector({
      addRunningJob: vi.fn(() => 'job-id'),
      markJobFailed: vi.fn(),
      markJobSucceeded: vi.fn(),
    }),
}));

vi.mock('@/stores/toasts', () => ({
  useToastStore: (selector: (state: object) => unknown) =>
    selector({ addToast: vi.fn() }),
}));

vi.mock('@/lib/image-utils', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/image-utils')>(
      '@/lib/image-utils',
    );
  return {
    MAX_FILE_SIZE: 10 * 1024 * 1024,
    MAX_IMAGES: 5,
    MAX_PR_DRAFT_IMAGES: 10,
    getAttachmentFileName: actual.getAttachmentFileName,
    getAttachmentPayload: actual.getAttachmentPayload,
    getAzureAttachmentPayload: actual.getAzureAttachmentPayload,
    processImageFile: processImageFileSpy,
  };
});

import { PrCreationForm } from './pr-creation-form';
import { api } from '@/lib/api';

const GIF_BYTES = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x80, 0xff, 0x21, 0xf9, 0x04,
]);
const BASE64_SENTINEL = btoa(String.fromCharCode(...GIF_BYTES));
const gifImage: PromptImagePart = {
  type: 'image',
  data: 'compressed-agent-data',
  mimeType: 'image/webp',
  filename: 'converted-demo.gif',
  storageData: 'compressed-storage-data',
  storageMimeType: 'image/avif',
};

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

describe('PrCreationForm image previews', () => {
  let container: HTMLDivElement;
  let root: Root;
  const createObjectUrl = vi.fn(
    (_blob: Blob) => 'blob:converted-gif-preview',
  );
  const revokeObjectUrl = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    createObjectUrl.mockClear();
    revokeObjectUrl.mockClear();
    processImageFileSpy.mockImplementation(
      async (
        _file: File,
        onAttach: (image: PromptImagePart) => void,
      ) => onAttach(gifImage),
    );
    createPullRequestSpy.mockResolvedValue({
      id: 42,
      url: 'https://dev.azure.com/pr/42',
    });
    uploadPullRequestAttachmentSpy.mockResolvedValue({
      url: 'https://dev.azure.com/attachments/converted-demo.gif',
    });
    updatePullRequestDescriptionSpy.mockResolvedValue(undefined);
    getPullRequestSpy.mockResolvedValue({
      description: 'Generated description',
    });
    addPrFileCommentsSpy.mockResolvedValue(undefined);
    taskSummaryState.value = undefined;
    attachmentFiles.clear();
    prDraftState.value = undefined;
    vi.stubGlobal('URL', {
      createObjectURL: createObjectUrl,
      revokeObjectURL: revokeObjectUrl,
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root.unmount());
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('wires ready and removed previews through the production form', async () => {
    await act(async () => {
      root.render(
        createElement(PrCreationForm, {
          taskId: 'task-id',
          projectId: 'project-id',
          onSuccess: vi.fn(),
          onCancel: vi.fn(),
        }),
      );
    });

    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    if (!fileInput) throw new Error('Image input not found');
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [
        new File([GIF_BYTES], 'converted-demo.gif', { type: 'image/gif' }),
      ],
    });

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const gifBlob = createObjectUrl.mock.calls[0]?.[0] as Blob;
    expect(gifBlob.type).toBe('image/gif');
    expect(new Uint8Array(await gifBlob.arrayBuffer())).toEqual(GIF_BYTES);
    expect(
      container.querySelector<HTMLImageElement>('img[alt="converted-demo.gif"]')
        ?.src,
    ).toBe('blob:converted-gif-preview#jc-mime=image%2Fgif');
    expect(container.innerHTML).not.toContain(BASE64_SENTINEL);

    const removeButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove converted-demo.gif"]',
    );
    if (!removeButton) throw new Error('Remove attachment button not found');
    await act(async () => removeButton.click());

    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:converted-gif-preview');
    expect(container.textContent).not.toContain('converted-demo.gif');
    expect(container.querySelector('img[alt="converted-demo.gif"]')).toBeNull();
    expect(
      container.querySelector<HTMLTextAreaElement>('#pr-description')?.value,
    ).not.toContain('jc-image://');
  });

  it('uploads original GIF bytes when creating the pull request', async () => {
    await act(async () => {
      root.render(
        createElement(PrCreationForm, {
          taskId: 'task-id',
          projectId: 'project-id',
          onSuccess: vi.fn(),
          onCancel: vi.fn(),
        }),
      );
    });

    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    const titleInput = container.querySelector<HTMLInputElement>('#pr-title');
    if (!fileInput || !titleInput) throw new Error('PR form input not found');

    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [
        new File([GIF_BYTES], 'converted-demo.gif', { type: 'image/gif' }),
      ],
    });
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain('converted-demo.gif');

    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      valueSetter?.call(titleInput, 'Preserve GIF animation');
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const createButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Create PR'),
    );
    if (!createButton) throw new Error('Create PR button not found');
    await act(async () => createButton.click());

    await vi.waitFor(() => {
      expect(uploadPullRequestAttachmentSpy).toHaveBeenCalledWith({
        providerId: 'provider-id',
        projectId: 'repo-project-id',
        repoId: 'repo-id',
        pullRequestId: 42,
        fileName: 'converted-demo.gif',
        mimeType: 'image/gif',
        dataBase64: BASE64_SENTINEL,
      });
    });
    expect(createPullRequestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Preserve GIF animation',
        description: expect.not.stringContaining('jc-image://'),
      }),
    );
    expect(updatePullRequestDescriptionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringMatching(
          /Generated description[\s\S]*https:\/\/dev\.azure\.com\/attachments\/converted-demo\.gif/,
        ),
      }),
    );
  });

  it('posts AI annotations without local project capture metadata', async () => {
    taskSummaryState.value = {
      summary: { whatIDid: 'Changed auth', keyDecisions: 'Kept API stable' },
      annotations: [
        {
          filePath: 'src/auth.ts',
          lineNumber: 12,
          explanation: 'AI-generated annotation',
        },
      ],
    };
    await act(async () => {
      root.render(
        createElement(PrCreationForm, {
          taskId: 'task-id',
          projectId: 'project-id',
          onSuccess: vi.fn(),
          onCancel: vi.fn(),
        }),
      );
    });
    // Annotations no longer need a "Fill from Summary" click: the ✨ button now
    // generates the PR description from the diff, so annotations are offered
    // automatically whenever a task summary already exists. The title that
    // click used to supply now has to be typed.
    const titleInput = container.querySelector<HTMLInputElement>('#pr-title');
    if (!titleInput) throw new Error('PR title input not found');
    const setInputValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      setInputValue?.call(titleInput, 'Annotated PR');
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const createButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Create PR'),
    );
    if (!createButton) throw new Error('Create PR button not found');
    await act(async () => createButton.click());

    await vi.waitFor(() => {
      expect(addPrFileCommentsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          comments: [
            {
              filePath: 'src/auth.ts',
              line: 12,
              content: 'jean-claude: AI-generated annotation',
            },
          ],
        }),
      );
    });
    expect(addPrFileCommentsSpy.mock.calls[0]?.[0]).not.toHaveProperty(
      'localProjectId',
    );
  });

  /**
   * Stage a GIF into the description at `caretOffset`, set a title, and submit.
   * Returns once the create-PR mutation has been dispatched.
   */
  async function submitWithInlineImage({
    descriptionText,
    caretOffset,
  }: {
    descriptionText: string;
    caretOffset: number;
  }) {
    await act(async () => {
      root.render(
        createElement(PrCreationForm, {
          taskId: 'task-id',
          projectId: 'project-id',
          onSuccess: vi.fn(),
          onCancel: vi.fn(),
        }),
      );
    });

    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    const titleInput = container.querySelector<HTMLInputElement>('#pr-title');
    const description =
      container.querySelector<HTMLTextAreaElement>('#pr-description');
    if (!fileInput || !titleInput || !description) {
      throw new Error('PR form input not found');
    }

    const inputValueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    const textareaValueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;

    await act(async () => {
      inputValueSetter?.call(titleInput, 'Inline image PR');
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      textareaValueSetter?.call(description, descriptionText);
      description.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Place the caret mid-body so an inline (not appended) placeholder is used.
    description.setSelectionRange(caretOffset, caretOffset);

    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [
        new File([GIF_BYTES], 'converted-demo.gif', { type: 'image/gif' }),
      ],
    });
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const createButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Create PR'),
    );
    if (!createButton) throw new Error('Create PR button not found');
    await act(async () => createButton.click());
  }

  it('keeps the image inline when the server kept our description', async () => {
    // Server echoes back exactly what we sent (placeholders stripped).
    createPullRequestSpy.mockImplementation(
      async (params: { description: string }) => {
        getPullRequestSpy.mockResolvedValue({
          description: params.description,
        });
        return { id: 42, url: 'https://dev.azure.com/pr/42' };
      },
    );

    await submitWithInlineImage({
      descriptionText: 'Intro\nOutro',
      caretOffset: 6, // start of "Outro"
    });

    await vi.waitFor(() => {
      expect(updatePullRequestDescriptionSpy).toHaveBeenCalled();
    });
    const posted = updatePullRequestDescriptionSpy.mock.calls[0]?.[0] as {
      description: string;
    };

    // The image must sit between Intro and Outro, not appended at the end.
    expect(posted.description).toMatch(
      /Intro\n!\[converted-demo\.gif\]\(https:\/\/dev\.azure\.com\/attachments\/converted-demo\.gif[^)]*\)Outro/,
    );
    expect(posted.description).not.toContain('jc-image://');
  });

  it('keeps the image inline when the server normalizes line endings', async () => {
    createPullRequestSpy.mockImplementation(
      async (params: { description: string }) => {
        getPullRequestSpy.mockResolvedValue({
          // Azure round-trips descriptions and may return CRLF.
          description: params.description.replace(/\n/g, '\r\n'),
        });
        return { id: 42, url: 'https://dev.azure.com/pr/42' };
      },
    );

    await submitWithInlineImage({
      descriptionText: 'Intro\nOutro',
      caretOffset: 6,
    });

    await vi.waitFor(() => {
      expect(updatePullRequestDescriptionSpy).toHaveBeenCalled();
    });
    const posted = updatePullRequestDescriptionSpy.mock.calls[0]?.[0] as {
      description: string;
    };

    expect(posted.description).toMatch(
      /Intro\n!\[converted-demo\.gif\]\(https:\/\/dev\.azure\.com\/attachments\/converted-demo\.gif[^)]*\)Outro/,
    );
  });

  it('still uploads attachments when reading the created PR fails', async () => {
    getPullRequestSpy.mockRejectedValue(new Error('403 Forbidden'));

    await submitWithInlineImage({
      descriptionText: 'Intro\nOutro',
      caretOffset: 6,
    });

    // A read failure must not cost the attachments.
    await vi.waitFor(() => {
      expect(uploadPullRequestAttachmentSpy).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(updatePullRequestDescriptionSpy).toHaveBeenCalled();
    });
    const posted = updatePullRequestDescriptionSpy.mock.calls[0]?.[0] as {
      description: string;
    };
    expect(posted.description).toContain(
      'https://dev.azure.com/attachments/converted-demo.gif',
    );
    expect(posted.description).not.toContain('jc-image://');
  });

  it('drops the placeholder and never posts a jc-image link when upload fails', async () => {
    createPullRequestSpy.mockImplementation(
      async (params: { description: string }) => {
        getPullRequestSpy.mockResolvedValue({
          description: params.description,
        });
        return { id: 42, url: 'https://dev.azure.com/pr/42' };
      },
    );
    uploadPullRequestAttachmentSpy.mockRejectedValue(
      new Error('Unsupported attachment format "webp"'),
    );

    await submitWithInlineImage({
      descriptionText: 'Intro\nOutro',
      caretOffset: 6,
    });

    await vi.waitFor(() => {
      expect(updatePullRequestDescriptionSpy).toHaveBeenCalled();
    });
    const posted = updatePullRequestDescriptionSpy.mock.calls[0]?.[0] as {
      description: string;
    };
    expect(posted.description).not.toContain('jc-image://');
    expect(posted.description).toContain('Intro');
    expect(posted.description).toContain('Outro');
  });

  /**
   * Regression: draft images load from disk asynchronously. Submitting during
   * that window used to see an empty image list, ship raw `jc-image://` links
   * to the host, and then delete the backing files -- unrecoverable loss.
   */
  it('blocks submission until persisted draft images have hydrated', async () => {
    prDraftState.value = {
      title: 'Restored draft',
      description: '![shot.png](jc-image://1 =600x)',
      images: [
        {
          token: '1',
          filePath: '/worktrees/media/.jean-claude/tmp/abcd1234-shot.png',
          filename: 'shot.png',
          mimeType: 'image/png',
        },
      ],
    };
    attachmentFiles.set(
      '/worktrees/media/.jean-claude/tmp/abcd1234-shot.png',
      'cGl4ZWxz',
    );

    // Hold the read open so the component stays in its hydrating state.
    let releaseRead: (value: string) => void = () => {};
    const pendingRead = new Promise<string>((resolve) => {
      releaseRead = resolve;
    });
    vi.mocked(api.fs.readImageAsDataUrl).mockReturnValueOnce(
      pendingRead as unknown as Promise<string | null>,
    );

    await act(async () => {
      root.render(
        createElement(PrCreationForm, {
          taskId: 'task-id',
          projectId: 'project-id',
          onSuccess: vi.fn(),
          onCancel: vi.fn(),
        }),
      );
    });

    const createButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Create PR'),
    );
    if (!createButton) throw new Error('Create PR button not found');

    expect(createButton.disabled).toBe(true);
    await act(async () => createButton.click());
    expect(createPullRequestSpy).not.toHaveBeenCalled();

    await act(async () => {
      releaseRead('data:image/png;base64,cGl4ZWxz');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(createButton.disabled).toBe(false);
  });

  /**
   * Regression: the draft is the only remaining copy of an image that failed
   * to upload, so it must survive rather than being cleared with its files.
   */
  it('keeps the draft and its files when an attachment upload fails', async () => {
    uploadPullRequestAttachmentSpy.mockRejectedValue(new Error('azure down'));

    await submitWithInlineImage({
      descriptionText: 'Body',
      caretOffset: 4,
    });

    await vi.waitFor(() => {
      expect(updatePullRequestDescriptionSpy).toHaveBeenCalled();
    });

    expect(prDraftState.value).toBeDefined();
    expect(
      (prDraftState.value as { images?: unknown[] }).images,
    ).toHaveLength(1);
    expect(attachmentFiles.size).toBe(1);
  });

  /** Regression: a ref whose file vanished must not upload as 0 bytes. */
  it('never uploads an image whose backing file is missing', async () => {
    prDraftState.value = {
      title: 'Draft with a lost file',
      description: 'Intro\n\n![gone.png](jc-image://1 =600x)',
      images: [
        {
          token: '1',
          filePath: '/worktrees/media/.jean-claude/tmp/abcd1234-gone.png',
          filename: 'gone.png',
          mimeType: 'image/png',
        },
      ],
    };
    // Deliberately not registered in `attachmentFiles` -- the file is gone.

    await act(async () => {
      root.render(
        createElement(PrCreationForm, {
          taskId: 'task-id',
          projectId: 'project-id',
          onSuccess: vi.fn(),
          onCancel: vi.fn(),
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const createButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Create PR'),
    );
    if (!createButton) throw new Error('Create PR button not found');
    await act(async () => createButton.click());

    await vi.waitFor(() => {
      expect(createPullRequestSpy).toHaveBeenCalled();
    });
    expect(uploadPullRequestAttachmentSpy).not.toHaveBeenCalled();

    // The unresolvable placeholder must be stripped, never posted verbatim.
    const created = createPullRequestSpy.mock.calls[0]?.[0] as {
      description: string;
    };
    expect(created.description).not.toContain('jc-image://');
    expect(created.description).toContain('Intro');
  });
});
