// @vitest-environment happy-dom

import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { flushSync } from 'react-dom';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type {
  WorkItemSummary,
  WorkItemSummaryRequest,
} from '@shared/work-item-summary-types';

import { workItemSummaryKeys } from '@/hooks/use-work-item-summary';

import { api } from '@/lib/api';
import { useBackgroundJobsStore } from '@/stores/background-jobs';
import { WorkItemGeneratedSummary } from '.';

vi.mock('@/features/common/ui-mermaid-diagram', () => ({
  MermaidDiagram: ({ source }: { source: string }) =>
    createElement('div', { 'data-testid': 'mermaid-diagram' }, source),
}));

vi.mock('@/common/ui/modal', () => ({ Modal: () => null }));

const request: WorkItemSummaryRequest = {
  projectId: 'project-1',
  providerId: 'provider-1',
  projectName: 'Azure Project',
  workItemId: 42,
};

const summary: WorkItemSummary = {
  providerId: request.providerId,
  workItemId: request.workItemId,
  content:
    '# Checkout\n\nPayment fails for **saved cards**.\n\n```mermaid\nflowchart LR\nA --> B\n```\n\n```text\nASCII -> stays code\n```',
  sourceChangedDate: null,
  sourceLatestCommentId: null,
  sourceCommentCount: 0,
  generatedAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
  isStale: true,
};

describe('WorkItemGeneratedSummary', () => {
  let root: Root;
  let container: HTMLDivElement;
  let queryClient: QueryClient;
  const writeText = vi.fn();

  beforeEach(() => {
    useBackgroundJobsStore.setState({ jobs: [] });
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    queryClient.clear();
    vi.restoreAllMocks();
  });

  function render() {
    flushSync(() =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(WorkItemGeneratedSummary, {
            request,
            workItemTitle: 'Checkout fails',
          }),
        ),
      ),
    );
  }

  it('renders raw Markdown with Mermaid and copies it unchanged', async () => {
    queryClient.setQueryData(
      workItemSummaryKeys.detail(request.providerId, request.workItemId),
      summary,
    );
    render();

    expect(container.textContent).toContain('Source updated');
    expect(container.textContent).toContain('Payment fails for saved cards');
    expect(container.querySelector('[data-testid="mermaid-diagram"]')?.textContent).toBe(
      'flowchart LR\nA --> B',
    );
    expect(container.textContent).toContain('ASCII -> stays code');
    const copyButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.includes('Copy'),
    );
    copyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(summary.content);
  });

  it('generates from empty state and records a succeeded job', async () => {
    vi.spyOn(api.azureDevOps, 'getWorkItemSummary').mockResolvedValue(null);
    vi.spyOn(api.azureDevOps, 'generateWorkItemSummary').mockResolvedValue({
      ...summary,
      isStale: false,
    });
    render();

    await vi.waitFor(() =>
      expect(container.textContent).toContain('Generate summary'),
    );
    const generateButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.includes('Generate summary'),
    );
    generateButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await vi.waitFor(() =>
      expect(container.textContent).toContain('Payment fails for saved cards'),
    );
    expect(useBackgroundJobsStore.getState().jobs[0]).toMatchObject({
      type: 'work-item-summary-generation',
      status: 'succeeded',
    });
  });

  it('keeps the generate button focused while generation starts', async () => {
    let finishGeneration: ((value: WorkItemSummary) => void) | undefined;
    vi.spyOn(api.azureDevOps, 'getWorkItemSummary').mockResolvedValue(null);
    vi.spyOn(api.azureDevOps, 'generateWorkItemSummary').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishGeneration = resolve;
        }),
    );
    render();

    await vi.waitFor(() =>
      expect(container.textContent).toContain('Generate summary'),
    );
    const generateButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.includes('Generate summary'),
    );
    generateButton?.focus();
    generateButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await vi.waitFor(() =>
      expect(generateButton?.getAttribute('aria-disabled')).toBe('true'),
    );
    expect(generateButton?.disabled).toBe(false);
    expect(document.activeElement).toBe(generateButton);

    finishGeneration?.({ ...summary, isStale: false });
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Payment fails for saved cards'),
    );
  });
});
