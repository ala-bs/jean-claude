/**
 * @vitest-environment happy-dom
 */
/* eslint-disable sort-imports */
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


import type { PromptImagePart } from '@shared/agent-backend-types';


const { imagePreviewUrlsSpy, markdownRenderSpy, blobImageOptInSpy } = vi.hoisted(() => ({
  imagePreviewUrlsSpy: vi.fn(),
  markdownRenderSpy: vi.fn(),
  blobImageOptInSpy: vi.fn(),
}));

vi.mock('@/features/agent/ui-markdown-content', () => ({
  MarkdownContent: ({
    content,
    allowBlobImages,
  }: {
    content: string;
    allowBlobImages?: boolean;
  }) => {
    markdownRenderSpy(content);
    blobImageOptInSpy(allowBlobImages);
    return null;
  },
}));

vi.mock('@/hooks/use-image-preview-urls', () => ({
  useImagePreviewUrls: imagePreviewUrlsSpy,
}));


import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { InlineCommentBubble, InlineCommentComposer } from '.';


let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  const urlsByImages = new WeakMap<PromptImagePart[], string[]>();
  imagePreviewUrlsSpy.mockImplementation((images: PromptImagePart[]) => {
    let urls = urlsByImages.get(images);
    if (!urls) {
      urls = images.map((_, index) => `blob:preview-${index + 1}`);
      urlsByImages.set(images, urls);
    }
    return urls;
  });
});

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  imagePreviewUrlsSpy.mockReset();
  markdownRenderSpy.mockClear();
  blobImageOptInSpy.mockClear();
});

