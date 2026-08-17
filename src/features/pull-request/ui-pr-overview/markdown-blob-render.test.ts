/**
 * @vitest-environment happy-dom
 */
/* eslint-disable sort-imports */
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { MarkdownContent } from '@/features/agent/ui-markdown-content';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
});

function renderMarkdown(
  allowBlobImages = false,
  content =
    '![Local preview](blob:local-preview)\n\n[Unsafe link](blob:local-link)',
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root?.render(
      createElement(
        RootKeyboardBindings,
        null,
        createElement(MarkdownContent, {
          content,
          allowBlobImages,
        }),
      ),
    );
  });
}

describe('MarkdownContent Blob images', () => {
  it('rejects Blob images by default', () => {
    renderMarkdown();

    expect(container?.querySelector('img')).toBeNull();
  });

  it('renders Blob images with opt-in but still rejects Blob links', () => {
    renderMarkdown(true);

    expect(container?.querySelector<HTMLImageElement>('img')?.src).toBe(
      'blob:local-preview',
    );
    expect(container?.querySelector('a')?.getAttribute('href')).not.toBe(
      'blob:local-link',
    );
  });

  it('offers frame scrubbing for tagged Blob GIFs only', () => {
    renderMarkdown(
      true,
      '![GIF](blob:gif-preview#jc-mime=image%2Fgif)\n\n![PNG](blob:png-preview)',
    );

    expect(container?.textContent).toContain('Scrub frames');
    expect(container?.querySelectorAll('img')).toHaveLength(2);
    expect(container?.querySelectorAll('[role="button"]')).toHaveLength(1);
  });
});
