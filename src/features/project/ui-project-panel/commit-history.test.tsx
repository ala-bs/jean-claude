// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import type { ProjectGitCommit, ProjectGitRef } from '@shared/types';
import { CommitHistory } from './commit-history';
import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { RootOverlay } from '@/common/context/overlay';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function commit(
  hash: string,
  parents: string[],
  refs: ProjectGitRef[] = [],
): ProjectGitCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents,
    author: 'PL',
    date: '2026-09-06T10:00:00Z',
    refs,
    subject: `subject ${hash}`,
  };
}

/** Tip of both `main` (checked out, pushed) and a topic branch. */
const MULTI_REF_COMMIT = commit('tip0000', ['base000'], [
  { name: 'main', kind: 'branch', isHead: true },
  { name: 'origin/main', kind: 'remote', isHead: false },
  { name: 'feat/x', kind: 'branch', isHead: false },
]);

function renderHistory(
  overrides: Partial<React.ComponentProps<typeof CommitHistory>> = {},
) {
  const onFocusRef = vi.fn();
  const onSelectCommit = vi.fn();

  act(() => {
    root.render(
      <RootKeyboardBindings>
      <RootOverlay>
        <CommitHistory
        commits={[MULTI_REF_COMMIT, commit('base000', [])]}
        branch="main"
        totalCommits={2}
        isLoading={false}
        isLoadingMore={false}
        hasMore={false}
        onLoadMore={() => {}}
        query=""
        onQueryChange={() => {}}
        selectedBranches={[]}
        onSelectedBranchesChange={() => {}}
        branches={[]}
        matchCount={2}
        isCountingMatches={false}
        searchInputRef={{ current: null }}
        selectedHash={MULTI_REF_COMMIT.hash}
        focusedRef="main"
        onFocusRef={onFocusRef}
        onSelectCommit={onSelectCommit}
          {...overrides}
        />
      </RootOverlay>
      </RootKeyboardBindings>,
    );
  });

  return { onFocusRef, onSelectCommit };
}

function trigger(): HTMLButtonElement {
  const element = container.querySelector(
    'button[aria-haspopup="menu"]',
  ) as HTMLButtonElement | null;
  if (!element) throw new Error('ref picker trigger not rendered');
  return element;
}

function menuItems(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('[role="menuitem"]'));
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Mimics a real button: Enter's click is the *default action* of the keydown. */
function pressEnter(element: HTMLElement) {
  act(() => {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    const notPrevented = element.dispatchEvent(event);
    if (notPrevented && element.tagName === 'BUTTON') {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  });
}

describe('CommitHistory ref picker', () => {
  it('offers every ref on the commit, with the remote folded into its branch', () => {
    renderHistory();
    click(trigger());

    // `origin/main` is folded into `main`, so two entries rather than three.
    expect(menuItems().map((item) => item.textContent)).toEqual([
      expect.stringContaining('main'),
      expect.stringContaining('feat/x'),
    ]);
    expect(menuItems()[0].textContent).toContain('HEAD');
  });

  it('reports the chosen branch with the commit it belongs to', () => {
    const { onFocusRef } = renderHistory();
    click(trigger());
    click(menuItems()[1]);

    expect(onFocusRef).toHaveBeenCalledWith({
      hash: MULTI_REF_COMMIT.hash,
      refKey: 'feat/x',
    });
  });

  it('does not select the row when the picker is clicked', () => {
    // The row is a div role="button"; without stopPropagation the click would
    // bubble and toggle the diff pane shut underneath the open menu.
    const { onSelectCommit } = renderHistory();
    click(trigger());
    expect(onSelectCommit).not.toHaveBeenCalled();

    click(menuItems()[1]);
    expect(onSelectCommit).not.toHaveBeenCalled();
  });

  it('opens by keyboard without the row swallowing Enter', () => {
    // A button's click is the default action of its Enter keydown, so the
    // row's own preventDefault() used to cancel it — making the picker
    // mouse-only and selecting the row instead.
    const { onSelectCommit } = renderHistory();
    pressEnter(trigger());

    expect(menuItems()).toHaveLength(2);
    expect(onSelectCommit).not.toHaveBeenCalled();
  });

  it('picks a branch by keyboard without also toggling the row', () => {
    const { onFocusRef, onSelectCommit } = renderHistory();
    pressEnter(trigger());
    pressEnter(menuItems()[1]);

    expect(onFocusRef).toHaveBeenCalledWith({
      hash: MULTI_REF_COMMIT.hash,
      refKey: 'feat/x',
    });
    expect(onSelectCommit).not.toHaveBeenCalled();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    renderHistory();
    click(trigger());
    expect(menuItems()).toHaveLength(2);

    act(() => {
      trigger().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(menuItems()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger());
  });

  it('closes on an outside pointerdown', () => {
    renderHistory();
    click(trigger());

    act(() => {
      document.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      );
    });

    expect(menuItems()).toHaveLength(0);
  });

  it('shows no picker on a commit with a single ref', () => {
    renderHistory({
      commits: [
        commit('solo000', [], [{ name: 'main', kind: 'branch', isHead: true }]),
      ],
      selectedHash: 'solo000',
    });

    expect(container.querySelector('button[aria-haspopup="menu"]')).toBeNull();
  });
});
