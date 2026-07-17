/**
 * @vitest-environment happy-dom
 */
/* eslint-disable sort-imports */
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/image-utils', () => ({
  MAX_IMAGES: 5,
  processImageFile: async (
    file: File,
    onAttach: (image: {
      type: 'image';
      data: string;
      mimeType: string;
      filename: string;
    }) => void,
  ) =>
    onAttach({
      type: 'image',
      data: `payload:${file.name}`,
      mimeType: file.type,
      filename: file.name,
    }),
}));

import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { FileDiffContent } from '@/features/common/ui-file-diff';
import { PrCommentForm } from '@/features/pull-request/ui-pr-comment-form';
import { PrDiffView } from '@/features/pull-request/ui-pr-diff-view';
import {
  prFileKey,
  usePrCommentDraftsStore,
} from '@/stores/pr-comment-drafts';

let renderedRoot: Root | null = null;
let renderedContainer: HTMLDivElement | null = null;

afterEach(() => {
  renderedRoot?.unmount();
  renderedRoot = null;
  renderedContainer?.remove();
  renderedContainer = null;
  usePrCommentDraftsStore.setState({ drafts: {} });
});

function renderFileDiff(onAskAgent: Parameters<typeof FileDiffContent>[0]['onAskAgent']) {
  renderedContainer = document.createElement('div');
  document.body.appendChild(renderedContainer);
  renderedRoot = createRoot(renderedContainer);
  flushSync(() =>
    renderedRoot?.render(
      createElement(FileDiffContent, {
        file: { path: 'src/removed.ts', status: 'deleted' },
        oldContent: 'alpha\nbeta\ngamma',
        newContent: '',
        onAskAgent,
      }),
    ),
  );
}

function renderFileDiffContent(
  props: Partial<Parameters<typeof FileDiffContent>[0]> = {},
) {
  renderedContainer = document.createElement('div');
  document.body.appendChild(renderedContainer);
  renderedRoot = createRoot(renderedContainer);
  flushSync(() =>
    renderedRoot?.render(
      createElement(
        RootKeyboardBindings,
        null,
        createElement(FileDiffContent, {
          file: { path: 'src/file.ts', status: 'modified' },
          oldContent: 'alpha\nbeta\ngamma',
          newContent: 'alpha\nbeta changed\ngamma',
          ...props,
        }),
      ),
    ),
  );
}

function renderPrDiffView(
  onAddFileComment: NonNullable<
    Parameters<typeof PrDiffView>[0]['onAddFileComment']
  >,
) {
  renderedContainer = document.createElement('div');
  document.body.appendChild(renderedContainer);
  renderedRoot = createRoot(renderedContainer);
  flushSync(() =>
    renderedRoot?.render(
      createElement(
        RootKeyboardBindings,
        null,
        createElement(PrDiffView, {
          file: { path: '/src/file.ts', changeType: 'edit' },
          baseContent: 'alpha\nbeta\ngamma',
          headContent: 'alpha\nbeta changed\ngamma',
          isLoadingContent: false,
          threads: [],
          projectId: 'project',
          prId: 7,
          onAddFileComment,
        }),
      ),
    ),
  );
}

