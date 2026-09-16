// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import type { MobilePreviewDevice } from '@shared/mobile-simulator-types';
import type { MobilePreviewProjectConfig } from '@shared/types';

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
  startAdHocCommand: vi.fn(),
  stopCommand: vi.fn(),
}));

vi.mock('@/hooks/use-run-commands', () => ({
  useRunCommands: () => ({
    statusByCommandId: mocks.statusByCommandId,
    isCommandStarting: () => false,
    isCommandStopping: () => false,
    startAdHocCommand: mocks.startAdHocCommand,
    stopCommand: mocks.stopCommand,
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

import { MobileDevPane } from '.';

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

describe('MobileDevPane build button', () => {
  it('starts the build command targeted at the selected device', async () => {
    selectDevice(IPHONE);
    await renderPane();

    await click(buttonByText('Build'));

    expect(mocks.startAdHocCommand).toHaveBeenCalledWith({
      runCommandId: IOS_BUILD_COMMAND_ID,
      name: 'iOS build',
      command: 'npx expo run:ios --device IOS-1',
      ports: [],
    });
  });

  it('keeps clearing the watched build log after the device selection changes', async () => {
    selectDevice(IPHONE);
    await renderPane();

    await click(buttonByText('Build'));

    // The build is now running; the user switches device while it continues.
    mocks.statusByCommandId = { [IOS_BUILD_COMMAND_ID]: { status: 'running' } };
    await act(async () => {
      selectDevice(PIXEL);
    });

    // Clear must still target the stream the user is watching, not the Pixel's
    // never-started build and not Metro.
    await click(
      container.querySelector('button[aria-label^="Clear logs"]') as Element,
    );

    expect(api.runCommands.resetLogs).toHaveBeenCalledWith({
      taskId: 'task-1',
      runCommandId: IOS_BUILD_COMMAND_ID,
      generation: expect.any(Number),
    });
  });

  it('blocks the build when no device is selected', async () => {
    // No selectDevice() call: a build always targets exactly one device.
    await renderPane();

    const build = buttonByText('Build');
    expect(build.hasAttribute('disabled')).toBe(true);
    await click(build);
    expect(mocks.startAdHocCommand).not.toHaveBeenCalled();
  });

  it('does not start a build when no command is configured', async () => {
    selectDevice(IPHONE);
    await act(async () => {
      root.render(
        <RootOverlay>
          <RootKeyboardBindings>
            <MobileDevPane
              taskId="task-1"
              projectId="project-1"
              projectPath="/repo"
              mobilePreviewConfig={
                {
                  mode: 'auto',
                  selectedAppPath: '.',
                  detectedApps: [],
                  detectionUpdatedAt: null,
                } as unknown as MobilePreviewProjectConfig
              }
              onClose={vi.fn()}
            />
          </RootKeyboardBindings>
        </RootOverlay>,
      );
    });

    const build = buttonByText('Build');
    expect(build.hasAttribute('disabled')).toBe(true);
    await click(build);
    expect(mocks.startAdHocCommand).not.toHaveBeenCalled();
  });
});
