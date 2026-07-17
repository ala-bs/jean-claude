/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';

import { api } from '@/lib/api';

import { useSetAutoComplete } from './use-pull-requests';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
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
