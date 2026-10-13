// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import type { MobilePreviewDevice } from '@shared/mobile-simulator-types';
import type { MobilePreviewProjectConfig } from '@shared/types';
import type { ProjectCommand } from '@shared/run-command-types';

import { api } from '@/lib/api';
import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { RootOverlay } from '@/common/context/overlay';
import { useMobileDevPaneStore } from '@/stores/mobile-dev-pane';
import { useTaskMessagesStore } from '@/stores/task-messages';
import { useToastStore } from '@/stores/toasts';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const IPHONE: MobilePreviewDevice = {
  id: 'IOS-1',
  name: 'iPhone 15',
  platform: 'ios',
  state: 'booted',
};
const PIXEL: MobilePreviewDevice = {
  id: 'AND-1',
  name: 'Pixel 7',
  platform: 'android',
  state: 'booted',
};

const IOS_BUILD_COMMAND_ID = 'mobile-build:.:ios:IOS-1';

const mocks = vi.hoisted(() => ({
  devices: [] as unknown[],
  statusByCommandId: {} as Record<string, { status: string }>,
  statusCommands: [] as { id: string; status: string; ports?: number[] }[],
  commands: [] as unknown[],
  startAdHocCommand: vi.fn(),
  stopCommand: vi.fn(),
}));

