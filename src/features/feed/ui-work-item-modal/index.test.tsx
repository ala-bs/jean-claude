// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { useState } from 'react';

import { Modal } from '@/common/ui/modal';
import { ModalArbitrationProvider } from '@/common/context/modal-arbitration';
import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { useWorkItemModalStore } from '@/stores/work-item-modal';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: '/all' } }),
}));

// Stands in for the real WorkItemDetails: it renders its own nested Modal for
// linked items, which is the case that must not unmount the outer modal.
vi.mock('@/features/feed/ui-work-item-details', () => ({
  WorkItemDetails: ({ workItemId }: { workItemId: number }) => {
    const [linkedOpen, setLinkedOpen] = useState(false);
    return (
      <div>
        <span>Details for {workItemId}</span>
        <button type="button" onClick={() => setLinkedOpen(true)}>
          Open linked
        </button>
        <Modal
          isOpen={linkedOpen}
          onClose={() => setLinkedOpen(false)}
          title="Linked item"
        >
          <span>Linked content</span>
        </Modal>
      </div>
    );
  },
}));

const { WorkItemModal } = await import('@/features/feed/ui-work-item-modal');

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(
      <ModalArbitrationProvider>
        <RootKeyboardBindings>
          <WorkItemModal />
        </RootKeyboardBindings>
      </ModalArbitrationProvider>,
    );
  });
}

function click(label: string) {
  const button = [...document.querySelectorAll('button')].find(
    (el) => el.textContent === label,
  );
  expect(button).toBeTruthy();
  act(() => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useWorkItemModalStore.setState({ target: null });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('WorkItemModal', () => {
  it('renders nothing when no work item is targeted', () => {
    render();
    expect(document.body.textContent).not.toContain('Details for');
  });

  it('shows work item details when opened', () => {
    render();
    act(() => {
      useWorkItemModalStore
        .getState()
        .open({ projectId: 'project-1', workItemId: 42 });
    });
    expect(document.body.textContent).toContain('Details for 42');
    expect(document.body.textContent).toContain('Work Item #42');
  });

  it('keeps the work item modal mounted when a linked item modal opens', () => {
    render();
    act(() => {
      useWorkItemModalStore
        .getState()
        .open({ projectId: 'project-1', workItemId: 42 });
    });

    click('Open linked');

    expect(document.body.textContent).toContain('Linked content');
    expect(document.body.textContent).toContain('Details for 42');
  });
});
