/**
 * @vitest-environment happy-dom
 */
/* eslint-disable sort-imports */
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AzureDevOpsPullRequestDetails } from '@/lib/api';

const {
  uploadAttachment,
  updateDescription,
  processImageFile,
  markdownProps,
} = vi.hoisted(() => ({
  uploadAttachment: vi.fn(),
  updateDescription: vi.fn(),
  processImageFile: vi.fn(),
  markdownProps: vi.fn(),
}));

vi.mock('@/hooks/use-pull-requests', () => ({
  getAllowedMergeStrategies: () => ['squash'],
  useCurrentAzureUser: () => ({
    data: {
      id: 'author-id',
      identityId: 'author-id',
      displayName: 'Author',
      emailAddress: 'author@example.com',
    },
  }),
  useLinkWorkItemToPr: () => ({ mutate: vi.fn(), isPending: false }),
  usePullRequestFileContent: () => ({ data: undefined, isLoading: false }),
  usePullRequestPolicyEvaluations: () => ({ data: [], isLoading: false }),
  usePullRequestWorkItems: () => ({ data: [], isLoading: false }),
  useRequeuePolicyEvaluation: () => ({ mutate: vi.fn(), isPending: false }),
  useSetAutoComplete: () => ({ mutate: vi.fn(), isPending: false }),
  useUnlinkWorkItemFromPr: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdatePullRequestDescription: () => ({
    mutateAsync: updateDescription,
    isPending: false,
  }),
  useUploadPullRequestAttachment: () => ({
    mutateAsync: uploadAttachment,
    isPending: false,
  }),
}));

vi.mock('@/lib/image-utils', () => ({
  MAX_IMAGES: 5,
  processImageFile,
}));

vi.mock('@/features/common/ui-video-gif-converter', () => ({
  isVideoFile: () => false,
  VideoGifConverter: () => null,
}));

vi.mock('@/features/common/ui-file-diff', () => ({
  FileDiffContent: () => null,
  normalizeAzureChangeType: (changeType: string) => changeType,
}));

vi.mock('@/features/common/ui-azure-html-content', () => ({
  AzureMarkdownContent: (props: {
    markdown: string;
    allowBlobImages?: boolean;
  }) => {
    markdownProps(props);
    return createElement('div', {
      'data-testid': 'markdown',
      'data-markdown': props.markdown,
      'data-allow-blob-images': String(!!props.allowBlobImages),
    });
  },
}));

vi.mock('@/hooks/use-horizontal-resize', () => ({
  useHorizontalResize: () => ({
    containerRef: { current: null },
    isDragging: false,
    handleMouseDown: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-debounced-value', () => ({
  useDebouncedValue: <T,>(value: T) => value,
}));

vi.mock('../ui-pr-inline-comment-thread', () => ({
  convertPrThreadsForFile: () => [],
  PrInlineCommentThread: () => null,
}));
vi.mock('../ui-pr-ci-inline', () => ({ CIInlinePanel: () => null }));
vi.mock('../ui-pr-checks', () => ({ PrChecks: () => null }));
vi.mock('../ui-pr-comments', () => ({ PrComments: () => null }));
vi.mock('../ui-pr-meta-panel', () => ({ PrMetaPanel: () => null }));

import { PrOverview } from '.';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let blobUrlCount = 0;

const pr: AzureDevOpsPullRequestDetails = {
  id: 17,
  title: 'Media preview',
  description: 'Original description',
  status: 'active',
  isDraft: false,
  createdBy: {
    id: 'author-id',
    displayName: 'Author',
    uniqueName: 'author@example.com',
  },
  creationDate: '2026-07-14T00:00:00Z',
  sourceRefName: 'refs/heads/media',
  targetRefName: 'refs/heads/main',
  url: 'https://example.com/pr/17',
  reviewers: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderOverview() {
  flushSync(() => {
    root?.render(
      createElement(PrOverview, {
        pr,
        projectId: 'project-1',
        prId: 17,
      }),
    );
  });
}

function button(label: string) {
  const match = Array.from(container?.querySelectorAll('button') ?? []).find(
    (candidate) => candidate.textContent?.includes(label),
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

function buttonByLabel(label: string) {
  const match = container?.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

function textarea() {
  const match = container?.querySelector<HTMLTextAreaElement>('textarea');
  if (!match) throw new Error('Description textarea not found');
  return match;
}

function typeInto(element: HTMLTextAreaElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  valueSetter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function click(element: Element) {
  element.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true }),
  );
}

async function waitFor(assertion: () => void) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  assertion();
}

async function stageImage(fileName = 'diagram.png') {
  const input = container?.querySelector<HTMLInputElement>(
    'input[type="file"]',
  );
  if (!input) throw new Error('Description image input not found');
  const file = new File(['image'], fileName, { type: 'image/png' });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  flushSync(() => input.dispatchEvent(new Event('change', { bubbles: true })));
  await waitFor(() =>
    expect(buttonByLabel(`Remove ${fileName}`)).toBeTruthy(),
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  blobUrlCount = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => `blob:description-${++blobUrlCount}`),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
  processImageFile.mockImplementation(
    async (
      file: File,
      onAttach: (image: {
        type: 'image';
        data: string;
        mimeType: string;
        filename: string;
        storageData: string;
        storageMimeType: string;
      }) => void,
    ) => {
      onAttach({
        type: 'image',
        data: 'b3JpZ2luYWwtYmFzZTY0',
        mimeType: file.type,
        filename: file.name,
        storageData: 'AAAA'.repeat(16_385),
        storageMimeType: file.type,
      });
    },
  );
});

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  uploadAttachment.mockReset();
  updateDescription.mockReset();
  processImageFile.mockReset();
  markdownProps.mockReset();
});

