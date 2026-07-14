/**
 * @vitest-environment happy-dom
 */
/* eslint-disable sort-imports */
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { addReply, updateStatus } = vi.hoisted(() => ({
  addReply: vi.fn(),
  updateStatus: vi.fn(),
}));

vi.mock('@/hooks/use-pull-requests', () => ({
  useAddThreadReply: () => ({ mutateAsync: addReply, isPending: false }),
  useCommitFileContent: vi.fn(),
  useCurrentAzureUser: vi.fn(),
  useDeleteThreadComment: vi.fn(),
  usePullRequestFileContent: vi.fn(),
  useSetThreadCommentLike: vi.fn(),
  useUpdateThreadComment: vi.fn(),
  useUpdateThreadStatus: () => ({ mutate: updateStatus, isPending: false }),
}));

vi.mock('@/lib/image-utils', () => ({
  MAX_IMAGES: 5,
  processImageFile: async (
    file: File,
    onAttach: (image: {
      type: 'image';
      data: string;
      mimeType: string;
      filename?: string;
    }) => void,
  ) => {
    const image = {
      type: 'image',
      data: 'staged-image-data',
      mimeType: file.type,
      filename: file.name.startsWith('unnamed-') ? undefined : file.name,
    } as const;
    onAttach(image);
  },
}));

vi.mock('@/hooks/use-image-preview-urls', () => ({
  useImagePreviewUrls: () => [],
}));

vi.mock('@/features/agent/ui-markdown-content', () => ({
  MarkdownContent: () => null,
}));

import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import {
  PrComments,
  ThreadReplyForm,
} from '@/features/pull-request/ui-pr-comments';
import { createPromptImageUploadCache } from '@/lib/prompt-image-upload-cache';
import { PrCommentForm, uploadImagesIntoMarkdown } from '.';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  addReply.mockReset();
  updateStatus.mockReset();
});

function render(element: ReturnType<typeof createElement>) {
  flushSync(() => {
    root?.render(createElement(RootKeyboardBindings, null, element));
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
  });
}

