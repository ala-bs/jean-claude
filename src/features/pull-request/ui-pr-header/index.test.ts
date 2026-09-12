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

const {
  addToast,
  markDraft,
  updateTitle,
  navigate,
  createPrReviewTask,
  routerPathname,
  divergence,
  divergenceArgs,
} = vi.hoisted(() => ({
  addToast: vi.fn(),
  markDraft: vi.fn(),
  updateTitle: vi.fn(),
  navigate: vi.fn(),
  createPrReviewTask: vi.fn(),
  routerPathname: { current: '/projects/project-1/prs/17' },
  divergence: {
    current: undefined as { aheadCount: number; behindCount: number } | undefined,
  },
  divergenceArgs: { current: [] as unknown[] },
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: routerPathname.current } }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@/lib/api', () => ({
  api: {
    shell: { openInEditor: vi.fn() },
    tasks: { createPrReviewTask },
  },
}));
vi.mock('@/hooks/use-pull-requests', () => ({
  useMarkPullRequestDraft: () => ({ mutate: markDraft, isPending: false }),
  usePublishPullRequest: () => ({ mutate: vi.fn(), isPending: false }),
  usePullRequestDivergence: (...args: unknown[]) => {
    divergenceArgs.current = args;
    return { data: divergence.current };
  },
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
vi.mock('@/hooks/use-tasks', () => ({ invalidateFeedItems: vi.fn() }));
vi.mock('@/stores/background-jobs', () => ({
  useBackgroundJobsStore: (
    selector: (state: Record<string, unknown>) => unknown,
  ) =>
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
vi.mock('../ui-pr-run-control', () => ({
  PrRunControl: () => createElement('button', null, 'Start project'),
}));
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
    navigate.mockReset();
    createPrReviewTask.mockReset();
    createPrReviewTask.mockResolvedValue({ id: 'task-9' });
    routerPathname.current = '/projects/project-1/prs/17';
    divergence.current = undefined;
    divergenceArgs.current = [];
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

  it('copies the PR link and shows copied feedback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const copyButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Copy PR link"]',
    );
    expect(copyButton).not.toBeNull();
    expect(copyButton?.textContent).toContain('Copy link');

    await new Promise<void>((resolve) => {
      flushSync(() => {
        copyButton?.click();
      });
      queueMicrotask(resolve);
    });

    expect(writeText).toHaveBeenCalledWith('https://example.com/pr/17');
    expect(addToast).toHaveBeenCalledWith({
      type: 'success',
      message: 'PR link copied to clipboard',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(
      container.querySelector('[aria-label="Copy PR link"]')?.textContent,
    ).toContain('Copied');
  });

  it('reports clipboard failures when copying the PR link', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('nope')) },
      configurable: true,
    });

    await new Promise<void>((resolve) => {
      flushSync(() => {
        container
          .querySelector<HTMLButtonElement>('[aria-label="Copy PR link"]')
          ?.click();
      });
      queueMicrotask(resolve);
    });

    expect(addToast).toHaveBeenCalledWith({
      type: 'error',
      message: 'Failed to copy PR link',
    });
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

  it('shows how many commits the source branch is behind the target', () => {
    expect(container.textContent).not.toContain('behind');

    divergence.current = { aheadCount: 3, behindCount: 1 };
    flushSync(() => {
      root.render(
        withProviders(createElement(PrHeader, { pr, projectId: 'project-1' })),
      );
    });
    expect(container.textContent).toContain('1 behind');

    divergence.current = { aheadCount: 3, behindCount: 12 };
    flushSync(() => {
      root.render(
        withProviders(createElement(PrHeader, { pr, projectId: 'project-1' })),
      );
    });
    expect(container.textContent).toContain('12 behind');

    divergence.current = { aheadCount: 3, behindCount: 0 };
    flushSync(() => {
      root.render(
        withProviders(createElement(PrHeader, { pr, projectId: 'project-1' })),
      );
    });
    expect(container.textContent).not.toContain('behind');
  });

  it('queries divergence with the PR refs and only while the PR is active', () => {
    expect(divergenceArgs.current[3]).toMatchObject({
      enabled: true,
      sourceRefName: 'refs/heads/feature',
      targetRefName: 'refs/heads/main',
    });

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
    expect(divergenceArgs.current[3]).toMatchObject({ enabled: false });
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

  it('orders PR Workspace actions around the project run control', () => {
    const onDeletePrWorkspaces = vi.fn();
    flushSync(() => {
      root.render(
        withProviders(
          createElement(PrHeader, {
            pr,
            projectId: 'project-1',
            onDeletePrWorkspaces,
          }),
        ),
      );
    });

    const text = container.textContent ?? '';
    expect(text).toContain('Delete PR Workspaces');
    // Deleting the associated tasks is the only cleanup path; the old
    // keep-the-task "Clean review workspace" action must not come back.
    expect(text).not.toContain('Clean review workspace');
    expect(text.indexOf('New Task')).toBeLessThan(text.indexOf('Start project'));
    expect(text.indexOf('Start project')).toBeLessThan(
      text.indexOf('Create Review Workspace'),
    );

    const deleteButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Delete PR Workspaces',
    );
    deleteButton?.click();
    expect(onDeletePrWorkspaces).toHaveBeenCalledOnce();
  });

  it('focuses the new review workspace inside the feed when opened from the feed', async () => {
    routerPathname.current = '/all/prs/project-1/17';
    flushSync(() => {
      root.render(
        withProviders(createElement(PrHeader, { pr, projectId: 'project-1' })),
      );
    });

    const reviewButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Create Review Workspace',
    );
    expect(reviewButton).toBeDefined();
    reviewButton?.click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());

    expect(navigate).toHaveBeenCalledWith({
      to: '/all/$taskId',
      params: { taskId: 'task-9' },
    });
  });

  it('focuses the new review workspace in the project when opened from a project', async () => {
    const reviewButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Create Review Workspace',
    );
    reviewButton?.click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());

    expect(navigate).toHaveBeenCalledWith({
      to: '/projects/$projectId/tasks/$taskId',
      params: { projectId: 'project-1', taskId: 'task-9' },
    });
  });

  it('uses wrapping, dynamic-height toolbar contracts at narrow widths', () => {
    container.style.width = '320px';
    flushSync(() => {
      root.render(
        withProviders(
          createElement(PrHeader, {
            pr,
            projectId: 'project-1',
            onDeletePrWorkspaces: vi.fn(),
          }),
        ),
      );
    });

    const toolbar = container.querySelector(
      '[data-testid="pr-header-toolbar"]',
    );
    const actions = container.querySelector(
      '[data-testid="pr-header-actions"]',
    );
    expect(toolbar?.className).toContain('flex-wrap');
    expect(toolbar?.className).toContain('min-h-[52px]');
    expect(toolbar?.className.split(' ')).not.toContain('h-[52px]');
    expect(actions?.className).toContain('flex-wrap');
    expect(container.textContent).toContain('Delete PR Workspaces');
    expect(container.textContent).toContain('Create Review Workspace');
    expect(container.textContent).toContain('Azure DevOps');
  });
});
