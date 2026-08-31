// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { type OverlayType, useOverlaysStore } from '@/stores/overlays';
import { Modal } from '@/common/ui/modal';
import { ModalArbitrationProvider } from '@/common/context/modal-arbitration';
import { OverlayHost } from '@/layout/ui-overlay-host';
import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

// Stands in for an always-mounted, lowest-priority global modal.
function GlobalBackgroundModal() {
  return (
    <Modal
      isOpen
      onClose={() => {}}
      closeOnClickOutside={false}
      closeOnEscape={false}
      showHeader={false}
      arbitrationPriority={0}
      ariaLabel="Global background modal"
    >
      <p>Global background modal</p>
    </Modal>
  );
}

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: '/all' } }),
}));

function mockOverlay(label: string, onClose: () => void) {
  return (
    <div role="dialog" aria-modal="true" aria-label={label}>
      <span>{label}</span>
      <button type="button" onClick={onClose}>
        Close overlay
      </button>
    </div>
  );
}

vi.mock('@/features/settings/ui-settings-overlay', () => ({
  SettingsOverlay: ({ onClose }: { onClose: () => void }) =>
    mockOverlay('Settings overlay', onClose),
}));
vi.mock('@/features/calendar/ui-calendar-overlay', () => ({
  CalendarOverlay: ({ onClose }: { onClose: () => void }) =>
    mockOverlay('Calendar overlay', onClose),
}));
vi.mock('@/features/resources/ui-resources-overlay', () => ({
  ResourcesOverlay: ({ onClose }: { onClose: () => void }) =>
    mockOverlay('Resources overlay', onClose),
}));

describe('OverlayHost modal arbitration', () => {
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
            <GlobalBackgroundModal />
            <OverlayHost />
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

  it.each([
    ['settings', 'Settings overlay'],
    ['calendar', 'Calendar overlay'],
    ['resources', 'Resources overlay'],
  ] as const)(
    'preempts and resumes the global modal through the real %s store path',
    async (overlay: OverlayType, label: string) => {
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain('Global background modal');
      });

      act(() => useOverlaysStore.getState().open(overlay));
      await vi.waitFor(() => {
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
        expect(document.body.textContent).toContain(label);
        expect(document.body.textContent).not.toContain('Global background modal');
      });

      act(() => {
        document.querySelector<HTMLButtonElement>('button')?.click();
      });
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain('Global background modal');
        expect(document.body.textContent).not.toContain(label);
      });
    },
  );

  it('clears obsolete keyboard-help state without starving visible modals', async () => {
    act(() => {
      useOverlaysStore.setState({
        activeOverlay: 'keyboard-help' as OverlayType,
        runningCommandTarget: null,
      });
    });

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Global background modal');
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect(useOverlaysStore.getState().activeOverlay).toBeNull();
    });
  });
});
