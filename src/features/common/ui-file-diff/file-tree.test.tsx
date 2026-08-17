// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
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
    const compressed = folderButtons.find(
      (button) => button.textContent === 'alpha/nested',
    );
    const beta = folderButtons.find((button) => button.textContent === 'beta');

    expect(tree?.classList.contains('overflow-auto')).toBe(false);
    expect(tree?.classList.contains('isolate')).toBe(true);
    expect(compressed?.classList.contains('sticky')).toBe(true);
    expect(compressed?.parentElement?.contains(beta ?? null)).toBe(false);
    expect(compressed?.style.top).toBe('0px');
    expect(Number(compressed?.style.zIndex)).toBeGreaterThan(0);
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

  describe('selection scrolling', () => {
    let root: Root;
    let container: HTMLDivElement;
    let scrollIntoView: ReturnType<typeof vi.fn>;
    const originalScrollIntoView = Element.prototype.scrollIntoView;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;
    });

    afterEach(() => {
      flushSync(() => root.unmount());
      Element.prototype.scrollIntoView = originalScrollIntoView;
      container.remove();
    });

    it('does not scroll selected file when folder collapses', () => {
      let collapsedFolders = new Set<string>();
      const render = () =>
        root.render(
          <DiffFileTree
            files={files}
            selectedPath="beta/two.ts"
            onSelectFile={() => undefined}
            collapsedFolders={collapsedFolders}
            onToggleFolder={() => undefined}
          />,
        );

      flushSync(render);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      collapsedFolders = new Set(['alpha']);
      flushSync(render);

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });
  });
  describe('multi-select', () => {
    let root: Root;
    let container: HTMLDivElement;
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const multiFiles = [
      { path: 'alpha/nested/one.ts', status: 'modified' as const },
      { path: 'beta/three.ts', status: 'modified' as const },
      { path: 'beta/two.ts', status: 'modified' as const },
    ];

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      Element.prototype.scrollIntoView = vi.fn();
    });

    afterEach(() => {
      flushSync(() => root.unmount());
      Element.prototype.scrollIntoView = originalScrollIntoView;
      container.remove();
    });

    const rowFor = (path: string) =>
      container.querySelector<HTMLElement>(`[data-file-path="${path}"]`);
    const checkboxIn = (row: HTMLElement | null) =>
      row?.querySelector<HTMLElement>('[role="checkbox"]');
    const click = (element: Element | null | undefined, init?: MouseEventInit) =>
      flushSync(() =>
        element?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, ...init }),
        ),
      );

    function renderMulti(onToggleReviewed: (paths: string[], reviewed: boolean) => void) {
      flushSync(() =>
        root.render(
          <DiffFileTree
            files={multiFiles}
            selectedPath={null}
            onSelectFile={() => undefined}
            reviewedPaths={new Set<string>()}
            onToggleReviewed={onToggleReviewed}
          />,
        ),
      );
    }

    it('marks every file in a shift-selected range from one checkbox click', () => {
      const onToggleReviewed = vi.fn();
      renderMulti(onToggleReviewed);

      click(rowFor('alpha/nested/one.ts'));
      click(rowFor('beta/two.ts'), { shiftKey: true });
      click(checkboxIn(rowFor('beta/three.ts')));

      expect(onToggleReviewed).toHaveBeenCalledWith(
        ['alpha/nested/one.ts', 'beta/three.ts', 'beta/two.ts'],
        true,
      );
    });

    it('only marks the clicked file when it is outside the selection', () => {
      const onToggleReviewed = vi.fn();
      renderMulti(onToggleReviewed);

      click(rowFor('beta/three.ts'));
      click(rowFor('beta/two.ts'), { metaKey: true });
      click(checkboxIn(rowFor('alpha/nested/one.ts')));

      expect(onToggleReviewed).toHaveBeenCalledWith(
        ['alpha/nested/one.ts'],
        true,
      );
    });

    it('clears the selection on Escape', () => {
      const onToggleReviewed = vi.fn();
      renderMulti(onToggleReviewed);

      click(rowFor('alpha/nested/one.ts'));
      click(rowFor('beta/two.ts'), { shiftKey: true });
      flushSync(() =>
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
      );
      click(checkboxIn(rowFor('beta/two.ts')));

      expect(onToggleReviewed).toHaveBeenCalledWith(['beta/two.ts'], true);
    });
    it('counts files hidden by the reviewed treatment in folder rollups', () => {
      const onToggleReviewed = vi.fn();
      flushSync(() =>
        root.render(
          <DiffFileTree
            files={multiFiles}
            selectedPath={null}
            onSelectFile={() => undefined}
            reviewedPaths={new Set(['beta/two.ts'])}
            reviewedTreatment="hide"
            onToggleReviewed={onToggleReviewed}
          />,
        ),
      );

      const betaFolder = Array.from(
        container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'),
      ).find((button) => button.textContent?.startsWith('beta'));

      // beta holds three.ts + two.ts; two.ts is reviewed and hidden.
      expect(betaFolder?.textContent).toContain('1/2');

      click(betaFolder?.querySelector('[role="checkbox"]'));
      expect(onToggleReviewed).toHaveBeenCalledWith(
        ['beta/three.ts', 'beta/two.ts'],
        true,
      );
    });

    it('drops the selection when another file is opened elsewhere', () => {
      const onToggleReviewed = vi.fn();
      const render = (selectedPath: string | null) =>
        flushSync(() =>
          root.render(
            <DiffFileTree
              files={multiFiles}
              selectedPath={selectedPath}
              onSelectFile={() => undefined}
              reviewedPaths={new Set<string>()}
              onToggleReviewed={onToggleReviewed}
            />,
          ),
        );

      render(null);
      click(rowFor('beta/three.ts'));
      click(rowFor('beta/two.ts'), { shiftKey: true });

      // Something else (tab strip, J/K) opens an unselected file.
      render('alpha/nested/one.ts');
      click(checkboxIn(rowFor('beta/two.ts')));

      expect(onToggleReviewed).toHaveBeenCalledWith(['beta/two.ts'], true);
    });
  });
});

