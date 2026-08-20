/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { AzureDevOpsWorkItem } from '@/lib/api';
import { api } from '@/lib/api';

import { PrWorkItems } from '.';

function makeWorkItem(
  id: number,
  title: string,
  state = 'Active',
): AzureDevOpsWorkItem {
  return {
    id,
    url: `https://dev.azure.com/example/_workitems/edit/${id}`,
    fields: { title, workItemType: 'Bug', state },
  };
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function renderWithSearchOpen({
  workItems = [],
  onLink = vi.fn(),
}: { workItems?: AzureDevOpsWorkItem[]; onLink?: () => void } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(PrWorkItems, {
          projectId: 'project-1',
          workItems,
          isLoading: false,
          providerId: 'provider-1',
          azureProjectId: 'azure-1',
          azureProjectName: 'Azure Project',
          onLink,
        }),
      ),
    );
  });

  const addButton = document.querySelector<HTMLButtonElement>(
    'button[title="Link work item"]',
  );
  await act(async () => {
    addButton?.click();
  });

  return document.querySelector<HTMLInputElement>('input[type="text"]')!;
}

/** Types into the input and flushes the 300ms debounce + the query. */
async function typeAndSettle(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // Flush the debounce timer, then the resolved query's state update
  for (const delay of [350, 0, 0]) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
    });
  }
}

describe('PrWorkItems work item search', () => {
  it('queries and lists results when typing a numeric work item id', async () => {
    const queryWorkItems = vi
      .spyOn(api.azureDevOps, 'queryWorkItems')
      .mockResolvedValue([
        makeWorkItem(123, 'Fix login bug', 'Closed'),
        makeWorkItem(1234, 'Refactor auth'),
      ]);

    const input = await renderWithSearchOpen();
    await typeAndSettle(input, '123');

    // The ID search must actually hit the backend...
    expect(queryWorkItems).toHaveBeenCalledTimes(1);
    const call = queryWorkItems.mock.calls[0][0];
    expect(call.filters.searchText).toBe('123');
    // ...without a state filter, so a Closed item is still findable by id
    expect(call.filters.states).toBeUndefined();

    // ...and render matching items instead of only a blind link button
    const text = container?.textContent ?? '';
    expect(text).toContain('Fix login bug');
    expect(text).toContain('Refactor auth');
    expect(text).not.toContain('Link work item 123');
  });

  it('keeps the state filter for text searches', async () => {
    const queryWorkItems = vi
      .spyOn(api.azureDevOps, 'queryWorkItems')
      .mockResolvedValue([]);

    const input = await renderWithSearchOpen();
    await typeAndSettle(input, 'login');

    expect(queryWorkItems.mock.calls[0][0].filters.states).toEqual([
      'New',
      'Active',
      'In Progress',
      'To Do',
      'In Design',
    ]);
    expect(container?.textContent).toContain('No matching work items found');
  });

  it('offers a blind link only when the exact id is not in the results', async () => {
    vi.spyOn(api.azureDevOps, 'queryWorkItems').mockResolvedValue([]);

    const input = await renderWithSearchOpen();
    await typeAndSettle(input, '999');

    expect(container?.textContent).toContain('Link work item');
    expect(container?.textContent).toContain('#999');
  });

  it('links the exact id match on Enter, not the most recently changed item', async () => {
    const onLink = vi.fn();
    vi.spyOn(api.azureDevOps, 'queryWorkItems').mockResolvedValue([
      makeWorkItem(4321, 'Bump to v123'),
      makeWorkItem(123, 'Fix login bug'),
    ]);

    const input = await renderWithSearchOpen({ onLink });
    await typeAndSettle(input, '123');

    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });

    expect(onLink).toHaveBeenCalledWith(123);
  });

  it('reports an already-linked id instead of "no matching work items"', async () => {
    vi.spyOn(api.azureDevOps, 'queryWorkItems').mockResolvedValue([
      makeWorkItem(123, 'Fix login bug'),
    ]);

    const input = await renderWithSearchOpen({
      workItems: [makeWorkItem(123, 'Fix login bug')],
    });
    await typeAndSettle(input, '123');

    expect(container?.textContent).toContain('#123 is already linked');
  });
});
