// @vitest-environment happy-dom
/* eslint-disable sort-imports */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptImagePart } from '@shared/agent-backend-types';

const { processImageFileSpy } = vi.hoisted(() => ({
  processImageFileSpy: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@/features/common/ui-video-gif-converter', () => ({
  isVideoFile: () => false,
  VideoGifConverter: () => null,
}));

vi.mock('@/hooks/use-create-pull-request', () => ({
  useAddPrFileComments: () => ({ mutateAsync: vi.fn() }),
  useCreatePullRequest: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock('@/hooks/use-task-summary', () => ({
  useGenerateSummary: () => ({
    data: undefined,
    isPending: false,
    mutateAsync: vi.fn(),
  }),
  useTaskSummary: () => ({ data: undefined }),
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
    },
  }),
}));

vi.mock('@/hooks/use-worktree-diff', () => ({
  useWorktreeStatus: () => ({ data: { hasUncommittedChanges: false } }),
}));

vi.mock('@/common/hooks/use-commands', () => ({ useCommands: vi.fn() }));

vi.mock('@/stores/navigation', () => ({
  usePrDraftState: () => ({ prDraft: undefined, setPrDraft: vi.fn() }),
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

vi.mock('@/lib/image-utils', () => ({
  MAX_IMAGES: 5,
  processImageFile: processImageFileSpy,
}));

import { PrCreationForm } from './pr-creation-form';

const GIF_CONTENT = `GIF_CONTENT_${'A'.repeat(100_000)}`;
const BASE64_SENTINEL = btoa(GIF_CONTENT);
const gifImage: PromptImagePart = {
  type: 'image',
  data: BASE64_SENTINEL,
  mimeType: 'image/gif',
  filename: 'converted-demo.gif',
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

  it('wires pending, ready, and removed previews through the production form', async () => {
    vi.useFakeTimers();
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
      value: [new File(['video'], 'converted-demo.gif', { type: 'image/gif' })],
    });

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(container.textContent).toContain('converted-demo.gif');
    expect(container.querySelector('img[alt="converted-demo.gif"]')).toBeNull();
    expect(container.innerHTML).not.toContain(BASE64_SENTINEL);
    expect(createObjectUrl).not.toHaveBeenCalled();

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const gifBlob = createObjectUrl.mock.calls[0]?.[0] as Blob;
    expect(gifBlob.type).toBe('image/gif');
    expect(await gifBlob.text()).toBe(GIF_CONTENT);
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
});
