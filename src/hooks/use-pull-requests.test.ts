/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { flushSync } from 'react-dom';

import { cache$, resetCache } from '@/cache/cache-store';
import { api } from '@/lib/api';

import {
  useAddPullRequestComment,
  useAddPullRequestFileComment,
  useAddThreadReply,
  useMarkPullRequestDraft,
  usePublishPullRequest,
  useSetAutoComplete,
} from './use-pull-requests';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  resetCache();
  vi.restoreAllMocks();
});

describe('useSetAutoComplete', () => {
  it('shares pending state between hook instances for the same PR', async () => {
    vi.spyOn(api.azureDevOps, 'setPullRequestAutoComplete').mockImplementation(
      () => new Promise(() => {}),
    );

    const results: unknown[] = [];
    const repoInfo = {
      projectName: 'Project',
      providerId: 'provider-1',
      projectId: 'azure-project-1',
      repoId: 'repo-1',
    };
    function Consumer({ index }: { index: number }) {
      results[index] = useSetAutoComplete('local-project-1', 42, repoInfo);
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(Consumer, { index: 0 }),
        createElement(Consumer, { index: 1 }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    Reflect.get(results[0] as object, 'mutate')({ enabled: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(Reflect.get(results[0] as object, 'isAnyPending')).toBe(true);
    expect(Reflect.get(results[1] as object, 'isAnyPending')).toBe(true);
  });
});

describe('useMarkPullRequestDraft', () => {
  it('updates cached PR draft state after success', async () => {
    vi.spyOn(api.azureDevOps, 'markPullRequestDraft').mockResolvedValue();

    const repoInfo = {
      projectName: 'Project',
      providerId: 'provider-1',
      projectId: 'azure-project-1',
      repoId: 'repo-1',
    };
    const queryKey = [
      'pull-request',
      'local-project-1',
      'provider-1',
      'azure-project-1',
      'repo-1',
      42,
    ];
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKey, { id: 42, isDraft: false });
    let mutation: ReturnType<typeof useMarkPullRequestDraft> | null = null;

    function Consumer() {
      mutation = useMarkPullRequestDraft('local-project-1', 42, repoInfo);
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Consumer),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    mutation!.mutate();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(api.azureDevOps.markPullRequestDraft).toHaveBeenCalledWith({
      providerId: 'provider-1',
      projectId: 'azure-project-1',
      repoId: 'repo-1',
      pullRequestId: 42,
    });
    expect(queryClient.getQueryData(queryKey)).toMatchObject({
      id: 42,
      isDraft: true,
    });
  });
});

describe('usePublishPullRequest', () => {
  it('updates linked task feed item draft state after success', async () => {
    vi.spyOn(api.azureDevOps, 'publishPullRequest').mockResolvedValue();
    cache$.documents['feed:tasks'].data.set([
      {
        id: 'task-1',
        source: 'task',
        projectId: 'local-project-1',
        pullRequestId: 42,
        isDraft: true,
        children: [
          {
            id: 'task-child-1',
            source: 'task',
            projectId: 'local-project-1',
            pullRequestId: 42,
            isDraft: true,
          } as never,
        ],
      } as never,
    ]);

    const repoInfo = {
      projectName: 'Project',
      providerId: 'provider-1',
      projectId: 'azure-project-1',
      repoId: 'repo-1',
    };
    let mutation: ReturnType<typeof usePublishPullRequest> | null = null;

    function Consumer() {
      mutation = usePublishPullRequest('local-project-1', 42, repoInfo);
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(Consumer),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    mutation!.mutate();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cache$.documents['feed:tasks'].data.get()).toMatchObject([
      {
        pullRequestId: 42,
        isDraft: false,
        children: [{ pullRequestId: 42, isDraft: false }],
      },
    ]);
  });
});

describe('pull request comment capture metadata', () => {
  const repoInfo = {
    projectName: 'Project',
    providerId: 'provider-1',
    projectId: 'azure-project-1',
    repoId: 'repo-1',
  };

  async function renderMutation<T>(useMutationHook: () => T): Promise<T> {
    let mutation: T | null = null;
    function Consumer() {
      mutation = useMutationHook();
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(Consumer),
        ),
      );
    });
    return mutation!;
  }

  it('passes local project ID only for a user-posted top-level comment', async () => {
    vi.spyOn(api.azureDevOps, 'addPullRequestComment').mockResolvedValue({
      id: 8,
      status: 'active',
      comments: [],
      isDeleted: false,
    });
    const mutation = await renderMutation(() =>
      useAddPullRequestComment('local-project-1', 42, repoInfo),
    );

    await mutation.mutateAsync('User feedback');

    expect(api.azureDevOps.addPullRequestComment).toHaveBeenCalledWith({
      localProjectId: 'local-project-1',
      providerId: 'provider-1',
      projectId: 'azure-project-1',
      repoId: 'repo-1',
      pullRequestId: 42,
      content: 'User feedback',
    });
  });

  it('passes exact selected lines as advisory file-comment metadata', async () => {
    vi.spyOn(api.azureDevOps, 'addPullRequestFileComment').mockResolvedValue({
      id: 8,
      status: 'active',
      comments: [],
      isDeleted: false,
    });
    const mutation = await renderMutation(() =>
      useAddPullRequestFileComment('local-project-1', 42, repoInfo),
    );

    await mutation.mutateAsync({
      filePath: 'src/app.ts',
      line: 3,
      lineEnd: 4,
      selectedLines: 'third\nfourth',
      content: 'User feedback',
    });

    expect(api.azureDevOps.addPullRequestFileComment).toHaveBeenCalledWith({
      localProjectId: 'local-project-1',
      providerId: 'provider-1',
      projectId: 'azure-project-1',
      repoId: 'repo-1',
      pullRequestId: 42,
      filePath: 'src/app.ts',
      line: 3,
      lineEnd: 4,
      selectedLines: 'third\nfourth',
      content: 'User feedback',
    });
  });

  it('passes local project ID for replies without renderer thread text', async () => {
    vi.spyOn(api.azureDevOps, 'addThreadReply').mockResolvedValue({
      id: 9,
      content: 'Reply',
      commentType: 'text',
      author: { id: 'me', displayName: 'Me', uniqueName: 'me@example.com' },
      usersLiked: [],
      publishedDate: '2026-07-18T12:00:00.000Z',
      lastUpdatedDate: '2026-07-18T12:00:00.000Z',
    });
    const mutation = await renderMutation(() =>
      useAddThreadReply('local-project-1', 42, repoInfo),
    );

    await mutation.mutateAsync({ threadId: 8, content: 'Reply' });

    expect(api.azureDevOps.addThreadReply).toHaveBeenCalledWith({
      localProjectId: 'local-project-1',
      providerId: 'provider-1',
      projectId: 'azure-project-1',
      repoId: 'repo-1',
      pullRequestId: 42,
      threadId: 8,
      content: 'Reply',
    });
  });
});
