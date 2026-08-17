// @vitest-environment happy-dom

import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { flushSync } from 'react-dom';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/common/ui/modal', () => ({ Modal: () => null }));
vi.mock('@/features/common/ui-mermaid-diagram', () => ({
  MermaidDiagram: ({ source }: { source: string }) =>
    createElement('div', { 'data-testid': 'mermaid-diagram' }, source),
}));

import { MarkdownContent } from '@/features/agent/ui-markdown-content';

describe('MarkdownContent Mermaid fences', () => {
  let container: HTMLDivElement;
  let root: Root;
  const content = '```mermaid\nflowchart LR\nA --> B\n```';

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  it('renders Mermaid as code by default and as a diagram only when enabled', () => {
    flushSync(() => root.render(createElement(MarkdownContent, { content })));

    expect(container.querySelector('[data-testid="mermaid-diagram"]')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe(
      'flowchart LR\nA --> B',
    );

    flushSync(() =>
      root.render(
        createElement(MarkdownContent, { content, renderMermaid: true }),
      ),
    );

    expect(container.querySelector('[data-testid="mermaid-diagram"]')?.textContent).toBe(
      'flowchart LR\nA --> B',
    );
  });
});