describe('PR description save locking', () => {
  it('blocks same-tick cancel, edits, removal, and duplicate save', async () => {
    const upload = deferred<{ url: string }>();
    uploadAttachment.mockReturnValue(upload.promise);
    updateDescription.mockResolvedValue(undefined);
    renderOverview();
    flushSync(() => click(button('Edit')));
    await stageImage();

    const draft = textarea();
    const remove = buttonByLabel('Remove diagram.png');
    const save = button('Save');
    const cancel = button('Cancel');

    flushSync(() => {
      click(save);
      click(cancel);
      click(remove);
      typeInto(draft, 'Changed after save started');
      click(save);
    });

    expect(uploadAttachment).toHaveBeenCalledTimes(1);
    expect(updateDescription).not.toHaveBeenCalled();
    expect(container?.querySelector('textarea')).toBe(draft);
    expect(draft.value).toContain('Original description');
    expect(draft.value).toContain('jc-image://');
    expect(buttonByLabel('Remove diagram.png').hasAttribute('disabled')).toBe(
      true,
    );
    expect(button('Cancel').hasAttribute('disabled')).toBe(true);

    upload.resolve({ url: 'https://example.com/diagram.png' });
    await waitFor(() => expect(updateDescription).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container?.querySelector('textarea')).toBeNull());
  });

  it('unlocks and retains draft and media when save fails', async () => {
    uploadAttachment.mockResolvedValue({
      url: 'https://example.com/diagram.png',
    });
    updateDescription.mockRejectedValue(new Error('Description save failed'));
    renderOverview();
    flushSync(() => click(button('Edit')));
    await stageImage();

    click(button('Save'));

    await waitFor(() =>
      expect(container?.textContent).toContain('Description save failed'),
    );
    expect(textarea().value).toContain('jc-image://');
    expect(buttonByLabel('Remove diagram.png').hasAttribute('disabled')).toBe(
      false,
    );
    expect(button('Cancel').hasAttribute('disabled')).toBe(false);
    expect(button('Save').hasAttribute('disabled')).toBe(false);

    flushSync(() => typeInto(textarea(), 'Retryable draft'));
    expect(textarea().value).toBe('Retryable draft');
  });

  it('reuses uploaded attachments when retrying a failed description update', async () => {
    uploadAttachment.mockImplementation(
      async ({ fileName }: { fileName: string }) => ({
        url: `https://example.com/${fileName}`,
      }),
    );
    updateDescription
      .mockRejectedValueOnce(new Error('Description save failed'))
      .mockResolvedValueOnce(undefined);
    renderOverview();
    flushSync(() => click(button('Edit')));
    await stageImage('diagram.png');
    await stageImage('flow.png');

    click(button('Save'));
    await waitFor(() =>
      expect(container?.textContent).toContain('Description save failed'),
    );

    const retryDraft = `Retry intro\n\n${textarea().value}`;
    flushSync(() => typeInto(textarea(), retryDraft));
    click(button('Save'));

    await waitFor(() => expect(updateDescription).toHaveBeenCalledTimes(2));
    expect(uploadAttachment).toHaveBeenCalledTimes(2);
    expect(updateDescription).toHaveBeenLastCalledWith(
      expect.stringContaining('Retry intro'),
    );
    expect(updateDescription).toHaveBeenLastCalledWith(
      expect.stringContaining(
        '![diagram.png](https://example.com/diagram.png)',
      ),
    );
    expect(updateDescription).toHaveBeenLastCalledWith(
      expect.stringContaining('![flow.png](https://example.com/flow.png)'),
    );
  });

  it('retries only a failed attachment and reuses all uploads after update failure', async () => {
    let flowAttempts = 0;
    uploadAttachment.mockImplementation(
      async ({ fileName }: { fileName: string }) => {
        if (fileName === 'flow.png' && flowAttempts++ === 0) {
          throw new Error('Flow upload failed');
        }
        return { url: `https://example.com/${fileName}` };
      },
    );
    updateDescription
      .mockRejectedValueOnce(new Error('Description update failed'))
      .mockResolvedValueOnce(undefined);
    renderOverview();
    flushSync(() => click(button('Edit')));
    await stageImage('diagram.png');
    await stageImage('flow.png');

    click(button('Save'));
    await waitFor(() =>
      expect(container?.textContent).toContain('Flow upload failed'),
    );
    click(button('Save'));
    await waitFor(() =>
      expect(container?.textContent).toContain('Description update failed'),
    );

    flushSync(() => typeInto(textarea(), `Edited\n\n${textarea().value}`));
    click(button('Save'));
    await waitFor(() => expect(updateDescription).toHaveBeenCalledTimes(2));

    expect(
      uploadAttachment.mock.calls.map(([request]) => request.fileName),
    ).toEqual(['diagram.png', 'flow.png', 'flow.png']);
    expect(updateDescription).toHaveBeenLastCalledWith(
      expect.stringContaining('Edited'),
    );
  });
});

