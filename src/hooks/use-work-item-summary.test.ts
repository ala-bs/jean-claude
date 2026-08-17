// @vitest-environment happy-dom

import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { flushSync } from 'react-dom';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { WorkItemSummary } from '@shared/work-item-summary-types';

import {
  useGenerateWorkItemSummary,
  workItemSummaryKeys,
} from './use-work-item-summary';
import { api } from '@/lib/api';

const summary: WorkItemSummary = {
  providerId: 'provider-1',
  workItemId: 42,
  content: '## Problem\n\nProblem.\n\n## Outcome\n\nOutcome.',
  sourceChangedDate: null,
  sourceLatestCommentId: null,
  sourceCommentCount: 0,
  generatedAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
  isStale: false,
};

describe('workItemSummaryKeys', () => {
  it('uses stable detail identity and sorted unique batch IDs', () => {
    expect(workItemSummaryKeys.detail('provider-1', 42)).toEqual([
      'work-item-summary',
      'provider-1',
      42,
    ]);
    expect(workItemSummaryKeys.batch('provider-1', [43, 42, 43])).toEqual([
      'work-item-summaries',
      'provider-1',
      [42, 43],
    ]);
  });
});

describe('useGenerateWorkItemSummary', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) flushSync(() => root?.unmount());
    container?.remove();
    vi.restoreAllMocks();
    root = null;
    container = null;
  });

  it('updates detail cache and invalidates batch and feed queries', async () => {
    vi.spyOn(api.azureDevOps, 'generateWorkItemSummary').mockResolvedValue(
      summary,
    );
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    let mutation: ReturnType<typeof useGenerateWorkItemSummary> | undefined;

    function Harness() {
      mutation = useGenerateWorkItemSummary();
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() =>
      root?.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness),
        ),
      ),
    );

    await mutation?.mutateAsync({
      projectId: 'project-1',
      providerId: 'provider-1',
      projectName: 'Azure Project',
      workItemId: 42,
    });

    expect(
      queryClient.getQueryData(workItemSummaryKeys.detail('provider-1', 42)),
    ).toEqual(summary);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['work-item-summaries', 'provider-1'],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['feed', 'work-items'],
    });
  });
});
