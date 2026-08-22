/**
 * @vitest-environment happy-dom
 */
/* eslint-disable sort-imports */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PortsInUseErrorData,
  ProjectCommand,
  RunStatus,
} from '@shared/run-command-types';

import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { RootOverlay } from '@/common/context/overlay';
import { api } from '@/lib/api';
import { useOverlaysStore } from '@/stores/overlays';
import { useTaskMessagesStore } from '@/stores/task-messages';
import { useToastStore } from '@/stores/toasts';

import { RunningCommandsOverlay } from '.';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient;
let storedCommands: ProjectCommand[] = [];

const favorite: ProjectCommand = {
  id: 'command-1',
  projectId: 'project-1',
  name: 'Web server',
  command: 'pnpm dev',
  ports: [3000],
  portConflictStrategy: 'prompt',
  portOverrideProvider: 'env',
  portOverrideEnvVar: null,
  portOverrideArgs: null,
  envVars: [],
  confirmBeforeRun: false,
  confirmMessage: null,
  isFavorite: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const portsInUse: PortsInUseErrorData = {
  type: 'PortsInUseError',
  message: 'Ports in use: 3000',
  portsInUse: [
    {
      port: 3000,
      commandId: 'command-1',
      command: 'pnpm dev',
      processInfo: 'node (pid 42)',
    },
  ],
};

const startedStatus: RunStatus = {
  isRunning: true,
  commands: [
    {
      id: 'command-1',
      name: 'Web server',
      command: 'pnpm dev',
      status: 'running',
    },
  ],
};

async function flushUpdates() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
        RootOverlay,
        null,
        createElement(
          RootKeyboardBindings,
          null,
          createElement(RunningCommandsOverlay, { onClose: vi.fn() }),
        ),
        ),
      ),
    );
  });
}

function button(name: string) {
  const result = Array.from(document.querySelectorAll('button')).find(
    (candidate) =>
      candidate.getAttribute('aria-label') === name ||
      candidate.textContent?.trim().startsWith(name),
  );
  if (!result) throw new Error(`Button not found: ${name}`);
  return result;
}

function click(element: Element) {
  flushSync(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const otherCommand: ProjectCommand = {
  ...favorite,
  id: 'command-2',
  name: 'API server',
  command: 'pnpm api',
  ports: [4000],
  isFavorite: false,
};

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Fake persistence so the store-of-record actually changes on update and the
  // React Query invalidation is exercised rather than mocked away.
  storedCommands = [favorite, otherCommand];
  vi.spyOn(api.projectCommands, 'findFavorites').mockImplementation(async () =>
    storedCommands.filter((command) => command.isFavorite),
  );
  vi.spyOn(api.projectCommands, 'findAll').mockImplementation(
    async () => storedCommands,
  );
  vi.spyOn(api.projectCommands, 'update').mockImplementation(
    async (id, data) => {
      const updated = { ...storedCommands.find((c) => c.id === id)!, ...data };
      storedCommands = storedCommands.map((c) => (c.id === id ? updated : c));
      return updated;
    },
  );
  vi.spyOn(api.runCommands, 'stopCommand').mockResolvedValue(undefined);
  vi.spyOn(api.runCommands, 'resetLogs').mockResolvedValue(1);
  vi.spyOn(api.runCommands, 'killPortsForCommand').mockResolvedValue(undefined);
  useOverlaysStore.setState({
    activeOverlay: null,
    runningCommandTarget: null,
  });
  useToastStore.setState({ toasts: [] });
  useTaskMessagesStore.setState({ runCommandRunning: {} });
});

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  queryClient.clear();
  vi.restoreAllMocks();
});

