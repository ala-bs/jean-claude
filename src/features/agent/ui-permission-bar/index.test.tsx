// @vitest-environment happy-dom

import { act, type ComponentProps } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { ModalProvider } from '@/common/context/modal';
import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { RootOverlay } from '@/common/context/overlay';

import { PermissionBar } from '.';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
});

function permissionBarElement({
  onRespond = () => {},
  parentDirectories = [{ path: '/outside' }],
}: {
  onRespond?: ComponentProps<typeof PermissionBar>['onRespond'];
  parentDirectories?: NonNullable<
    ComponentProps<typeof PermissionBar>['request']['directoryAccess']
  >['parentDirectories'];
} = {}) {
  return (
    <RootKeyboardBindings>
      <RootOverlay>
        <ModalProvider>
          <PermissionBar
            request={{
              taskId: 'task-1',
              requestId: 'permission-1',
              toolName: 'Bash',
              input: { command: 'ls /outside/repo' },
              sessionAllowButton: {
                label: 'Allow Bash for Session',
                toolsToAllow: ['bash:ls /outside/repo'],
              },
              directoryAccess: {
                requestedPath: '/outside/repo/file.ts',
                requestedDirectory: '/outside/repo',
                parentDirectories,
              },
            }}
            onRespond={onRespond}
            onAllowForSession={() => {}}
            onAllowForProject={() => {}}
            onAllowForProjectWorktrees={() => {}}
            onAllowGlobally={() => {}}
            worktreePath="/worktree"
          />
        </ModalProvider>
      </RootOverlay>
    </RootKeyboardBindings>
  );
}

function renderPermissionBar() {
  return renderToStaticMarkup(permissionBarElement());
}

function findButton(text: string) {
  return Array.from(document.body.querySelectorAll('button')).find((button) =>
    button.textContent?.includes(text),
  );
}

describe('PermissionBar directory access', () => {
  it('discloses trusted external path and recursive scope for Claude requests', () => {
    const markup = renderPermissionBar();

    expect(markup).toContain('External directory access');
    expect(markup).toContain('/outside/repo/file.ts');
    expect(markup).toContain('/outside/repo');
    expect(markup).toContain('every descendant');
  });

  it('shows session parent action without broader persistence scopes', () => {
    const markup = renderPermissionBar();

    expect(markup).toContain('Allow Parent for Session');
    expect(markup).not.toContain('Allow Bash for Session');
    expect(markup).not.toContain('Allow for Project');
    expect(markup).not.toContain('Allow Globally');
  });

  it('responds with selected parent directory and session scope', async () => {
    const onRespond = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(permissionBarElement({ onRespond }));
      });
      await act(async () => findButton('Allow Parent for Session')?.click());
      await act(async () => findButton('/outside')?.click());

      expect(onRespond).toHaveBeenCalledWith('permission-1', {
        behavior: 'allow',
        updatedInput: { command: 'ls /outside/repo' },
        allowMode: 'session',
        allowedDirectory: '/outside',
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('requires confirmation before granting a directory containing home', async () => {
    const onRespond = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          permissionBarElement({
            onRespond,
            parentDirectories: [{ path: '/Users/test', isHome: true }],
          }),
        );
      });
      await act(async () => findButton('Allow Parent for Session')?.click());
      await act(async () => findButton('/Users/test')?.click());
      expect(onRespond).not.toHaveBeenCalled();

      await act(async () => findButton('Allow Broad Access')?.click());
      expect(onRespond).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