function button(label: string) {
  const match = Array.from(container?.querySelectorAll('button') ?? []).find(
    (candidate) => candidate.textContent?.includes(label),
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

async function waitFor(assertion: () => void) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  assertion();
}

describe('PrCommentForm async submission', () => {
  it('appends attachments in selection order when uploads resolve out of order', async () => {
    const resolvers = new Map<string, (url: string) => void>();
    const uploadImage = vi.fn(
      (_image: unknown, fileName: string) =>
        new Promise<string>((resolve) => {
          resolvers.set(fileName, resolve);
        }),
    );
    const previewImage = {
      type: 'image' as const,
      data: 'preview',
      mimeType: 'image/png',
      filename: 'preview.png',
      placeholderMarkdown: '![preview](jc-image://preview)',
    };
    const upload = uploadImagesIntoMarkdown({
      body: 'Evidence ![preview](jc-image://preview =320x)',
      images: [
        {
          type: 'image',
          data: 'first',
          mimeType: 'image/png',
          filename: 'first.png',
        },
        previewImage,
        {
          type: 'image',
          data: 'third',
          mimeType: 'image/png',
          filename: 'third.png',
        },
      ],
      uploadImage,
    });

    expect(uploadImage).toHaveBeenCalledTimes(3);
    resolvers.get('third.png')?.('third-url');
    resolvers.get('preview.png')?.('preview-url');
    resolvers.get('first.png')?.('first-url');

    await expect(upload).resolves.toBe(
      'Evidence ![preview](preview-url =320x)\n\n' +
        '![first.png](first-url)\n\n' +
        '![third.png](third-url)',
    );
  });

  it('reuses a still-pending sibling on immediate Promise.all retry', async () => {
    let resolveFirst!: (url: string) => void;
    const firstUpload = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const uploadImage = vi.fn(
      (_image: unknown, fileName: string): Promise<string> => {
        if (fileName === 'first.png') return firstUpload;
        if (
          uploadImage.mock.calls.filter((call) => call[1] === 'second.png')
            .length === 1
        ) {
          return Promise.reject(new Error('second failed'));
        }
        return Promise.resolve('second-url');
      },
    );
    const images = [
      {
        type: 'image' as const,
        data: 'first',
        mimeType: 'image/png',
        filename: 'first.png',
      },
      {
        type: 'image' as const,
        data: 'second',
        mimeType: 'image/png',
        filename: 'second.png',
      },
    ];
    const uploadCache = createPromptImageUploadCache();
    const upload = () =>
      uploadImagesIntoMarkdown({
        body: 'Evidence',
        images,
        uploadImage,
        uploadCache,
      });

    await expect(upload()).rejects.toThrow('second failed');
    const retry = upload();

    expect(uploadImage.mock.calls.map((call) => call[1])).toEqual([
      'first.png',
      'second.png',
      'second.png',
    ]);
    resolveFirst('first-url');
    await expect(retry).resolves.toContain('first-url');
    expect(uploadImage.mock.calls.filter((call) => call[1] === 'first.png')).toHaveLength(1);
  });

  it('retries only failed uploads and reuses successful uploads after post failure', async () => {
    const uploadImage = vi.fn(
      async (_image: unknown, fileName: string) => {
        if (fileName === 'second.png' && uploadImage.mock.calls.length === 2) {
          throw new Error('Second upload failed');
        }
        return `https://example.test/${fileName}`;
      },
    );
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error('Post failed'))
      .mockResolvedValueOnce(undefined);
    render(createElement(PrCommentForm, { onSubmit, uploadImage }));

    const textarea = container?.querySelector('textarea');
    if (!textarea) throw new Error('Comment textarea not found');
    typeInto(textarea, 'Review evidence');
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

    flushSync(() => button('Add comment').click());
    await waitFor(() =>
      expect(container?.textContent).toContain('Second upload failed'),
    );
    await waitFor(() => expect(button('Add comment').hasAttribute('disabled')).toBe(false));
    expect(onSubmit).not.toHaveBeenCalled();

    typeInto(textarea, `Edited body\n\n${textarea.value}`);
    flushSync(() => button('Add comment').click());
    await waitFor(() => expect(container?.textContent).toContain('Post failed'));
    await waitFor(() => expect(button('Add comment').hasAttribute('disabled')).toBe(false));
    expect(uploadImage.mock.calls.map((call) => call[1])).toEqual([
      'first.png',
      'second.png',
      'second.png',
    ]);

    flushSync(() => button('Add comment').click());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(container?.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
        '',
      ),
    );

    expect(uploadImage.mock.calls.map((call) => call[1])).toEqual([
      'first.png',
      'second.png',
      'second.png',
    ]);
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('preserves synchronous submit and clear behavior', () => {
    const onSubmit = vi.fn();
    render(createElement(PrCommentForm, { onSubmit }));

    const textarea = container?.querySelector('textarea');
    if (!textarea) throw new Error('Comment textarea not found');
    typeInto(textarea, 'Synchronous comment');
    flushSync(() => button('Send').click());

    expect(onSubmit).toHaveBeenCalledWith('Synchronous comment');
    expect(textarea.value).toBe('');
  });

  it('clears only after success and blocks duplicate submissions while pending', async () => {
    let resolveSubmission: (() => void) | undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmission = resolve;
        }),
    );
    render(createElement(PrCommentForm, { onSubmit }));

    const textarea = container?.querySelector('textarea');
    if (!textarea) throw new Error('Comment textarea not found');
    typeInto(textarea, 'Keep until sent');
    flushSync(() => button('Send').click());

    expect(textarea.value).toBe('Keep until sent');
    expect(button('Sending...')).toHaveProperty('disabled', true);
    flushSync(() => button('Sending...').click());
    expect(onSubmit).toHaveBeenCalledTimes(1);

    resolveSubmission?.();
    await waitFor(() => expect(textarea.value).toBe(''));
  });

  it('retains a rejected top-level PR comment and shows its error', async () => {
    const onAddComment = vi
      .fn()
      .mockRejectedValue(new Error('Comment failed. Check access and retry.'));
    const onUploadImage = vi
      .fn()
      .mockResolvedValue('https://example.test/top-level.png');
    render(
      createElement(PrComments, {
        threads: [],
        projectId: 'project',
        prId: 7,
        onAddComment,
        onUploadImage,
      }),
    );

    const textarea = container?.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder="Start a new comment thread..."]',
    );
    if (!textarea) throw new Error('Top-level comment textarea not found');
    typeInto(textarea, 'Keep top-level draft');
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        files: [
          new File(['top-level'], 'top-level.png', { type: 'image/png' }),
        ],
      },
    });
    flushSync(() => textarea.dispatchEvent(paste));
    flushSync(() => button('Add comment').click());

    await waitFor(() =>
      expect(container?.textContent).toContain(
        'Comment failed. Check access and retry.',
      ),
    );
    expect(textarea.value).toContain('Keep top-level draft');
    expect(textarea.value).toContain('jc-image://');
    expect(container?.textContent).toContain('top-level.png');
    expect(onAddComment).toHaveBeenCalledTimes(1);
    expect(onUploadImage).toHaveBeenCalledTimes(1);
  });

  it('reuses uploaded images after body, placeholder, and attachment changes', async () => {
    const uploadImage = vi.fn(
      async (_image: unknown, fileName: string) =>
        `https://example.test/${fileName}`,
    );
    addReply
      .mockRejectedValueOnce(new Error('Reply failed. Check connection and retry.'))
      .mockResolvedValueOnce(undefined);
    render(
      createElement(ThreadReplyForm, {
        threadId: 42,
        projectId: 'project',
        prId: 7,
        canResolve: false,
        onUploadImage: uploadImage,
      }),
    );

    flushSync(() => button('Reply...').click());
    const textarea = container?.querySelector('textarea');
    if (!textarea) throw new Error('Reply textarea not found');
    typeInto(textarea, 'Reply with evidence');

    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        files: [new File(['image'], 'reply.png', { type: 'image/png' })],
      },
    });
    flushSync(() => textarea.dispatchEvent(paste));
    expect(textarea.value).toContain('jc-image://');

    const initialSecondPaste = new Event('paste', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(initialSecondPaste, 'clipboardData', {
      value: {
        files: [new File(['old'], 'old.png', { type: 'image/png' })],
      },
    });
    flushSync(() => textarea.dispatchEvent(initialSecondPaste));

    flushSync(() => button('Add comment').click());
    await waitFor(() =>
      expect(container?.textContent).toContain(
        'Reply failed. Check connection and retry.',
      ),
    );

    expect(textarea.value).toContain('Reply with evidence');
    expect(textarea.value).toContain('jc-image://');
    expect(container?.textContent).toContain('reply.png');
    expect(container?.textContent).toContain('old.png');
    expect(button('Add comment')).toBeTruthy();
    expect(addReply.mock.calls[0]?.[0].content).toContain(
      'https://example.test/reply.png',
    );
    expect(addReply.mock.calls[0]?.[0].content).toContain(
      'https://example.test/old.png',
    );

    typeInto(
      textarea,
      'Edited reply ![moved old](jc-image://2) ![renamed preview](jc-image://1 =320x)',
    );
    const removeOldImage = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove old.png"]',
    );
    if (!removeOldImage) throw new Error('Remove old image button not found');
    flushSync(() => removeOldImage.click());
    const secondPaste = new Event('paste', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(secondPaste, 'clipboardData', {
      value: {
        files: [new File(['second'], 'new.png', { type: 'image/png' })],
      },
    });
    flushSync(() => textarea.dispatchEvent(secondPaste));

    flushSync(() => button('Add comment').click());
    await waitFor(() => expect(container?.textContent).toContain('Reply...'));

    expect(container?.querySelector('textarea')).toBeNull();
    expect(addReply).toHaveBeenCalledTimes(2);
    expect(addReply.mock.calls[1]?.[0].content).toContain(
      '![renamed preview](https://example.test/reply.png =320x)',
    );
    expect(addReply.mock.calls[1]?.[0].content).toContain(
      'https://example.test/new.png',
    );
    expect(addReply.mock.calls[1]?.[0].content).not.toContain('old.png');
    expect(uploadImage).toHaveBeenCalledTimes(3);
    expect(uploadImage.mock.calls.map((call) => call[1])).toEqual([
      'reply.png',
      'old.png',
      'new.png',
    ]);
  });

  it('reuploads an unnamed image when removal changes its fallback filename', async () => {
    const uploadImage = vi.fn(
      async (_image: unknown, fileName: string) =>
        `https://example.test/${fileName}`,
    );
    addReply
      .mockRejectedValueOnce(new Error('Reply failed. Retry.'))
      .mockResolvedValueOnce(undefined);
    render(
      createElement(ThreadReplyForm, {
        threadId: 42,
        projectId: 'project',
        prId: 7,
        canResolve: false,
        onUploadImage: uploadImage,
      }),
    );

    flushSync(() => button('Reply...').click());
    const textarea = container?.querySelector('textarea');
    if (!textarea) throw new Error('Reply textarea not found');
    typeInto(textarea, 'Unnamed images');

    for (const fileName of ['unnamed-first.png', 'unnamed-second.png']) {
      const paste = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(paste, 'clipboardData', {
        value: {
          files: [new File([fileName], fileName, { type: 'image/png' })],
        },
      });
      flushSync(() => textarea.dispatchEvent(paste));
    }

    flushSync(() => button('Add comment').click());
    await waitFor(() =>
      expect(container?.textContent).toContain('Reply failed. Retry.'),
    );
    expect(uploadImage.mock.calls.map((call) => call[1])).toEqual([
      'image-1.png',
      'image-2.png',
    ]);

    const removeButtons = container?.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Remove attached image"]',
    );
    if (!removeButtons?.[0]) throw new Error('Remove unnamed image button not found');
    flushSync(() => removeButtons[0].click());
    flushSync(() => button('Add comment').click());
    await waitFor(() => expect(container?.textContent).toContain('Reply...'));

    expect(uploadImage.mock.calls.map((call) => call[1])).toEqual([
      'image-1.png',
      'image-2.png',
      'image-1.png',
    ]);
    expect(addReply.mock.calls[1]?.[0].content).toContain(
      'https://example.test/image-1.png',
    );
    expect(addReply.mock.calls[1]?.[0].content).not.toContain(
      'https://example.test/image-2.png',
    );
  });

  it('reuploads an image when its explicit filename changes', async () => {
    const uploadImage = vi.fn(
      async (_image: unknown, fileName: string) =>
        `https://example.test/${fileName}`,
    );
    addReply
      .mockRejectedValueOnce(new Error('Reply failed. Retry.'))
      .mockResolvedValueOnce(undefined);
    render(
      createElement(ThreadReplyForm, {
        threadId: 42,
        projectId: 'project',
        prId: 7,
        canResolve: false,
        onUploadImage: uploadImage,
      }),
    );

    flushSync(() => button('Reply...').click());
    const textarea = container?.querySelector('textarea');
    if (!textarea) throw new Error('Reply textarea not found');
    typeInto(textarea, 'Renamed image');
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        files: [new File(['image'], 'original.png', { type: 'image/png' })],
      },
    });
    flushSync(() => textarea.dispatchEvent(paste));

    flushSync(() => button('Add comment').click());
    await waitFor(() =>
      expect(container?.textContent).toContain('Reply failed. Retry.'),
    );
    const stagedImage = uploadImage.mock.calls[0]?.[0] as
      | { filename?: string }
      | undefined;
    if (!stagedImage) throw new Error('Staged image not found');
    stagedImage.filename = 'renamed.png';

    flushSync(() => button('Add comment').click());
    await waitFor(() => expect(container?.textContent).toContain('Reply...'));

    expect(uploadImage.mock.calls.map((call) => call[1])).toEqual([
      'original.png',
      'renamed.png',
    ]);
    expect(addReply.mock.calls[1]?.[0].content).toContain(
      'https://example.test/renamed.png',
    );
  });
});