describe('InlineCommentComposer', () => {
  it('renders Blob previews without base64 and does not rerender them per keystroke', () => {
    const placeholderMarkdown = '![preview.gif](jc-image://1 =420x)';
    const gif = {
      type: 'image',
      mimeType: 'image/gif',
      data: 'large-gif-data',
      filename: 'preview.gif',
      placeholderMarkdown,
    } as PromptImagePart & { placeholderMarkdown: string };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        createElement(
          RootKeyboardBindings,
          null,
          createElement(InlineCommentComposer, {
            lineStart: 0,
            initialBody: placeholderMarkdown,
            initialImages: [gif],
            insertImagesInBody: true,
            onSubmit: vi.fn(),
            onCancel: vi.fn(),
          }),
        ),
      );
    });

    expect(markdownRenderSpy).toHaveBeenCalledTimes(1);
    expect(blobImageOptInSpy).toHaveBeenCalledWith(true);
    expect(markdownRenderSpy).toHaveBeenCalledWith(
      expect.stringContaining('![preview.gif](blob:preview-1 =420x)'),
    );
    expect(markdownRenderSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('large-gif-data'),
    );
    expect(
      container.querySelector<HTMLImageElement>('img[alt="preview.gif"]')?.src,
    ).toBe('blob:preview-1');
    expect(container.innerHTML).not.toContain('large-gif-data');

    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('Comment textarea not found');

    flushSync(() => {
      textarea.value = 'Comment with GIF preview and more text';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(markdownRenderSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps base64 image data unchanged when submitting', () => {
    const image: PromptImagePart = {
      type: 'image',
      mimeType: 'image/png',
      data: 'original-base64-data',
      filename: 'submit.png',
    };
    const onSubmit = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        createElement(
          RootKeyboardBindings,
          null,
          createElement(InlineCommentComposer, {
            lineStart: 0,
            initialBody: 'Comment',
            initialImages: [image],
            onSubmit,
            onCancel: vi.fn(),
          }),
        ),
      );
    });

    const submitButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Add comment'),
    );
    if (!submitButton) throw new Error('Submit button not found');
    flushSync(() => submitButton.click());

    expect(onSubmit).toHaveBeenCalledWith('Comment', [image]);
    expect(onSubmit.mock.calls[0]?.[1]?.[0]?.data).toBe('original-base64-data');
  });

  it('shows a removable lightweight attachment while a Blob URL is pending', () => {
    imagePreviewUrlsSpy.mockReturnValue([undefined]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        createElement(
          RootKeyboardBindings,
          null,
          createElement(InlineCommentComposer, {
            lineStart: 0,
            initialImages: [
              {
                type: 'image',
                mimeType: 'image/png',
                data: 'pending-base64-data',
                filename: 'pending.png',
              },
            ],
            onSubmit: vi.fn(),
            onCancel: vi.fn(),
          }),
        ),
      );
    });

    expect(container.textContent).toContain('pending.png');
    expect(container.querySelector('img[alt="pending.png"]')).toBeNull();
    expect(container.innerHTML).not.toContain('pending-base64-data');

    const removeButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove pending.png"]',
    );
    if (!removeButton) throw new Error('Remove attachment button not found');
    expect(removeButton.className).not.toContain('hidden');
    expect(removeButton.className).not.toContain('pointer-events-none');
    flushSync(() => removeButton.click());
    expect(container.textContent).not.toContain('pending.png');
  });

  it('updates pending media to Blob previews when URLs become ready', () => {
    const placeholderMarkdown = '![ready.png](jc-image://1 =240x)';
    const image = {
      type: 'image',
      mimeType: 'image/png',
      data: 'ready-base64-data',
      filename: 'ready.png',
      placeholderMarkdown,
    } as PromptImagePart & { placeholderMarkdown: string };
    const pendingUrls = [undefined];
    const readyUrls = ['blob:ready-preview'];
    let isReady = false;
    imagePreviewUrlsSpy.mockImplementation(() =>
      isReady ? readyUrls : pendingUrls,
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const renderComposer = () =>
      createElement(
        RootKeyboardBindings,
        null,
        createElement(InlineCommentComposer, {
          lineStart: 0,
          initialBody: placeholderMarkdown,
          initialImages: [image],
          insertImagesInBody: true,
          onSubmit: vi.fn(),
          onCancel: vi.fn(),
        }),
      );

    flushSync(() => root?.render(renderComposer()));
    expect(container.querySelector('img[alt="ready.png"]')).toBeNull();
    expect(markdownRenderSpy).toHaveBeenLastCalledWith(
      expect.stringContaining('Attached image: ready.png'),
    );

    isReady = true;
    flushSync(() => root?.render(renderComposer()));

    expect(
      container.querySelector<HTMLImageElement>('img[alt="ready.png"]')?.src,
    ).toBe('blob:ready-preview');
    expect(markdownRenderSpy).toHaveBeenLastCalledWith(
      expect.stringContaining('![ready.png](blob:ready-preview =240x)'),
    );
    expect(container.innerHTML).not.toContain('ready-base64-data');
  });

  it('updates displayed comment attachments from pending to Blob URLs', () => {
    const image: PromptImagePart = {
      type: 'image',
      mimeType: 'image/png',
      data: 'display-sentinel-base64',
      filename: 'display.png',
      sizeBytes: 2048,
    };
    const pendingUrls = [undefined];
    const readyUrls = ['blob:display-preview'];
    let isReady = false;
    imagePreviewUrlsSpy.mockImplementation(() =>
      isReady ? readyUrls : pendingUrls,
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const renderBubble = () =>
      createElement(InlineCommentBubble, {
        lineStart: 0,
        body: 'Existing comment',
        images: [image],
      });

    flushSync(() => root?.render(renderBubble()));
    expect(container.textContent).toContain('display.png');
    expect(container.querySelector('img[alt="display.png"]')).toBeNull();
    expect(container.innerHTML).not.toContain('display-sentinel-base64');

    isReady = true;
    flushSync(() => root?.render(renderBubble()));

    const thumbnail = container.querySelector<HTMLImageElement>(
      'img[alt="display.png"]',
    );
    expect(thumbnail?.src).toBe('blob:display-preview');
    expect(thumbnail?.title).toBe('2 KB');
    expect(container.innerHTML).not.toContain('display-sentinel-base64');
  });

  it('uses Blob previews while editing without exposing base64', () => {
    const placeholderMarkdown = '![preview.gif](jc-image://1 =320x)';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        createElement(
          RootKeyboardBindings,
          null,
          createElement(InlineCommentBubble, {
            lineStart: 0,
            body: placeholderMarkdown,
            images: [
              {
                type: 'image',
                mimeType: 'image/gif',
                data: 'large-gif-data',
                filename: 'preview.gif',
                placeholderMarkdown,
              } as PromptImagePart & { placeholderMarkdown: string },
            ],
            onEdit: vi.fn(),
          }),
        ),
      );
    });

    const editButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Edit comment"]',
    );
    if (!editButton) throw new Error('Edit button not found');
    expect(container.querySelector('textarea')).toBeNull();
    flushSync(() => editButton.click());

    expect(markdownRenderSpy).toHaveBeenCalledWith(
      expect.stringContaining('![preview.gif](blob:preview-1 =320x)'),
    );
    expect(
      container.querySelector<HTMLImageElement>('img[alt="preview.gif"]')?.src,
    ).toBe('blob:preview-1');
    expect(container.innerHTML).not.toContain('large-gif-data');

    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('Edit textarea not found');
    flushSync(() => {
      textarea.value = 'Existing comment with more text';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(textarea.value).toBe('Existing comment with more text');
    expect(
      container.querySelector<HTMLImageElement>('img[alt="preview.gif"]')?.src,
    ).toBe('blob:preview-1');
    expect(container.innerHTML).not.toContain('large-gif-data');
  });
});
