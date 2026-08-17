// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';

import { ModalProvider } from '@/common/context/modal';
import { PermissionBar } from '@/features/agent/ui-permission-bar';
import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { RootOverlay } from '@/common/context/overlay';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const request = {
  taskId: 'task-1',
  requestId: 'request-1',
  toolName: 'Bash',
  input: { command: 'pnpm test' },
  sessionAllowButton: {
    label: 'Allow for Session',
    toolsToAllow: ['bash:pnpm test'],
  },
};

async function renderBar() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onRespond = vi.fn();
  const onAllowForSession = vi.fn(async () => undefined);
  const onAllowForProject = vi.fn(async () => undefined);
  await act(async () => {
    root.render(
      createElement(
        RootOverlay,
        null,
        createElement(
          RootKeyboardBindings,
          null,
          createElement(
            ModalProvider,
            null,
            createElement(PermissionBar, {
              request,
              onRespond,
              onAllowForSession,
              onAllowForProject,
            }),
          ),
        ),
      ),
    );
  });
  return {
    container,
    onRespond,
    onAllowForSession,
    onAllowForProject,
    root,
  };
}

async function clickButton(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Button not found: ${label}`);
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

async function clickPersistenceAction(container: HTMLElement, label: string) {
  await clickButton(container, 'Grant rule');
  await clickButton(document.body, label);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('PermissionBar persistence', () => {
  it('allows once without persisting a session rule', async () => {
    const view = await renderBar();
    await clickButton(view.container, 'Allow');

    expect(view.onRespond).toHaveBeenCalledWith('request-1', {
      behavior: 'allow',
      updatedInput: request.input,
    });
    expect(view.onAllowForSession).not.toHaveBeenCalled();
    await act(async () => view.root.unmount());
  });

  it('persists only through the selected session or project operation', async () => {
    const sessionView = await renderBar();
    await clickPersistenceAction(sessionView.container, 'Session');
    expect(sessionView.onAllowForSession).toHaveBeenCalledWith(
      'Bash',
      { ...request.input, __permissionExact: true },
    );
    await act(async () => sessionView.root.unmount());

    const projectView = await renderBar();
    await clickPersistenceAction(projectView.container, 'Project (recommended)');
    expect(projectView.onAllowForProject).toHaveBeenCalledWith(
      'Bash',
      request.input,
    );
    expect(projectView.onAllowForSession).not.toHaveBeenCalled();
    await act(async () => projectView.root.unmount());
  });

  it('does not approve execution when persistence fails', async () => {
    const view = await renderBar();
    view.onAllowForSession.mockRejectedValueOnce(new Error('write failed'));

    await clickPersistenceAction(view.container, 'Session');

    expect(view.onRespond).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('Permission Required');
    await act(async () => view.root.unmount());
  });

  it('hides persistence actions when their callbacks are unavailable', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onRespond = vi.fn();
    await act(async () => {
      root.render(
        createElement(
          RootOverlay,
          null,
          createElement(
            RootKeyboardBindings,
            null,
            createElement(ModalProvider, null, createElement(PermissionBar, { request, onRespond })),
          ),
        ),
      );
    });

    expect(container.textContent).toContain('Allow');
    expect(container.textContent).not.toContain('Allow for Session');
    expect(container.textContent).not.toContain('Allow for Project');
    expect(container.textContent).not.toContain('Allow Globally');

    await clickButton(container, 'Allow');
    expect(onRespond).toHaveBeenCalledWith('request-1', {
      behavior: 'allow',
      updatedInput: request.input,
    });
    expect(onRespond.mock.calls[0]?.[1]).not.toHaveProperty('allowMode');
    await act(async () => root.unmount());
  });
});