vi.mock('@/hooks/use-run-commands', () => ({
  useRunCommands: () => ({
    status: { isRunning: false, commands: mocks.statusCommands },
    statusByCommandId: mocks.statusByCommandId,
    isCommandStarting: () => false,
    isCommandStopping: () => false,
    isStartingAnyCommand: false,
    startCommand: vi.fn(),
    startAdHocCommand: mocks.startAdHocCommand,
    stopCommand: mocks.stopCommand,
    portsInUseError: null,
    confirmKillPorts: vi.fn(),
    dismissPortsError: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-project-command-availability', () => ({
  useProjectCommandAvailability: () => ({
    commands: mocks.commands,
    allCommands: mocks.commands,
    groups: [],
    items: [],
    state: 'ready' as const,
    hasConfiguredItems: mocks.commands.length > 0,
    retry: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-mobile-preview', () => ({
  useMobilePreviewDevices: (platform: 'ios' | 'android') => ({
    data: mocks.devices.filter(
      (device) => (device as MobilePreviewDevice).platform === platform,
    ),
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Renders the lines so "the finished build's output is still readable" is an
// assertion rather than a guess.
vi.mock('@/features/common/interactive-log', () => ({
  InteractiveLog: ({
    log,
  }: {
    log: { chunks: { lines: { line: string }[] }[] } | null;
  }) => (
    <div data-command-log-content>
      {(log?.chunks ?? [])
        .flatMap((chunk) => chunk.lines)
        .map((entry, index) => (
          <div key={index}>{entry.line}</div>
        ))}
    </div>
  ),
}));

import { MobileDevPane } from '.';
import { createMobileDevServerCommandId } from '@/lib/mobile-preview-runtime';

// `selectedAppPath: '.'`, so Metro's ad-hoc command id is the project root one.
const METRO_COMMAND_ID = createMobileDevServerCommandId('.');

const CONFIG = {
  mode: 'auto',
  selectedAppPath: '.',
  detectedApps: [],
  detectionUpdatedAt: null,
  iosBuildCommand: 'npx expo run:ios',
  androidBuildCommand: 'npx expo run:android',
} as unknown as MobilePreviewProjectConfig;

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
            mobilePreviewConfig={CONFIG}
            onClose={vi.fn()}
          />
        </RootKeyboardBindings>
      </RootOverlay>,
    );
  });
}

/** Tab rail buttons are the only `aria-pressed` buttons in the logs section. */
function tabs() {
  return [
    ...container.querySelectorAll(
      '[data-command-logs-section] button[aria-pressed]',
    ),
  ];
}

function tabByText(text: string) {
  return tabs().find((tab) => tab.textContent?.includes(text));
}

function activeTabText() {
  return tabs()
    .find((tab) => tab.getAttribute('aria-pressed') === 'true')
    ?.textContent?.trim();
}

function buttonByText(text: string) {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Button "${text}" not found`);
  return button;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function logLines(): string[] {
  const log = container.querySelector('[data-command-log-content]');
  return [...(log?.children ?? [])].map((child) => child.textContent ?? '');
}

function clearLogsButton() {
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label^="Clear logs"]',
  );
  if (!button) throw new Error('Clear logs button not found');
  return button;
}

/** Puts real lines in the store, the way a running command's output would. */
function seedLogs(commandId: string, lines: string[]) {
  useTaskMessagesStore.setState({
    runCommandLogs: {
      'task-1': {
        [commandId]: {
          chunks: [
            {
              id: 'chunk-1',
              lines: lines.map((line, index) => ({
                stream: 'stdout' as const,
                line,
                timestamp: index,
              })),
              lineCount: lines.length,
            },
          ],
          pendingLines: { stdout: null, stderr: null },
          trailingText: { stdout: '', stderr: '' },
          totalLineCount: lines.length,
          updatedAt: 1,
          version: 1,
        },
      },
    },
  });
}

function selectDevice(device: MobilePreviewDevice) {
  useMobileDevPaneStore.setState({
    deviceByTaskId: {
      'task-1': {
        platform: device.platform,
        deviceId: device.id,
        deviceName: device.name,
      },
    },
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  mocks.devices = [IPHONE, PIXEL];
  mocks.statusByCommandId = {};
  mocks.statusCommands = [];
  mocks.commands = [];
  mocks.startAdHocCommand.mockReset().mockResolvedValue(undefined);
  mocks.stopCommand.mockReset().mockResolvedValue(undefined);
  vi.spyOn(api.runCommands, 'resetLogs').mockResolvedValue(1);

  useToastStore.setState({ toasts: [] });
  useTaskMessagesStore.setState({
    runCommandLogs: {},
    runCommandLogGenerations: {},
  });
  useMobileDevPaneStore.setState({
    deviceByTaskId: {},
    selectedLogTabByTaskId: {},
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

describe('MobileDevPane log tabs', () => {
  it('shows no tabs at all on a fresh task, and says so', async () => {
    await renderPane();

    // Nothing has ever run: no command is running and no log line exists, so
    // there is nothing to put on the rail.
    expect(tabs()).toEqual([]);
    expect(container.textContent).toContain(
      'No logs yet. Start Metro or run a build',
    );
  });

  it('shows Metro once it is running, and selects it by default', async () => {
    // A tab is earned by running or by having output -- not by existing. With
    // zero output yet, "running" is what puts Metro on the rail.
    mocks.statusCommands = [{ id: METRO_COMMAND_ID, status: 'running' }];
    await renderPane();

    expect(tabByText('Metro')).toBeTruthy();
    expect(activeTabText()).toContain('Metro');
  });

  it('selects the build tab when a build starts', async () => {
    selectDevice(IPHONE);
    await renderPane();

    // The runner reports the build alive as the click starts it.
    mocks.statusCommands = [{ id: IOS_BUILD_COMMAND_ID, status: 'running' }];
    await click(buttonByText('Build'));

    expect(activeTabText()).toContain('iOS build');
    expect(
      useMobileDevPaneStore.getState().selectedLogTabByTaskId['task-1'],
    ).toBe(IOS_BUILD_COMMAND_ID);
  });

  it('keeps a finished build readable, and drops its tab once cleared', async () => {
    selectDevice(IPHONE);
    mocks.statusCommands = [{ id: IOS_BUILD_COMMAND_ID, status: 'running' }];
    await renderPane();

    await click(buttonByText('Build'));

    // The build produces output and then exits. The tab must survive the exit:
    // reading what happened is the whole point of keeping it.
    mocks.statusByCommandId = { [IOS_BUILD_COMMAND_ID]: { status: 'stopped' } };
    mocks.statusCommands = [{ id: IOS_BUILD_COMMAND_ID, status: 'stopped' }];
    await act(async () => {
      seedLogs(IOS_BUILD_COMMAND_ID, ['BUILD SUCCEEDED']);
    });
    // Run status reaches the logs section as a prop, so the pane itself has to
    // re-render for the exit to be seen.
    await renderPane();

    expect(tabByText('iOS build')).toBeTruthy();
    expect(activeTabText()).toContain('iOS build');
    expect(logLines()).toEqual(['BUILD SUCCEEDED']);

    // Clearing a stopped command's logs is what retires its tab: nothing is
    // running and there is no longer anything to read.
    await click(clearLogsButton());

    expect(tabByText('iOS build')).toBeUndefined();
    expect(tabs()).toEqual([]);
    expect(container.textContent).toContain('No logs yet.');
  });

  it('falls back to another tab when the selected one is cleared away', async () => {
    selectDevice(IPHONE);
    mocks.statusCommands = [
      { id: METRO_COMMAND_ID, status: 'running' },
      { id: IOS_BUILD_COMMAND_ID, status: 'running' },
    ];
    await renderPane();

    await click(buttonByText('Build'));
    expect(activeTabText()).toContain('iOS build');

    // The build exits, the user clears it. Metro is still running, so the
    // selection lands there instead of blanking the pane.
    mocks.statusCommands = [{ id: METRO_COMMAND_ID, status: 'running' }];
    await act(async () => {
      seedLogs(IOS_BUILD_COMMAND_ID, ['BUILD FAILED']);
    });
    await renderPane();
    await click(clearLogsButton());

    expect(tabByText('iOS build')).toBeUndefined();
    expect(activeTabText()).toContain('Metro');
  });

  it('keeps the build tab after the device selection moves on', async () => {
    selectDevice(IPHONE);
    mocks.statusCommands = [{ id: IOS_BUILD_COMMAND_ID, status: 'running' }];
    await renderPane();

    await click(buttonByText('Build'));

    mocks.statusByCommandId = { [IOS_BUILD_COMMAND_ID]: { status: 'running' } };
    await act(async () => {
      selectDevice(PIXEL);
    });

    // The iPhone's build is still running, so it keeps its tab; the Pixel's has
    // never run, so it has none to show yet.
    expect(tabByText('Android build')).toBeUndefined();
    expect(tabByText('iOS build')).toBeTruthy();
    expect(activeTabText()).toContain('iOS build');
  });

  it('lists a running project run command alongside the mobile tabs', async () => {
    mocks.commands = [
      {
        id: 'cmd-api',
        projectId: 'project-1',
        name: 'API server',
        command: 'pnpm dev',
        ports: [],
        portConflictStrategy: 'prompt',
        portOverrideProvider: 'env',
        portOverrideEnvVar: null,
        portOverrideArgs: null,
        envVars: [],
        sortOrder: 0,
        confirmBeforeRun: false,
        confirmMessage: null,
        isFavorite: false,
        isHidden: false,
        createdAt: '',
      } satisfies ProjectCommand,
    ];
    mocks.statusCommands = [
      { id: METRO_COMMAND_ID, status: 'running' },
      { id: 'cmd-api', status: 'running', ports: [3000] },
    ];

    await renderPane();

    expect(tabByText('API server')).toBeTruthy();
    // Metro still leads the rail.
    expect(tabs()[0]?.textContent).toContain('Metro');
  });
});
