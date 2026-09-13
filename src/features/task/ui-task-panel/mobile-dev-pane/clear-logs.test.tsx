// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { api } from '@/lib/api';
import { createMobileDevServerCommandId } from '@shared/mobile-preview-runtime';
import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { RootOverlay } from '@/common/context/overlay';
import { useMobileDevPaneStore } from '@/stores/mobile-dev-pane';
import { useTaskMessagesStore } from '@/stores/task-messages';
import { useToastStore } from '@/stores/toasts';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  refetchDevices: vi.fn(),
}));

// The real hook subscribes to run-command status over IPC on mount; none of
// that is what this file is about.
vi.mock('@/hooks/use-run-commands', () => ({
  useRunCommands: () => ({
    statusByCommandId: {},
    isCommandStarting: () => false,
    isCommandStopping: () => false,
    startAdHocCommand: vi.fn(),
    stopCommand: vi.fn(),
  }),
}));

// Device listing is a React Query hook over IPC; stubbing it keeps the pane
// free of a QueryClientProvider.
vi.mock('@/hooks/use-mobile-preview', () => ({
  useMobilePreviewDevices: () => ({
    data: [],
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: mocks.refetchDevices,
  }),
}));

import { MobileDevPane } from '.';

// With no detected app the pane falls back to the project root.
const METRO_COMMAND_ID = createMobileDevServerCommandId('.');

let container: HTMLDivElement;
let root: Root;

async function renderPane() {
  await act(async () => {
    root.render(
      <RootOverlay>
        <RootKeyboardBindings>
          <MobileDevPane
            taskId="task-1"
            projectId="project-1"
            projectPath="/repo"
            mobilePreviewConfig={null}
            onClose={vi.fn()}
          />
        </RootKeyboardBindings>
      </RootOverlay>,
    );
  });
}

function clearLogsButton() {
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label^="Clear logs"]',
  );
  if (!button) throw new Error('Clear logs button not found');
  return button;
}

function pane() {
  const element = container.querySelector<HTMLElement>(
    '[data-mobile-dev-pane]',
  );
  if (!element) throw new Error('Pane not found');
  return element;
}

async function pressKey(
  target: EventTarget,
  init: { key: string; metaKey?: boolean; shiftKey?: boolean },
) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  mocks.refetchDevices.mockReset().mockResolvedValue(undefined);
  vi.spyOn(api.runCommands, 'resetLogs').mockResolvedValue(1);

  useToastStore.setState({ toasts: [] });
  useTaskMessagesStore.setState({
    runCommandLogs: {},
    runCommandLogGenerations: {},
  });
  useMobileDevPaneStore.setState({
    deviceByTaskId: {},
    logsExpandedByTaskId: {},
    favoriteDevices: {},
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

describe('MobileDevPane clear logs', () => {
  it('clears the Metro log from the trash button', async () => {
    await renderPane();

    await act(async () => {
      clearLogsButton().dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    // The store generation is bumped first so late chunks from the old run are
    // dropped instead of repopulating the box after the clear.
    const generation =
      useTaskMessagesStore.getState().runCommandLogGenerations['task-1']?.[
        METRO_COMMAND_ID
      ];
    expect(generation).toBeGreaterThan(0);
    expect(api.runCommands.resetLogs).toHaveBeenCalledWith({
      taskId: 'task-1',
      runCommandId: METRO_COMMAND_ID,
      generation,
    });
  });

  it('clears on Cmd+K when the event originates inside the pane', async () => {
    await renderPane();

    await pressKey(pane(), { key: 'k', metaKey: true });

    expect(api.runCommands.resetLogs).toHaveBeenCalledWith({
      taskId: 'task-1',
      runCommandId: METRO_COMMAND_ID,
      generation: expect.any(Number),
    });
  });

  it('ignores Cmd+K raised outside the pane', async () => {
    await renderPane();

    // Cmd+K is also owned by the command logs pane and the running commands
    // overlay; this pane must not steal it when focus is elsewhere.
    await pressKey(document.body, { key: 'k', metaKey: true });

    expect(api.runCommands.resetLogs).not.toHaveBeenCalled();
  });

  it('ignores a bare K and Cmd+Shift+K inside the pane', async () => {
    await renderPane();

    await pressKey(pane(), { key: 'k' });
    await pressKey(pane(), { key: 'k', metaKey: true, shiftKey: true });

    expect(api.runCommands.resetLogs).not.toHaveBeenCalled();
  });

  it('focuses the pane on a non-interactive mousedown so Cmd+K is reachable', async () => {
    await renderPane();

    await act(async () => {
      pane().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    expect(document.activeElement).toBe(pane());
  });
});
