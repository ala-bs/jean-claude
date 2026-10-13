// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createElement } from 'react';

const addToast = vi.fn();

vi.mock('@/stores/toasts', () => ({
  useToastStore: (selector: (state: { addToast: unknown }) => unknown) =>
    selector({ addToast }),
}));

const getWorkItemById = vi.fn();

vi.mock('@/lib/api', () => ({
  api: { azureDevOps: { getWorkItemById: (...args: unknown[]) => getWorkItemById(...args) } },
}));

vi.mock('@/cache/cache-actions', () => ({ markDocumentStale: vi.fn() }));

const { useWorkItemById } = await import('./use-work-items');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  addToast.mockClear();
  getWorkItemById.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Probe() {
  useWorkItemById({ providerId: 'p1', workItemId: 1 });
  return null;
}

async function renderProbe() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Probe),
      ),
    );
  });
  // Let the query settle and the effect flush.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('partial field failure toast (F3)', () => {
  it('raises a toast naming the refNames Azure rejected', async () => {
    getWorkItemById.mockResolvedValue({
      id: 1,
      url: 'u',
      fields: {},
      partialFieldFailure: ['Custom.Severity'],
    });

    await renderProbe();

    expect(addToast).toHaveBeenCalledTimes(1);
    const [{ type, message }] = addToast.mock.calls[0];
    expect(type).toBe('error');
    expect(message).toContain('Custom.Severity');
    expect(message).toContain('could not be loaded');
  });

  it('stays silent when every configured field loaded', async () => {
    getWorkItemById.mockResolvedValue({ id: 1, url: 'u', fields: {} });

    await renderProbe();

    expect(addToast).not.toHaveBeenCalled();
  });
});