describe('running commands overlay favorites', () => {
  it('kills the busy ports and restarts the favorite after confirmation', async () => {
    const startFavorite = vi
      .spyOn(api.runCommands, 'startFavorite')
      .mockResolvedValueOnce(portsInUse)
      .mockResolvedValueOnce(startedStatus);

    render();
    await flushUpdates();

    click(button('Web server'));
    await flushUpdates();

    expect(document.body.textContent).toContain('Ports in Use');
    expect(document.body.textContent).toContain('node (pid 42)');

    click(button('Kill & Start'));
    await flushUpdates();

    expect(api.runCommands.killPortsForCommand).toHaveBeenCalledWith(
      'project-1',
      'command-1',
    );
    expect(startFavorite).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain('Ports in Use');
  });

  it('clears the previous logs and starts against the project root', async () => {
    const startFavorite = vi
      .spyOn(api.runCommands, 'startFavorite')
      .mockResolvedValue(startedStatus);

    render();
    await flushUpdates();

    click(button('Web server'));
    await flushUpdates();

    expect(api.runCommands.resetLogs).toHaveBeenCalledWith({
      taskId: 'project-root:project-1',
      runCommandId: 'command-1',
      generation: expect.any(Number),
    });
    expect(startFavorite).toHaveBeenCalledWith({
      projectId: 'project-1',
      runCommandId: 'command-1',
    });
  });

  it('asks for confirmation before running a guarded command', async () => {
    storedCommands = [
      {
        ...favorite,
        confirmBeforeRun: true,
        confirmMessage: 'This resets the database.',
      },
    ];
    const startFavorite = vi
      .spyOn(api.runCommands, 'startFavorite')
      .mockResolvedValue(startedStatus);

    render();
    await flushUpdates();

    click(button('Web server'));
    await flushUpdates();

    expect(document.body.textContent).toContain('This resets the database.');
    expect(startFavorite).not.toHaveBeenCalled();

    click(button('Run'));
    await flushUpdates();

    expect(startFavorite).toHaveBeenCalledTimes(1);
  });

  it('does not start a guarded command when confirmation is cancelled', async () => {
    storedCommands = [{ ...favorite, confirmBeforeRun: true }];
    const startFavorite = vi
      .spyOn(api.runCommands, 'startFavorite')
      .mockResolvedValue(startedStatus);

    render();
    await flushUpdates();

    click(button('Web server'));
    await flushUpdates();
    click(button('Cancel'));
    await flushUpdates();

    expect(startFavorite).not.toHaveBeenCalled();
  });

  it('favorites an existing project command from the picker', async () => {
    render();
    await flushUpdates();

    click(button('Add a favorite command'));
    await flushUpdates();

    // Both project commands are listed, the already-favorited one included.
    expect(document.body.textContent).toContain('API server');

    click(button('API server'));
    await flushUpdates();

    expect(api.projectCommands.update).toHaveBeenCalledWith('command-2', {
      isFavorite: true,
    });
    // The new favorite shows up in the favorites list right away.
    expect(
      document.querySelector(
        '[aria-label="Remove API server from favorites"]',
      ),
    ).not.toBeNull();
  });

  it('unfavorites from the favorites list', async () => {
    render();
    await flushUpdates();

    click(button('Remove Web server from favorites'));
    await flushUpdates();

    expect(api.projectCommands.update).toHaveBeenCalledWith('command-1', {
      isFavorite: false,
    });
    expect(document.body.textContent).toContain('No favorites yet');
  });

  it('filters the picker list', async () => {
    render();
    await flushUpdates();

    click(button('Add a favorite command'));
    await flushUpdates();

    const input = document.querySelector(
      'input[aria-label="Filter project commands"]',
    ) as HTMLInputElement;
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, 'api');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flushUpdates();

    const picker = input.closest('div');
    expect(picker?.textContent).toContain('API server');
    expect(picker?.textContent).not.toContain('Web server');
  });

  it('groups picker commands per project and expands on demand', async () => {
    const foreignCommand: ProjectCommand = {
      ...otherCommand,
      id: 'command-3',
      projectId: 'project-2',
      name: 'Docs site',
      command: 'pnpm docs',
    };
    vi.mocked(api.projectCommands.findAll).mockResolvedValue([
      favorite,
      otherCommand,
      foreignCommand,
    ]);

    render();
    await flushUpdates();

    click(button('Add a favorite command'));
    await flushUpdates();

    // Two projects, both collapsed: their commands are not rendered yet.
    const projectToggles = Array.from(
      document.querySelectorAll('button[aria-expanded]'),
    ).filter((candidate) =>
      candidate.getAttribute('aria-label')?.endsWith('commands'),
    );
    expect(projectToggles).toHaveLength(2);
    expect(
      projectToggles.every(
        (toggle) => toggle.getAttribute('aria-expanded') === 'false',
      ),
    ).toBe(true);
    expect(document.body.textContent).not.toContain('Docs site');

    click(projectToggles[0]);
    await flushUpdates();

    expect(projectToggles[0].getAttribute('aria-expanded')).toBe('true');
    // The other project stays collapsed.
    expect(projectToggles[1].getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the conflict dialog open when the user cancels', async () => {
    vi.spyOn(api.runCommands, 'startFavorite').mockResolvedValue(portsInUse);

    render();
    await flushUpdates();

    click(button('Web server'));
    await flushUpdates();
    expect(document.body.textContent).toContain('Ports in Use');

    click(button('Cancel'));
    await flushUpdates();

    expect(document.body.textContent).not.toContain('Ports in Use');
    expect(api.runCommands.killPortsForCommand).not.toHaveBeenCalled();
  });
});