describe('repo-absolute paths', () => {
  function renderReview(paths: string[], reviewed: string[] = []) {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <DiffFileTree
        files={paths.map((path) => ({ path, status: 'modified' as const }))}
        selectedPath={null}
        onSelectFile={() => undefined}
        reviewedPaths={new Set(reviewed)}
        onToggleReviewed={() => undefined}
      />,
    );
    return container;
  }

  /**
   * Folder rows label their checkbox with the files it covers, which pins the
   * folder->files mapping directly rather than inferring it from counter text.
   */
  function folderCoverage(container: HTMLElement) {
    return [...container.querySelectorAll('[role="checkbox"][title]')]
      .map((node) => node.getAttribute('title'))
      .filter((title): title is string => Boolean(title?.startsWith('Mark all')));
  }

  it('maps a folder to the files beneath it for leading-slash paths', () => {
    const container = renderReview(['/src/one.ts', '/src/two.ts']);
    expect(folderCoverage(container)).toEqual(['Mark all 2 files reviewed']);
    expect(container.textContent).toContain('0/2');
  });

  it('reflects reviewed files in the folder counter', () => {
    const text = renderReview(
      ['/src/one.ts', '/src/two.ts'],
      ['/src/one.ts'],
    ).textContent;
    expect(text).toContain('1/2');
  });

  it('scopes counters to their own folder across sibling roots', () => {
    const container = renderReview([
      '/src/one.ts',
      '/src/two.ts',
      '/docs/readme.md',
    ]);
    // Exactly two folder rows — no nameless root wrapper covering all three.
    expect(folderCoverage(container).sort()).toEqual([
      'Mark all 1 files reviewed',
      'Mark all 2 files reviewed',
    ]);
  });

  it('renders a root-level file with no folder row', () => {
    const container = renderReview(['/README.md']);
    expect(folderCoverage(container)).toEqual([]);
    expect(container.textContent).toContain('README.md');
  });

  it('still counts relative worktree paths', () => {
    const container = renderReview(['src/one.ts', 'src/two.ts']);
    expect(folderCoverage(container)).toEqual(['Mark all 2 files reviewed']);
  });

  it('keeps rooted and relative trees from sharing a folder row', () => {
    const container = renderReview(['/src/one.ts', 'src/two.ts']);
    expect(folderCoverage(container).sort()).toEqual([
      'Mark all 1 files reviewed',
      'Mark all 1 files reviewed',
    ]);
  });
});
