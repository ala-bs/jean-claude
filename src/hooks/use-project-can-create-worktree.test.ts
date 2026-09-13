// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';

import {
  projectCanCreateWorktreeKey,
  useProjectCanCreateWorktree,
} from './use-project-git';
import { api } from '@/lib/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** Minimal renderHook with a query client; no testing-library in this repo. */
function renderHook<R>(useHook: () => R) {
  const client = new QueryClient({
    // Matches nothing about production config — it only keeps a rejecting
    // queryFn from retrying for seconds before the assertion can run.
    defaultOptions: { queries: { retry: false } },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const result = { current: undefined as R };

  function Harness() {
    result.current = useHook();
    return null;
  }

  act(() => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(
        Harness,
      ) as ReactNode),
    );
  });

  return {
    result,
    /**
     * Polls inside `act` so React can flush the re-render the settling query
     * causes; a bare `waitFor` sees the right value but warns about an
     * unacted update on every poll.
     */
    waitFor: (assertion: () => void) =>
      act(async () => {
        await vi.waitFor(assertion);
      }),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
      client.clear();
    },
  };
}

describe('useProjectCanCreateWorktree', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is false for a repo with no commits, true for one with commits', async () => {
    const getStatus = vi
      .spyOn(api.projects.git, 'getStatus')
      .mockResolvedValue({
        isGitRepository: true,
        hasCommits: false,
        hasCommitsElsewhere: false,
        branch: 'main',
        isDetached: false,
        upstream: null,
        ahead: null,
        behind: null,
        remoteUrl: null,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicted: 0,
      });

    const unborn = renderHook(() => useProjectCanCreateWorktree('p1'));
    await unborn.waitFor(() => expect(unborn.result.current.data).toBe(false));
    unborn.unmount();

    getStatus.mockResolvedValue({
      isGitRepository: true,
      hasCommits: true,
      hasCommitsElsewhere: true,
      branch: 'main',
      isDetached: false,
      upstream: null,
      ahead: null,
      behind: null,
      remoteUrl: null,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
    });

    const ready = renderHook(() => useProjectCanCreateWorktree('p1'));
    await ready.waitFor(() => expect(ready.result.current.data).toBe(true));
    ready.unmount();
  });

  it('answers false instead of rejecting when git status fails', async () => {
    // A rejection here would put the query into retry-with-backoff, and the
    // new-task forms block submit while this is fetching — so an unreadable
    // repo would present as a dead submit button rather than a disabled
    // worktree toggle.
    vi.spyOn(api.projects.git, 'getStatus').mockRejectedValue(
      new Error('fatal: Unable to create index.lock: File exists'),
    );

    const { result, waitFor, unmount } = renderHook(() =>
      useProjectCanCreateWorktree('p1'),
    );

    await waitFor(() => {
      expect(result.current.data).toBe(false);
      expect(result.current.isError).toBe(false);
    });

    unmount();
  });
});

describe('projectCanCreateWorktreeKey', () => {
  it('scopes the cache to one project', () => {
    expect(projectCanCreateWorktreeKey('p1')).not.toEqual(
      projectCanCreateWorktreeKey('p2'),
    );
  });
});