describe('PR description Blob media integration', () => {
  it('moves pending preview to Blob rendering and preserves upload base64', async () => {
    uploadAttachment.mockResolvedValue({
      url: 'https://example.com/uploaded-diagram.png',
    });
    updateDescription.mockResolvedValue(undefined);
    renderOverview();
    flushSync(() => click(button('Edit')));
    await stageImage();

    expect(
      markdownProps.mock.calls.some(
        ([props]) =>
          props.allowBlobImages === true &&
          props.markdown.includes('_[Attached image: diagram.png]_'),
      ),
    ).toBe(true);

    await waitFor(() =>
      expect(
        container?.querySelector<HTMLImageElement>(
          'img[alt="diagram.png"]',
        )?.src,
      ).toBe('blob:description-1'),
    );
    expect(
      markdownProps.mock.calls.some(
        ([props]) =>
          props.allowBlobImages === true &&
          props.markdown.includes('blob:description-1'),
      ),
    ).toBe(true);

    click(button('Save'));

    await waitFor(() => expect(updateDescription).toHaveBeenCalledTimes(1));
    expect(uploadAttachment).toHaveBeenCalledWith({
      fileName: 'diagram.png',
      mimeType: 'image/png',
      dataBase64: 'b3JpZ2luYWwtYmFzZTY0',
    });
    expect(updateDescription).toHaveBeenCalledWith(
      expect.stringContaining(
        '![diagram.png](https://example.com/uploaded-diagram.png)',
      ),
    );
    expect(updateDescription.mock.calls[0]?.[0]).not.toContain('AAAA');
    await waitFor(() => expect(container?.querySelector('textarea')).toBeNull());
  });
});
