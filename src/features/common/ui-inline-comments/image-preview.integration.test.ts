// @vitest-environment happy-dom
/* eslint-disable sort-imports */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptImagePart } from '@shared/agent-backend-types';

vi.mock('@/features/agent/ui-markdown-content', () => ({
  MarkdownContent: () => null,
}));

import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { InlineCommentComposer } from '.';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

describe('InlineCommentComposer image preview integration', () => {
  let container: HTMLDivElement;
  let root: Root;
  const createObjectUrl = vi.fn((_blob: Blob) => 'blob:inline-preview');
  const revokeObjectUrl = vi.fn();

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    createObjectUrl.mockClear();
    revokeObjectUrl.mockClear();
    vi.stubGlobal('URL', {
      createObjectURL: createObjectUrl,
      revokeObjectURL: revokeObjectUrl,
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('revokes and removes generated preview state when attachment is removed', async () => {
    const placeholderMarkdown = '![inline.png](jc-image://1 =240x)';
    const image = {
      type: 'image',
      data: btoa('inline-image'),
      mimeType: 'image/png',
      filename: 'inline.png',
      placeholderMarkdown,
    } as PromptImagePart & { placeholderMarkdown: string };

    await act(async () => {
      root.render(
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
        ),
      );
    });

    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector<HTMLImageElement>('img[alt="inline.png"]')?.src,
    ).toBe('blob:inline-preview');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
      placeholderMarkdown,
    );

    const removeButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove inline.png"]',
    );
    if (!removeButton) throw new Error('Remove attachment button not found');
    await act(async () => removeButton.click());

    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:inline-preview');
    expect(container.querySelector('img[alt="inline.png"]')).toBeNull();
    expect(container.textContent).not.toContain('inline.png');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
      '',
    );
  });
});
