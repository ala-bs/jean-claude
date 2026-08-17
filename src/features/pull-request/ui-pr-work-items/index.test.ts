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

import { useWorkItemModalStore } from '@/stores/work-item-modal';

import { PrWorkItems } from '.';

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
  useWorkItemModalStore.getState().close();
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
    projectId: 'project-1',
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

    expect(useWorkItemModalStore.getState().target).toEqual({
      projectId: 'project-1',
      workItemId: workItem.id,
    });
  });
});
