// @vitest-environment happy-dom
/* eslint-disable sort-imports */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetCache } from '@/cache/cache-store';
import { ingestProjectTasks } from '@/cache/domains/tasks';
import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { RootOverlay } from '@/common/context/overlay';
import { api } from '@/lib/api';
import type { Task } from '@shared/types';

import { PrDetail } from '.';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  stepTaskIds: [] as string[],
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: '/projects/project-1/prs/17' } }),
}));

vi.mock('@/common/hooks/use-commands', () => ({ useCommands: vi.fn() }));

vi.mock('@/hooks/use-projects', () => ({
  useProject: () => ({
    data: {
      id: 'project-1',
      name: 'Jean-Claude',
      path: '/repo',
      repoProviderId: 'provider-1',
      repoProjectId: 'azure-project-1',
      repoId: 'repo-1',
    },
  }),
}));

vi.mock('@/hooks/use-settings', () => ({
  getEditorLabel: () => 'Editor',
  useEditorSetting: () => ({ data: null }),
  // useDiffReview reads the auto-review rules through this.
  useSetting: () => ({ data: undefined }),
}));

vi.mock('@/hooks/use-pr-view-snapshot', () => ({
  useRecordPrView: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/hooks/use-pr-review-agent', () => ({
  useContinuePrReviewChatStep: mutation,
  useCreateOrGetPrReviewTask: mutation,
  useCreatePrReviewChatStep: mutation,
}));

vi.mock('@/hooks/use-steps', () => ({
  useSteps: (taskId: string) => {
    mocks.stepTaskIds.push(taskId);
    return { data: [] };
  },
}));

vi.mock('@/hooks/use-task-messages', () => ({
  useTaskMessages: () => ({ messages: [] }),
}));

vi.mock('@/hooks/use-pull-requests', () => ({
  updateFeedPullRequest: vi.fn(),
  useAddPullRequestComment: mutation,
  useAddPullRequestFileComment: mutation,
  useCurrentAzureUser: () => ({ data: null }),
  useMarkPullRequestDraft: mutation,
  usePublishPullRequest: mutation,
  usePullRequest: () => ({ data: createPullRequest(), isLoading: false }),
  usePullRequestChanges: () => ({ data: [], isLoading: false }),
  usePullRequestCommits: () => ({ data: [], isLoading: false }),
  usePullRequestFileContent: () => ({ data: '', isLoading: false }),
  usePullRequestThreads: () => ({ data: [] }),
  useUpdatePullRequestTitle: mutation,
  useUploadPullRequestAttachment: mutation,
}));

vi.mock('../ui-pr-auto-complete', () => ({ PrAutoComplete: () => null }));
vi.mock('../ui-pr-commits', () => ({ PrCommits: () => null }));
vi.mock('../ui-pr-diff-view', () => ({ PrDiffView: () => null }));
vi.mock('../ui-pr-overview', () => ({ PrOverview: () => <div>PR detail content</div> }));
vi.mock('../ui-pr-run-control', () => ({
  PrRunControl: ({ associatedTask }: { associatedTask?: Task | null }) => (
    <span data-testid="run-control-task">{associatedTask?.id}</span>
  ),
}));
vi.mock('../ui-pr-vote-dropdown', () => ({ PrVoteDropdown: () => null }));

function mutation() {
  return {
    error: null,
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
  };
}

