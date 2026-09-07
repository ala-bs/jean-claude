import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';

import { invalidateProjectGit } from './use-project-git';

function createClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/**
 * Subscribes an observer and waits until its first fetch has fully settled.
 *
 * Both steps matter. `invalidateQueries` defaults to `refetchType: 'active'`,
 * so a query with no observers is marked stale but never refetched — a test
 * that skips the subscribe passes against an implementation that refetches
 * nothing. And an invalidation issued while the initial fetch is still
 * in-flight is deduped rather than run, so waiting only for the first
 * `queryFn` *call* makes the assertions below flaky.
 */
async function activateQuery(
  client: QueryClient,
  queryKey: readonly unknown[],
  queryFn: () => Promise<unknown>,
) {
  const observer = new QueryObserver(client, { queryKey, queryFn });
  const unsubscribe = observer.subscribe(() => {});
  await vi.waitFor(() => {
    const state = client.getQueryState(queryKey);
    expect(state?.status).toBe('success');
    expect(state?.fetchStatus).toBe('idle');
  });
  return unsubscribe;
}

describe('invalidateProjectGit', () => {
  it('does not resolve until the refetch it triggered has finished', async () => {
    const client = createClient();
    let calls = 0;
    let resolveRefetch: (() => void) | undefined;

    const unsubscribe = await activateQuery(
      client,
      ['project-git-status', 'p1'],
      () => {
        calls += 1;
        if (calls === 1) return Promise.resolve('initial');
        // Hold the refetch open so we can observe that the caller is still
        // waiting on it — this is what drives the button's spinner.
        return new Promise((resolve) => {
          resolveRefetch = () => resolve('refetched');
        });
      },
    );

    let settled = false;
    const pending = invalidateProjectGit(client, 'p1').then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(resolveRefetch).toBeDefined());
    expect(settled).toBe(false);

    resolveRefetch?.();
    await pending;
    expect(settled).toBe(true);
    expect(calls).toBe(2);

    unsubscribe();
    client.clear();
  });

  it('refetches the working tree files query', async () => {
    const client = createClient();
    let calls = 0;
    const unsubscribe = await activateQuery(
      client,
      ['project-working-tree-files', 'p1'],
      () => {
        calls += 1;
        return Promise.resolve([]);
      },
    );

    await invalidateProjectGit(client, 'p1');
    expect(calls).toBe(2);

    unsubscribe();
    client.clear();
  });

  it('refetches a filtered commit graph, not just the unfiltered one', async () => {
    const client = createClient();
    let calls = 0;
    const unsubscribe = await activateQuery(
      client,
      ['project-git-graph', 'p1', { query: 'fix', branches: ['main'] }],
      () => {
        calls += 1;
        return Promise.resolve([]);
      },
    );

    await invalidateProjectGit(client, 'p1');
    expect(calls).toBe(2);

    unsubscribe();
    client.clear();
  });

  it('leaves other projects alone', async () => {
    const client = createClient();
    let calls = 0;
    const unsubscribe = await activateQuery(
      client,
      ['project-git-status', 'other'],
      () => {
        calls += 1;
        return Promise.resolve(null);
      },
    );

    await invalidateProjectGit(client, 'p1');
    expect(calls).toBe(1);

    unsubscribe();
    client.clear();
  });

  it('resolves when the project has no active queries', async () => {
    const client = createClient();
    await expect(invalidateProjectGit(client, 'p1')).resolves.toBeUndefined();
    client.clear();
  });
});
