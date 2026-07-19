/**
 * @vitest-environment happy-dom
 */
/* eslint-disable sort-imports */
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AzureDevOpsPullRequestDetails } from '@/lib/api';
import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { RootOverlay } from '@/common/context/overlay';

const { addToast, markDraft, updateTitle } = vi.hoisted(() => ({
  addToast: vi.fn(),
  markDraft: vi.fn(),
  updateTitle: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@/hooks/use-pull-requests', () => ({
  useMarkPullRequestDraft: () => ({ mutate: markDraft, isPending: false }),
  usePublishPullRequest: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdatePullRequestTitle: () => ({
    mutate: updateTitle,
    isPending: false,
  }),
}));
vi.mock('@/hooks/use-settings', () => ({
  getEditorLabel: () => 'Editor',
  useEditorSetting: () => ({ data: null }),
}));
vi.mock('@/hooks/use-projects', () => ({
  useProject: () => ({ data: undefined }),
}));
vi.mock('@/stores/background-jobs', () => ({
  useBackgroundJobsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      addRunningJob: vi.fn(),
      markJobSucceeded: vi.fn(),
      markJobFailed: vi.fn(),
    }),
}));
vi.mock('@/stores/new-task-form', () => ({
  useNewTaskFormStore: () => ({ setDraft: vi.fn() }),
}));
vi.mock('@/stores/toasts', () => ({
  useToastStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ addToast }),
}));
vi.mock('../ui-pr-auto-complete', () => ({ PrAutoComplete: () => null }));
vi.mock('../ui-pr-vote-dropdown', () => ({ PrVoteDropdown: () => null }));

import { PrHeader } from '.';

const pr: AzureDevOpsPullRequestDetails = {
  id: 17,
  title: 'Original title',
  description: '',
  status: 'active',
  isDraft: false,
  createdBy: {
    id: 'author-id',
    displayName: 'Author',
    uniqueName: 'author@example.com',
  },
  creationDate: '2026-07-14T00:00:00Z',
  sourceRefName: 'refs/heads/feature',
  targetRefName: 'refs/heads/main',
  url: 'https://example.com/pr/17',
  reviewers: [],
};

function withProviders(child: ReturnType<typeof createElement>) {
  return createElement(
    RootKeyboardBindings,
    null,
    createElement(RootOverlay, null, child),
  );
}

describe('PrHeader', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    addToast.mockReset();
    markDraft.mockReset();
    updateTitle.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => {
      root.render(
        withProviders(
          createElement(PrHeader, { pr, projectId: 'project-1' }),
        ),
      );
    });
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  it('submits edited title with Cmd+Enter', () => {
    const editButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Edit',
    );
    expect(editButton).toBeDefined();

    flushSync(() => {
      editButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const input = container.querySelector('input');
    expect(input).not.toBeNull();
    flushSync(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(input, '  Renamed PR  ');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    input?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(updateTitle).toHaveBeenCalledWith('Renamed PR', expect.any(Object));
  });

  it('marks an active published PR as draft from the overflow menu', async () => {
    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="More pull request actions"]',
    );
    expect(trigger).not.toBeNull();

    flushSync(() => {
      trigger?.click();
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const menuItem = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Mark as draft',
    );
    expect(menuItem).toBeDefined();

    flushSync(() => {
      menuItem?.click();
    });
    expect(markDraft).toHaveBeenCalledWith(undefined, expect.any(Object));

    const options = markDraft.mock.calls[0][1];
    options.onSuccess();
    expect(addToast).toHaveBeenCalledWith({
      type: 'success',
      message: 'Pull request marked as draft',
    });

    const error = new Error('permission denied');
    options.onError(error);
    expect(addToast).toHaveBeenCalledWith({
      type: 'error',
      message: 'permission denied',
    });
  });

  it('hides overflow action for draft, non-active, and read-only PRs', () => {
    flushSync(() => {
      root.render(
        withProviders(
          createElement(PrHeader, {
            pr: { ...pr, isDraft: true },
            projectId: 'project-1',
          }),
        ),
      );
    });
    expect(
      container.querySelector('[aria-label="More pull request actions"]'),
    ).toBeNull();

    flushSync(() => {
      root.render(
        withProviders(
          createElement(PrHeader, {
            pr: { ...pr, status: 'completed' },
            projectId: 'project-1',
          }),
        ),
      );
    });
    expect(
      container.querySelector('[aria-label="More pull request actions"]'),
    ).toBeNull();

    flushSync(() => {
      root.render(
        withProviders(
          createElement(PrHeader, {
            pr,
            projectId: 'project-1',
            readOnly: true,
          }),
        ),
      );
    });
    expect(
      container.querySelector('[aria-label="More pull request actions"]'),
    ).toBeNull();
  });
});
