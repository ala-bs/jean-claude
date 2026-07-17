/**
 * @vitest-environment happy-dom
 */
/* eslint-disable sort-imports */
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AzureDevOpsPullRequestDetails } from '@/lib/api';

const { updateTitle } = vi.hoisted(() => ({
  updateTitle: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@/hooks/use-pull-requests', () => ({
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

describe('PrHeader', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    updateTitle.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => {
      root.render(createElement(PrHeader, { pr, projectId: 'project-1' }));
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
});
