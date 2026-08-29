// @vitest-environment happy-dom
/* eslint-disable sort-imports */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api';

import { commitIgnoreQueryKey, useCommitIgnore } from './use-commit-ignore';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT_ID = 'project-1';

/** Lets React Query's cache notification reach the subscribed component. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
  });
}

describe('useCommitIgnore', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let hook: ReturnType<typeof useCommitIgnore>;

  async function render(initialContent: string) {
    vi.spyOn(api.projects, 'getCommitIgnore').mockResolvedValue(initialContent);

    function Probe() {
      hook = useCommitIgnore(PROJECT_ID);
      return null;
    }

    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Probe),
        ),
      );
    });
    // Let the initial fetch settle so `content` is populated.
    for (let i = 0; i < 50 && !hook.isReady; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
      });
    }
    expect(hook.isReady).toBe(true);
    expect(hook.content).toBe(initialContent);
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
    vi.restoreAllMocks();
  });

  it('reports ignored paths from the project rules', async () => {
    await render('*.log\nsrc/generated.ts');
    expect(hook.isIgnored('a.log')).toBe(true);
    expect(hook.isIgnored('src/generated.ts')).toBe(true);
    expect(hook.isIgnored('src/index.ts')).toBe(false);
  });

  it('cannot un-ignore a path a glob also covers', async () => {
    await render('*.log\ndebug.log');
    expect(hook.canUnignore(['debug.log'])).toBe(false);
  });

  it('writes an appended rule', async () => {
    const update = vi
      .spyOn(api.projects, 'updateCommitIgnore')
      .mockResolvedValue(undefined);
    await render('*.log');

    await act(async () => {
      hook.setIgnored(['src/a.ts'], true);
    });

    await flush();
    expect(update).toHaveBeenCalledWith(PROJECT_ID, '*.log\nsrc/a.ts');
    expect(hook.isIgnored('src/a.ts')).toBe(true);
  });

  it('removes a rule when un-ignoring', async () => {
    const update = vi
      .spyOn(api.projects, 'updateCommitIgnore')
      .mockResolvedValue(undefined);
    await render('*.log\nsrc/a.ts');

    await act(async () => {
      hook.setIgnored(['src/a.ts'], false);
    });

    await flush();
    expect(update).toHaveBeenCalledWith(PROJECT_ID, '*.log');
    expect(hook.isIgnored('src/a.ts')).toBe(false);
  });

  it('keeps both rules when two toggles fire before the first write lands', async () => {
    // Whole-file writes: the second toggle must build on the first one's value
    // rather than on the content captured at render time, or it drops it.
    let resolveFirst: (() => void) | undefined;
    const update = vi
      .spyOn(api.projects, 'updateCommitIgnore')
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(undefined);

    await render('');

    await act(async () => {
      hook.setIgnored(['a.ts'], true);
      hook.setIgnored(['b.ts'], true);
    });

    expect(update).toHaveBeenLastCalledWith(PROJECT_ID, 'a.ts\nb.ts');

    await act(async () => {
      resolveFirst?.();
      await Promise.resolve();
    });

    // The older in-flight response must not roll the cache back to 'a.ts'.
    expect(
      queryClient.getQueryData(commitIgnoreQueryKey(PROJECT_ID)),
    ).toBe('a.ts\nb.ts');
  });

  it('ignores a no-op toggle', async () => {
    const update = vi
      .spyOn(api.projects, 'updateCommitIgnore')
      .mockResolvedValue(undefined);
    await render('a.ts');

    await act(async () => {
      hook.setIgnored(['a.ts'], true);
      hook.setIgnored(['missing.ts'], false);
    });

    expect(update).not.toHaveBeenCalled();
  });
});
