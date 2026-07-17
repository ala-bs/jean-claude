/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { AzureDevOpsWorkItem } from '@/lib/api';
import { useToastStore } from '@/stores/toasts';

import { AzureWorkItemActions } from './project-content';

const workItem = {
  id: 123,
  url: 'https://dev.azure.com/example/_workitems/edit/123',
  fields: {
    title: 'Fix pane actions',
    workItemType: 'Bug',
    state: 'Active',
  },
} satisfies AzureDevOpsWorkItem;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  useToastStore.setState({ toasts: [] });
  vi.restoreAllMocks();
});

function renderActions() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root?.render(<AzureWorkItemActions workItem={workItem} onCreateTask={() => {}} />);
  });
}

describe('AzureWorkItemActions', () => {
  it('opens work item directly in Azure DevOps', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderActions();

    const button = document.querySelector<HTMLButtonElement>('[aria-label="Open in Azure DevOps"]');
    button?.click();

    expect(open).toHaveBeenCalledWith(
      workItem.url,
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('copies work item link and confirms success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderActions();

    const button = document.querySelector<HTMLButtonElement>('[aria-label="Copy work item link"]');
    button?.click();

    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(workItem.url);
      expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
        message: 'Work item link copied',
        type: 'success',
      });
    });
  });

  it('reports clipboard failures', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) },
    });
    renderActions();

    const button = document.querySelector<HTMLButtonElement>('[aria-label="Copy work item link"]');
    button?.click();

    await vi.waitFor(() => {
      expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
        message: 'Failed to copy work item link',
        type: 'error',
      });
    });
  });
});
