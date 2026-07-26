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
            onAllowForSession={async () => {}}
            onAllowForProject={async () => {}}
            onAllowForProjectWorktrees={async () => {}}
            onAllowGlobally={async () => {}}
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

function compoundBarElement({
  onRespond = () => {},
  onAllowForProject = async () => {},
}: {
  onRespond?: ComponentProps<typeof PermissionBar>['onRespond'];
  onAllowForProject?: ComponentProps<
    typeof PermissionBar
  >['onAllowForProject'];
} = {}) {
  return (
    <RootKeyboardBindings>
      <RootOverlay>
        <ModalProvider>
          <PermissionBar
            request={{
              taskId: 'task-1',
              requestId: 'permission-2',
              toolName: 'Bash',
              input: { command: 'cd /worktree && git status | grep foo src' },
              permissionEvaluation: {
                action: 'ask',
                subCommands: [
                  {
                    command: 'cd /worktree',
                    action: 'allow',
                    matchedRule: {
                      tool: 'bash',
                      pattern: 'cd *',
                      action: 'allow',
                    },
                  },
                  {
                    command: 'git status',
                    action: 'allow',
                    matchedRule: {
                      tool: 'bash',
                      pattern: 'git status *',
                      action: 'allow',
                    },
                  },
                  { command: 'grep foo src', action: 'ask' },
                ],
              },
            }}
            onRespond={onRespond}
            onAllowForProject={onAllowForProject}
            worktreePath="/worktree"
          />
        </ModalProvider>
      </RootOverlay>
    </RootKeyboardBindings>
  );
}

describe('PermissionBar compound bash breakdown', () => {
  it('renders one row per subcommand with its matched rule', () => {
    const markup = renderToStaticMarkup(compoundBarElement());

    expect(markup).toContain('cd /worktree');
    expect(markup).toContain('git status *');
    expect(markup).toContain('no rule');
    expect(markup).toContain('1 of 3 command parts need approval');
    // The raw command stays visible — parsed parts drop redirections.
    expect(markup).toContain('cd /worktree &amp;&amp; git status | grep foo src');
  });

  it('suggests rules only for the blocking subcommand', () => {
    const markup = renderToStaticMarkup(compoundBarElement());

    expect(markup).toContain('Auto-allow next time:');
    expect(markup).toContain('grep *');
    expect(markup).not.toContain('+ git *');
  });

  it('grants the chosen suggestion at project scope and allows', async () => {
    const onRespond = vi.fn();
    const onAllowForProject = vi.fn(async () => {});
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(compoundBarElement({ onRespond, onAllowForProject }));
      });
      await act(async () => findButton('+ grep *')?.click());

      expect(onAllowForProject).toHaveBeenCalledWith('Bash', {
        command: 'grep *',
      });
      expect(onRespond).toHaveBeenCalledWith('permission-2', {
        behavior: 'allow',
        updatedInput: {
          command: 'cd /worktree && git status | grep foo src',
        },
        allowMode: 'project',
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

function bashBarElement({
  command,
  subCommands,
  onRespond = () => {},
  onAllowForProject = async () => {},
}: {
  command: string;
  subCommands?: NonNullable<
    ComponentProps<typeof PermissionBar>['request']['permissionEvaluation']
  >['subCommands'];
  onRespond?: ComponentProps<typeof PermissionBar>['onRespond'];
  onAllowForProject?: ComponentProps<
    typeof PermissionBar
  >['onAllowForProject'];
}) {
  return (
    <RootKeyboardBindings>
      <RootOverlay>
        <ModalProvider>
          <PermissionBar
            request={{
              taskId: 'task-1',
              requestId: 'permission-3',
              toolName: 'Bash',
              input: { command },
              permissionEvaluation: { action: 'ask', subCommands },
            }}
            onRespond={onRespond}
            onAllowForProject={onAllowForProject}
            worktreePath="/worktree"
          />
        </ModalProvider>
      </RootOverlay>
    </RootKeyboardBindings>
  );
}

describe('PermissionBar suggestion safety', () => {
  it('suppresses suggestions for risky commands', () => {
    const markup = renderToStaticMarkup(
      bashBarElement({ command: 'sudo rm -rf /tmp/x' }),
    );

    expect(markup).toContain('Destructive or privileged command');
    expect(markup).not.toContain('Auto-allow next time');
  });

  it('suppresses suggestions for compound commands with no breakdown', () => {
    const markup = renderToStaticMarkup(
      bashBarElement({ command: 'cat a.ts && cat b.ts' }),
    );

    expect(markup).not.toContain('Auto-allow next time');
  });

  it('grants a rule for every blocking part in one click', async () => {
    const onRespond = vi.fn();
    const onAllowForProject = vi.fn(async () => {});
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          bashBarElement({
            command: 'grep foo src | jq .',
            subCommands: [
              { command: 'grep foo src', action: 'ask' },
              { command: 'jq .', action: 'ask' },
            ],
            onRespond,
            onAllowForProject,
          }),
        );
      });
      await act(async () => findButton('+ grep * + jq *')?.click());

      expect(onAllowForProject.mock.calls).toEqual([
        ['Bash', { command: 'grep *' }],
        ['Bash', { command: 'jq *' }],
      ]);
      expect(onRespond).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
