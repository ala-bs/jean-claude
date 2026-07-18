// @vitest-environment happy-dom

import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { flushSync } from 'react-dom';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock('mermaid', () => ({ default: mocks }));

import { MermaidDiagram } from '.';

describe('MermaidDiagram', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    mocks.initialize.mockReset();
    mocks.render.mockReset();
    mocks.render.mockResolvedValue({ svg: '<svg><text>Diagram</text></svg>' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  it('renders with strict Mermaid security and disabled HTML labels', async () => {
    flushSync(() =>
      root.render(createElement(MermaidDiagram, { source: 'flowchart LR\nA --> B' })),
    );

    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="mermaid-diagram"]')).not.toBeNull(),
    );
    expect(mocks.initialize).toHaveBeenCalledWith({
      startOnLoad: false,
      securityLevel: 'strict',
      flowchart: { htmlLabels: false },
    });
    expect(container.innerHTML).toContain('Diagram');
  });

  it('falls back to escaped source after render failure', async () => {
    mocks.render.mockRejectedValue(new Error('bad syntax'));
    const source = 'flowchart <invalid>';
    flushSync(() => root.render(createElement(MermaidDiagram, { source })));

    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="mermaid-fallback"]')).not.toBeNull(),
    );
    expect(container.textContent).toBe(source);
    expect(container.innerHTML).not.toContain('<invalid>');
  });

  it('rejects same-line unsafe directives before rendering', async () => {
    flushSync(() =>
      root.render(
        createElement(MermaidDiagram, {
          source: 'flowchart LR; A --> B; click A "https://example.test"',
        }),
      ),
    );

    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="mermaid-fallback"]')).not.toBeNull(),
    );
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it('uses unique render IDs across component instances', async () => {
    flushSync(() =>
      root.render(
        createElement(MermaidDiagram, {
          key: 'first',
          source: 'flowchart LR\nA --> B',
        }),
      ),
    );
    await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(1));
    flushSync(() =>
      root.render(
        createElement(MermaidDiagram, {
          key: 'second',
          source: 'flowchart LR\nB --> C',
        }),
      ),
    );

    await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(2));
    expect(mocks.render.mock.calls[0][0]).not.toBe(mocks.render.mock.calls[1][0]);
  });
});
