// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { ModalProvider, useModal } from '@/common/context/modal';
import { ClosedPrWorkspaceModal } from '@/features/pull-request/ui-closed-pr-workspace-modal';
import { ModalArbitrationProvider } from '@/common/context/modal-arbitration';
import { OverlayHost } from '@/layout/ui-overlay-host';
import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { useOverlaysStore } from '@/stores/overlays';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/hooks/use-pr-workspace-decisions', () => ({
  usePrWorkspaceDecisions: () => ({
    data: [
      {
        key: 'project-1:41',
        projectId: 'project-1',
        pullRequestId: 41,
        taskIds: ['task-1'],
      },
    ],
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useResolvePrWorkspaceDecision: () => ({
    error: null,
    isPending: false,
    mutateAsync: vi.fn(),
    variables: undefined,
  }),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: '/all' } }),
}));

// Stands in for the real backlog overlay: rendered by OverlayHost (which owns
// arbitration at priority 60) and opens a confirm through useModal().
vi.mock('@/features/project/ui-backlog-overlay', () => ({
  BacklogOverlay: ({ onClose }: { onClose: () => void }) => {
    const modal = useModal();
    return (
      <div role="dialog" aria-modal="true" aria-label="Backlog overlay">
        <span>Backlog overlay</span>
        <button
          type="button"
          onClick={() =>
            modal.confirm({
              title: 'Delete backlog item?',
              content: 'This cannot be undone.',
              variant: 'danger',
            })
          }
        >
          Delete item
        </button>
        <button type="button" onClick={onClose}>
          Close overlay
        </button>
      </div>
    );
  },
}));

function clickButton(label: string) {
  const button = [...document.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!button) throw new Error(`Button not found: ${label}`);
  act(() => button.click());
}

describe('queued modals opened from an overlay', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    useOverlaysStore.getState().closeAll();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <RootKeyboardBindings>
          <ModalArbitrationProvider>
            <ModalProvider>
              <ClosedPrWorkspaceModal />
              <OverlayHost />
            </ModalProvider>
          </ModalArbitrationProvider>
        </RootKeyboardBindings>,
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useOverlaysStore.getState().closeAll();
    document.body.innerHTML = '';
  });

  it('renders the confirm above the still-mounted overlay', async () => {
    act(() => useOverlaysStore.getState().open('backlog'));
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Backlog overlay');
    });

    clickButton('Delete item');

    await vi.waitFor(() => {
      // Confirm is visible and the overlay underneath stays mounted.
      expect(document.body.textContent).toContain('Delete backlog item?');
      expect(document.body.textContent).toContain('Backlog overlay');
    });

    // Stacking is explicit, not dependent on portal insertion order.
    expect(document.querySelector('.z-\\[10000\\]')).not.toBeNull();
  });

  it('hides the always-mounted global modal instead of stacking on it', async () => {
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Pull request #41 is closed');
    });

    act(() => useOverlaysStore.getState().open('backlog'));
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Backlog overlay');
    });
    clickButton('Delete item');

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Delete backlog item?');
      expect(document.body.textContent).not.toContain(
        'Pull request #41 is closed',
      );
    });

    clickButton('Cancel');

    await vi.waitFor(() => {
      expect(document.body.textContent).not.toContain('Delete backlog item?');
    });
  });
});