describe('PrDetail PR workspace deletion', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    resetCache();
    ingestProjectTasks('project-1', [createTask()]);
    mocks.navigate.mockReset();
    mocks.stepTaskIds.length = 0;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    vi.spyOn(api.tasks, 'findByProjectId').mockResolvedValue([createTask()]);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  async function renderDetail() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RootOverlay>
            <RootKeyboardBindings>
              <PrDetail projectId="project-1" prId={42} />
            </RootKeyboardBindings>
          </RootOverlay>
        </QueryClientProvider>,
      );
    });
  }

  it('deletes all for current PR, refreshes state, and stays on detail route', async () => {
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    const deleteAll = vi
      .spyOn(api.tasks, 'deleteAllPrWorkspaces')
      .mockResolvedValue({ action: 'deleted', taskIds: ['review-1'] });
    await renderDetail();
    await vi.waitFor(() =>
      expect(findOptionalButton('Delete PR Workspaces')).toBeDefined(),
    );

    await act(async () => findButton('Delete PR Workspaces').click());
    await act(async () => findLastButton('Delete PR Workspaces').click());

    expect(deleteAll).toHaveBeenCalledWith({
      projectId: 'project-1',
      pullRequestId: 42,
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('PR detail content');
    expect(findOptionalButton('Delete PR Workspaces')).toBeUndefined();
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['tasks'] });
  });

  it('keeps detail and dialog open after failure and retries', async () => {
    const deleteAll = vi
      .spyOn(api.tasks, 'deleteAllPrWorkspaces')
      .mockRejectedValue(new Error('Git cleanup failed'));
    await renderDetail();
    await vi.waitFor(() =>
      expect(findOptionalButton('Delete PR Workspaces')).toBeDefined(),
    );

    await act(async () => findButton('Delete PR Workspaces').click());
    await act(async () => {
      findLastButton('Delete PR Workspaces').click();
      await vi.waitFor(() =>
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          'Git cleanup failed',
        ),
      );
    });
    expect(document.body.textContent).toContain('PR detail content');
    expect(mocks.navigate).not.toHaveBeenCalled();

    await act(async () => {
      findLastButton('Delete PR Workspaces').click();
      await vi.waitFor(() => expect(deleteAll).toHaveBeenCalledTimes(2));
    });
    expect(deleteAll).toHaveBeenCalledTimes(2);
  });

  it('uses newest workspace for steps and header controls regardless of query order', async () => {
    const oldTask = createTask({
      id: 'review-old',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const newestTask = createTask({
      id: 'review-newest',
      createdAt: '2026-03-01T00:00:00.000Z',
    });
    const middleTask = createTask({
      id: 'review-middle',
      createdAt: '2026-02-01T00:00:00.000Z',
    });
    const arbitraryOrder = [middleTask, oldTask, newestTask];
    resetCache();
    ingestProjectTasks('project-1', arbitraryOrder);
    vi.mocked(api.tasks.findByProjectId).mockResolvedValue(arbitraryOrder);

    await renderDetail();
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-testid="run-control-task"]')?.textContent,
      ).toBe('review-newest'),
    );

    expect(mocks.stepTaskIds).toContain('review-newest');
    expect(mocks.stepTaskIds).not.toContain('review-old');
    expect(mocks.stepTaskIds).not.toContain('review-middle');
    expect(findOptionalButton('Delete PR Workspaces')).toBeDefined();
  });
});

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'review-1',
    projectId: 'project-1',
    type: 'pr-review',
    name: 'PR #42',
    prompt: 'Review PR',
    status: 'waiting',
    worktreePath: '/repo/.worktrees/pr-42',
    startCommitHash: 'abc123',
    sourceBranch: 'main',
    branchName: 'review-42',
    prWorkspaceState: 'active',
    hasUnread: false,
    userCompleted: false,
    workItemIds: null,
    workItemUrls: null,
    pullRequestId: '42',
    pullRequestUrl: 'https://example.test/pr/42',
    pendingMessage: null,
    todoItems: [],
    parentTaskId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createPullRequest() {
  return {
    id: 42,
    title: 'Add project launch',
    status: 'active' as const,
    isDraft: false,
    mergeStatus: 'succeeded',
    sourceRefName: 'refs/heads/feature',
    targetRefName: 'refs/heads/main',
    url: 'https://example.test/pr/42',
    creationDate: '2026-01-01T00:00:00.000Z',
    createdBy: {
      id: 'user-1',
      displayName: 'Pat',
      imageUrl: '',
      uniqueName: 'pat@example.test',
    },
    reviewers: [],
  };
}

function findOptionalButton(label: string) {
  return [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === label,
  );
}

function findButton(label: string) {
  const button = findOptionalButton(label);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

function findLastButton(label: string) {
  const button = [...document.querySelectorAll('button')]
    .filter((candidate) => candidate.textContent?.trim() === label)
    .at(-1);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}