async function waitForElement<T extends Element>(query: () => T | null) {
  for (let i = 0; i < 25; i += 1) {
    const element = query();
    if (element) return element;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Element not found');
}

async function waitForAssertion(assertion: () => void) {
  for (let i = 0; i < 25; i += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  assertion();
}

function mouse(element: Element, type: string) {
  flushSync(() => {
    element.dispatchEvent(
      new MouseEvent(type, { bubbles: true, button: 0, clientX: 24, clientY: 48 }),
    );
  });
}

function click(element: Element) {
  flushSync(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function typeInto(textarea: HTMLTextAreaElement, value: string) {
  flushSync(() => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    valueSetter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function getButtonByText(text: string) {
  const button = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function getButtonContaining(text: string) {
  const button = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`Button not found containing: ${text}`);
  return button;
}

describe('FileDiffContent Ask Agent selection', () => {
  it('submits deleted old-side selected text with side and file anchor', async () => {
    const onAskAgent = vi.fn().mockResolvedValue(undefined);
    renderFileDiff(onAskAgent);

    const deletedRow = await waitForElement(() =>
      document.querySelector('tr[data-old-line="2"]'),
    );
    mouse(deletedRow, 'mousedown');
    mouse(deletedRow, 'mouseup');

    click(getButtonByText('Ask Agent'));

    const textarea = await waitForElement(() =>
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Ask agent about selected lines"]',
      ),
    );
    typeInto(textarea, 'Why was this removed?');
    click(getButtonByText('Ask Agent'));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onAskAgent).toHaveBeenCalledWith({
      filePath: 'src/removed.ts',
      lineStart: 2,
      lineEnd: undefined,
      side: 'old',
      selectedText: 'beta',
      question: 'Why was this removed?',
    });
  });

  it('opens comment composer by default and sends its value to Ask Agent', async () => {
    const onAskAgent = vi.fn().mockResolvedValue(undefined);
    renderFileDiffContent({
      onAskAgent,
      onAddComment: vi.fn(),
      renderCommentForm: (props) => createElement(PrCommentForm, props),
    });

    const changedRow = await waitForElement(() =>
      document.querySelector('tr[data-new-line="2"]'),
    );
    mouse(changedRow, 'mousedown');
    mouse(changedRow, 'mouseup');

    const commentTextarea = await waitForElement(() =>
      document.querySelector<HTMLTextAreaElement>(
        'textarea[placeholder="Write a comment..."]',
      ),
    );
    typeInto(commentTextarea, 'Should this change?');
    click(getButtonByText('Ask Agent'));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      document.querySelector(
        'textarea[aria-label="Ask agent about selected lines"]',
      ),
    ).toBeNull();

    expect(onAskAgent).toHaveBeenCalledWith({
      filePath: 'src/file.ts',
      lineStart: 2,
      lineEnd: undefined,
      side: 'new',
      selectedText: 'beta changed',
      question: 'Should this change?',
    });
  });
});

describe('PrDiffView comment submission', () => {
  it('retains range and persisted draft on failure, then clears both on success', async () => {
    const onAddFileComment = vi
      .fn()
      .mockRejectedValueOnce(new Error('File comment failed. Retry.'))
      .mockResolvedValueOnce(undefined);
    renderPrDiffView(onAddFileComment);

    const changedRow = await waitForElement(() =>
      document.querySelector('tr[data-new-line="2"]'),
    );
    mouse(changedRow, 'mousedown');
    mouse(changedRow, 'mouseup');

    const textarea = await waitForElement(() =>
      document.querySelector<HTMLTextAreaElement>(
        'textarea[placeholder="Write a comment..."]',
      ),
    );
    typeInto(textarea, 'Persist this file comment');
    click(getButtonContaining('Add comment'));

    await waitForAssertion(() =>
      expect(document.body.textContent).toContain('File comment failed. Retry.'),
    );
    expect(textarea.value).toBe('Persist this file comment');
    expect(
      usePrCommentDraftsStore.getState().drafts[
        prFileKey(7, '/src/file.ts')
      ]?.['2']?.body,
    ).toBe('Persist this file comment');
    expect(document.querySelector('tr[data-new-line="2"]')).not.toBeNull();

    click(getButtonContaining('Add comment'));
    await waitForAssertion(() =>
      expect(
        document.querySelector<HTMLTextAreaElement>(
          'textarea[placeholder="Write a comment..."]',
        ),
      ).toBeNull(),
    );

    expect(onAddFileComment).toHaveBeenCalledTimes(2);
    expect(
      usePrCommentDraftsStore.getState().drafts[
        prFileKey(7, '/src/file.ts')
      ],
    ).toBeUndefined();
  });

  it('keeps task review draft and reuses uploads across upload and post failures', async () => {
    const onAddReviewComment = vi.fn();
    const onPost = vi
      .fn()
      .mockRejectedValueOnce(new Error('PR post failed'))
      .mockResolvedValueOnce(undefined);
    const uploadedImages: Array<{ data: string; filename?: string }> = [];
    const uploadImage = vi.fn(
      async (image: { data: string; filename?: string }, fileName: string) => {
        uploadedImages.push(image);
        if (fileName === 'second.png' && uploadImage.mock.calls.length === 2) {
          throw new Error('Second task upload failed');
        }
        return `https://example.test/${fileName}`;
      },
    );
    renderedContainer = document.createElement('div');
    document.body.appendChild(renderedContainer);
    renderedRoot = createRoot(renderedContainer);
    flushSync(() =>
      renderedRoot?.render(
        createElement(
          RootKeyboardBindings,
          null,
          createElement(PrDiffView, {
            file: { path: '/src/file.ts', changeType: 'edit' },
            baseContent: 'alpha\nbeta\ngamma',
            headContent: 'alpha\nbeta changed\ngamma',
            isLoadingContent: false,
            threads: [],
            projectId: 'project',
            prId: 7,
            onAddReviewComment,
            onAddReviewCommentAsPrComment: onPost,
            onUploadReviewAsPrImage: uploadImage,
          }),
        ),
      ),
    );

    const changedRow = await waitForElement(() =>
      document.querySelector('tr[data-new-line="2"]'),
    );
    mouse(changedRow, 'mousedown');
    mouse(changedRow, 'mouseup');
    const textarea = await waitForElement(() =>
      document.querySelector<HTMLTextAreaElement>(
        'textarea[placeholder="Leave an instruction for this line..."]',
      ),
    );
    typeInto(textarea, 'Task review draft');
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        files: [
          new File(['first'], 'first.png', { type: 'image/png' }),
          new File(['second'], 'second.png', { type: 'image/png' }),
        ],
      },
    });
    flushSync(() => textarea.dispatchEvent(paste));

    click(getButtonByText('Post to PR'));
    await waitForAssertion(() =>
      expect(document.body.textContent).toContain('Second task upload failed'),
    );
    expect(onPost).not.toHaveBeenCalled();
    expect(textarea.value).toBe('Task review draft');

    typeInto(textarea, 'Edited task review draft');
    click(getButtonByText('Post to PR'));
    await waitForAssertion(() =>
      expect(document.body.textContent).toContain('PR post failed'),
    );
    expect(uploadImage.mock.calls.map((call) => call[1])).toEqual([
      'first.png',
      'second.png',
      'second.png',
    ]);

    const firstImage = uploadedImages[0];
    if (!firstImage) throw new Error('First task image not captured');
    firstImage.data = 'changed-task-payload';
    firstImage.filename = 'renamed.png';
    click(getButtonByText('Post to PR'));
    await waitForAssertion(() =>
      expect(
        document.querySelector<HTMLTextAreaElement>(
          'textarea[placeholder="Leave an instruction for this line..."]',
        ),
      ).toBeNull(),
    );

    expect(uploadImage.mock.calls.map((call) => call[1])).toEqual([
      'first.png',
      'second.png',
      'second.png',
      'renamed.png',
    ]);
    expect(onPost).toHaveBeenCalledTimes(2);
    expect(onPost.mock.calls[1]?.[0].content).toContain('Edited task review draft');
  });

  it('locks task review controls and blocks duplicate posting while pending', async () => {
    let resolvePost!: () => void;
    const postPending = new Promise<void>((resolve) => {
      resolvePost = resolve;
    });
    const onPost = vi.fn(() => postPending);
    const onAskAgent = vi.fn();
    renderedContainer = document.createElement('div');
    document.body.appendChild(renderedContainer);
    renderedRoot = createRoot(renderedContainer);
    flushSync(() =>
      renderedRoot?.render(
        createElement(
          RootKeyboardBindings,
          null,
          createElement(PrDiffView, {
            file: { path: '/src/file.ts', changeType: 'edit' },
            baseContent: 'alpha\nbeta\ngamma',
            headContent: 'alpha\nbeta changed\ngamma',
            isLoadingContent: false,
            threads: [],
            projectId: 'project',
            prId: 7,
            onAddReviewComment: vi.fn(),
            onAddReviewCommentAsPrComment: onPost,
            onUploadReviewAsPrImage: vi
              .fn()
              .mockResolvedValue('https://example.test/evidence.png'),
            onAskAgent: ({ question }) => onAskAgent(question),
          }),
        ),
      ),
    );

    const changedRow = await waitForElement(() =>
      document.querySelector('tr[data-new-line="2"]'),
    );
    mouse(changedRow, 'mousedown');
    mouse(changedRow, 'mouseup');
    const textarea = await waitForElement(() =>
      document.querySelector<HTMLTextAreaElement>(
        'textarea[placeholder="Leave an instruction for this line..."]',
      ),
    );
    typeInto(textarea, 'Pending task review');
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        files: [new File(['image'], 'evidence.png', { type: 'image/png' })],
      },
    });
    flushSync(() => textarea.dispatchEvent(paste));
    click(getButtonByText('Post to PR'));

    await waitForAssertion(() => expect(onPost).toHaveBeenCalledTimes(1));
    const postingButton = getButtonByText('Posting...');
    expect(postingButton).toHaveProperty('disabled', true);
    expect(textarea).toHaveProperty('disabled', true);
    expect(getButtonContaining('Add comment')).toHaveProperty('disabled', true);
    expect(getButtonByText('Cancel')).toHaveProperty('disabled', true);
    expect(getButtonByText('Ask Agent')).toHaveProperty('disabled', true);
    expect(
      document.querySelector('button[aria-label="Remove evidence.png"]'),
    ).toBeNull();

    click(postingButton);
    click(getButtonContaining('Add comment'));
    click(getButtonByText('Ask Agent'));
    expect(onPost).toHaveBeenCalledTimes(1);
    expect(onAskAgent).not.toHaveBeenCalled();

    resolvePost();
    await waitForAssertion(() =>
      expect(
        document.querySelector<HTMLTextAreaElement>(
          'textarea[placeholder="Leave an instruction for this line..."]',
        ),
      ).toBeNull(),
    );
  });
});
