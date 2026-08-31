// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { AnsiLine } from '@/features/common/interactive-log/ansi-line';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const E = '';
let container: HTMLDivElement;
let root: Root;

function render(line: string, workingDir?: string) {
  act(() => {
    root.render(<AnsiLine line={line} workingDir={workingDir} />);
  });
  return container;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('AnsiLine link rendering', () => {
  it('renders a style-split URL as a SINGLE anchor', () => {
    // Vite: `http://localhost:` cyan, `5800` bold, `/` cyan.
    const el = render(
      `  ${E}[32m➜${E}[39m  ${E}[1mLocal${E}[22m:   ${E}[36mhttp://localhost:${E}[1m5800${E}[22m/${E}[39m`,
    );

    const anchors = el.querySelectorAll('a');
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute('href')).toBe('http://localhost:5800/');
    // The whole URL is inside that one anchor, so hover/underline covers it all.
    expect(anchors[0].textContent).toBe('http://localhost:5800/');
  });

  it('preserves the ANSI styling inside the anchor', () => {
    const el = render(
      `${E}[36mhttp://localhost:${E}[1m5800${E}[22m/${E}[39m`,
    );

    const anchor = el.querySelector('a');
    expect(anchor?.textContent).toBe('http://localhost:5800/');
    // The bolded port is still its own styled span within the link.
    const bold = [...(anchor?.querySelectorAll('span') ?? [])].find(
      (s) => s.style.fontWeight === 'bold',
    );
    expect(bold?.textContent).toBe('5800');
  });

  it('renders a style-split file path as a single button', () => {
    const el = render(`${E}[32msrc/${E}[1mindex.ts${E}[22m${E}[39m`, '/w');

    const buttons = el.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe('src/index.ts');
  });

  it('renders the full line text exactly, with styling preserved', () => {
    const line = `${E}[2m│ ${E}[0m${E}[36mhttp://localhost:${E}[1m5173${E}[22m/${E}[0m${E}[2m│${E}[0m`;
    const el = render(line);

    expect(el.textContent).toBe('│ http://localhost:5173/│');
    // Border is outside the link.
    expect(el.querySelectorAll('a')).toHaveLength(1);
    expect(el.querySelector('a')?.textContent).toBe('http://localhost:5173/');
  });

  it('renders two adjacent URLs as two separate anchors', () => {
    const el = render(`${E}[32mhttp://a.com${E}[0m${E}[32mhttp://b.com${E}[0m`);

    const anchors = [...el.querySelectorAll('a')];
    expect(anchors.map((a) => a.getAttribute('href'))).toEqual([
      'http://a.com',
      'http://b.com',
    ]);
  });

  it('keeps plain lines free of links and intact', () => {
    const el = render(`${E}[32mbuilt${E}[0m in 1.2s`);
    expect(el.querySelectorAll('a')).toHaveLength(0);
    expect(el.textContent).toBe('built in 1.2s');
  });
});
