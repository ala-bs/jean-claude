// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { RootOverlay } from '@/common/context/overlay';
import { RunButton } from '@/features/agent/ui-run-button';
import { useTaskMessagesStore } from '@/stores/task-messages';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  commands: [] as Array<Record<string, unknown>>,
  groups: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/hooks/use-project-commands', () => ({
  useProjectCommands: () => ({
    data: mocks.commands,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-project-command-groups', () => ({
  useProjectCommandGroups: () => ({
    data: mocks.groups,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-run-commands', () => ({
  useRunCommands: () => ({
    status: null,
    statusByCommandId: {},
    isCommandStarting: () => false,
    isCommandStopping: () => false,
    isStartingAnyCommand: false,
    startCommand: vi.fn(),
    startGroup: vi.fn(),
    stopCommand: vi.fn(),
    stopGroup: vi.fn(),
    portsInUseError: null,
    confirmKillPorts: vi.fn(),
    dismissPortsError: vi.fn(),
  }),
}));

const command = {
  id: 'command-1',
  projectId: 'project-1',
  name: 'Dev',
  command: 'pnpm dev',
  ports: [],
  portConflictStrategy: 'prompt',
  portOverrideProvider: 'env',
  portOverrideEnvVar: null,
  portOverrideArgs: null,
  envVars: [],
  confirmBeforeRun: false,
  confirmMessage: null,
  sortOrder: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('RunButton command availability', () => {
  let container: HTMLDivElement;
  let root: Root;

  async function renderButton() {
    await act(async () =>
      root.render(
        <RootOverlay>
          <RootKeyboardBindings>
            <RunButton
              taskId="task-1"
              projectId="project-1"
              workingDir="/repo"
              onToggleLogs={vi.fn()}
              onRunCommand={vi.fn()}
              isLogsPaneOpen={false}
            />
          </RootKeyboardBindings>
        </RootOverlay>,
      ),
    );
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    mocks.commands = [];
    mocks.groups = [];
    useTaskMessagesStore.setState({ runCommandLogs: {}, runCommandRunning: {} });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
  });

  it('does not render Run for groups without executable commands', async () => {
    mocks.groups = [
      {
        id: 'group-1',
        projectId: 'project-1',
        name: 'Stale group',
        commandIds: ['missing-command'],
        sortOrder: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    await renderButton();
    expect(container.querySelector('[aria-label="Run command"]')).toBeNull();
  });

  it('renders resolvable groups as actionable Run items', async () => {
    mocks.commands = [command];
    mocks.groups = [
      {
        id: 'group-1',
        projectId: 'project-1',
        name: 'Workspace',
        commandIds: ['command-1'],
        sortOrder: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    await renderButton();
    const runButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Run command"]',
    );
    expect(runButton).not.toBeNull();
    await act(async () => runButton!.click());
    expect(document.body.textContent).toContain('Workspace');
  });
});
