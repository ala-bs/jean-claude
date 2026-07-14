/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { flushSync } from 'react-dom';

import type { AzureDevOpsWorkItem } from '@/lib/api';
import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { useCommands } from '@/common/hooks/use-commands';

import { PrWorkItems } from '.';

vi.mock('@/features/work-item/ui-work-item-preview', () => ({
  WorkItemPreview: ({
    onOpenInBrowser,
  }: {
    onOpenInBrowser?: () => void;
  }) =>
    createElement(
      'button',
      { onClick: onOpenInBrowser },
      'Open in Azure',
    ),
}));

const workItem = {
  id: 123,
  url: 'https://dev.azure.com/example/_workitems/edit/123',
  fields: {
    title: 'Fix shortcut target',
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
  vi.restoreAllMocks();
});

function Harness() {
  useCommands('test-pr-shortcut', [
    {
      label: 'Open PR in Azure DevOps',
      shortcut: 'cmd+shift+o',
      handler: () => {
        window.open('https://dev.azure.com/example/pullrequest/456', '_blank');
      },
    },
  ]);

  return createElement(PrWorkItems, {
    workItems: [workItem],
    isLoading: false,
  });
}

function renderHarness() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root?.render(
      createElement(RootKeyboardBindings, null, createElement(Harness)),
    );
  });
}

function pressOpenShortcut() {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'o',
      metaKey: true,
      shiftKey: true,
      bubbles: true,
    }),
  );
}

describe('PrWorkItems', () => {
  it('opens current work item from modal shortcut and button', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderHarness();

    pressOpenShortcut();
    expect(open).toHaveBeenLastCalledWith(
      'https://dev.azure.com/example/pullrequest/456',
      '_blank',
    );

    const row = document.querySelector('[role="button"]');
    expect(row).not.toBeNull();
    flushSync(() => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    open.mockClear();
    pressOpenShortcut();
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(
      workItem.url,
      '_blank',
      'noopener,noreferrer',
    );

    const button = Array.from(document.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.includes('Open in Azure'),
    );
    expect(button).toBeDefined();

    open.mockClear();
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(open).toHaveBeenCalledWith(
      workItem.url,
      '_blank',
      'noopener,noreferrer',
    );
  });
});
