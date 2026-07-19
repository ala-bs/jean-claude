// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { DiffFileTree } from './file-tree';

const files = [
  { path: 'alpha/nested/one.ts', status: 'modified' as const },
  { path: 'beta/two.ts', status: 'modified' as const },
];

function renderTree(stickyFolders = false, treeFiles = files) {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(
    <DiffFileTree
      files={treeFiles}
      selectedPath={null}
      onSelectFile={() => undefined}
      stickyFolders={stickyFolders}
    />,
  );
  return container;
}

describe('DiffFileTree sticky folders', () => {
  it('preserves self-scrolling behavior by default', () => {
    const tree = renderTree().firstElementChild;

    expect(tree?.classList.contains('overflow-auto')).toBe(true);
    expect(tree?.querySelector('.sticky')).toBeNull();
  });

  it('uses parent scrolling and constrains nested sticky rows to subtrees', () => {
    const tree = renderTree(true).firstElementChild;
    const folderButtons = Array.from(
      tree?.querySelectorAll<HTMLButtonElement>('button[aria-expanded]') ?? [],
    );
    const alpha = folderButtons.find((button) => button.textContent === 'alpha');
    const nested = folderButtons.find((button) => button.textContent === 'nested');
    const beta = folderButtons.find((button) => button.textContent === 'beta');

    expect(tree?.classList.contains('overflow-auto')).toBe(false);
    expect(tree?.classList.contains('isolate')).toBe(true);
    expect(alpha?.classList.contains('sticky')).toBe(true);
    expect(alpha?.parentElement?.contains(nested ?? null)).toBe(true);
    expect(alpha?.parentElement?.contains(beta ?? null)).toBe(false);
    expect(nested?.style.top).toBe('28px');
    expect(Number(alpha?.style.zIndex)).toBeGreaterThan(
      Number(nested?.style.zIndex),
    );
  });

  it('keeps sticky stacking positive for deeply nested paths', () => {
    const path = [
      ...Array.from({ length: 101 }, (_, index) => `level-${index}`),
      'file.ts',
    ].join('/');
    const tree = renderTree(true, [
      { path, status: 'modified' as const },
    ]).firstElementChild;
    const zIndexes = Array.from(
      tree?.querySelectorAll<HTMLButtonElement>('button[aria-expanded]') ?? [],
      (button) => Number(button.style.zIndex),
    );

    expect(Math.min(...zIndexes)).toBeGreaterThan(0);
  });
});
