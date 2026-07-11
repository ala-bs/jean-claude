/**
 * @vitest-environment happy-dom
 */
/* eslint-disable sort-imports */
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { FileDiffContent } from '@/features/common/ui-file-diff';
import { PrCommentForm } from '@/features/pull-request/ui-pr-comment-form';

let renderedRoot: Root | null = null;
let renderedContainer: HTMLDivElement | null = null;

afterEach(() => {
  renderedRoot?.unmount();
  renderedRoot = null;
  renderedContainer?.remove();
  renderedContainer = null;
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

async function waitForElement<T extends Element>(query: () => T | null) {
  for (let i = 0; i < 25; i += 1) {
    const element = query();
    if (element) return element;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Element not found');
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
