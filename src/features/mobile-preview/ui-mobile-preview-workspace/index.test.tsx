// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createMobilePreviewRuntimeKey } from '@/lib/mobile-preview-runtime';
import { createRoot } from 'react-dom/client';
import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { useMobilePreviewWorkspaceStore } from '@/stores/mobile-preview-workspace';
import { useTaskMessagesStore } from '@/stores/task-messages';

type PaneProps = {
  appPathOverride?: string;
  appSelectionError?: string | null;
  autoLaunchRunningRuntime?: boolean;
  isSelectingAppPath?: boolean;
  onSelectAppPath?: (appPath: string | null) => void;
};

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  paneProps: null as PaneProps | null,
  project: {
    id: 'project-1',
    name: 'Project',
    path: '/project',
    mobilePreviewConfig: {
      mode: 'enabled' as const,
      selectedAppPath: 'apps/mobile',
      detectedApps: [
        {
          path: 'apps/mobile',
          stacks: ['expo'] as const,
          confidence: 'high' as const,
          reasons: [],
        },
        {
          path: 'apps/other',
          stacks: ['expo'] as const,
          confidence: 'high' as const,
          reasons: [],
        },
      ],
      detectionUpdatedAt: null,
      metroPort: 19001,
    },
  },
  task: {
    id: 'task-1',
    projectId: 'project-1',
    name: 'Task',
    prompt: 'Task prompt',
    branchName: 'feature/mobile',
    sourceBranch: 'main',
    worktreePath: '/worktree',
  },
}));

vi.mock('@/hooks/use-projects', () => ({
  useProjects: () => ({ data: [mocks.project], isLoading: false }),
  useUpdateProject: () => ({ mutateAsync: mocks.mutateAsync }),
}));
vi.mock('@/hooks/use-tasks', () => ({
  useTasks: () => ({ data: [mocks.task], isLoading: false }),
}));
vi.mock('@/features/task/ui-task-panel/mobile-preview-pane', () => ({
  MobilePreviewPane: (props: PaneProps) => {
    mocks.paneProps = props;
    return (
      <div>
        <button
          type="button"
          onClick={() => props.onSelectAppPath?.('apps/other')}
        >
          Change app
        </button>
        {props.appSelectionError ? (
          <div role="alert">{props.appSelectionError}</div>
        ) : null}
      </div>
    );
  },
}));

import { MobilePreviewWorkspace } from '.';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe('MobilePreviewWorkspace', () => {
  beforeEach(() => {
    mocks.mutateAsync.mockReset();
    mocks.paneProps = null;
    useTaskMessagesStore.setState({
      areRunCommandStatusesHydrated: true,
      runCommandRunning: {},
    });
    useMobilePreviewWorkspaceStore.setState({
      isOpen: true,
      selectedRuntimeKey: createMobilePreviewRuntimeKey({
        taskId: 'task-1',
        appPath: 'apps/mobile',
      }),
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('catches app-selection failure and blocks a second request while pending', async () => {
    let rejectMutation!: (reason: unknown) => void;
    mocks.mutateAsync.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectMutation = reject;
        }),
    );
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <RootKeyboardBindings>
          <MobilePreviewWorkspace taskId="task-1" onClose={() => {}} />
        </RootKeyboardBindings>,
      );
    });
    await act(async () => {
      mocks.paneProps?.onSelectAppPath?.('apps/other');
      mocks.paneProps?.onSelectAppPath?.('apps/mobile');
    });
    expect(mocks.mutateAsync).toHaveBeenCalledOnce();

    await act(async () => {
      rejectMutation(new Error('Project update failed'));
      await Promise.resolve();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Project update failed',
    );
    expect(
      useMobilePreviewWorkspaceStore.getState().selectedRuntimeKey,
    ).toBe(
      createMobilePreviewRuntimeKey({
        taskId: 'task-1',
        appPath: 'apps/mobile',
      }),
    );

    await act(async () => root.unmount());
  });

  it('moves selected runtime to saved app after successful stopped mutation', async () => {
    mocks.mutateAsync.mockResolvedValue(undefined);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <RootKeyboardBindings>
          <MobilePreviewWorkspace taskId="task-1" onClose={() => {}} />
        </RootKeyboardBindings>,
      );
    });
    await act(async () => {
      mocks.paneProps?.onSelectAppPath?.('apps/other');
      await Promise.resolve();
    });

    const nextRuntimeKey = createMobilePreviewRuntimeKey({
      taskId: 'task-1',
      appPath: 'apps/other',
    });
    expect(mocks.mutateAsync).toHaveBeenCalledWith({
      id: 'project-1',
      data: {
        mobilePreviewConfig: expect.objectContaining({
          selectedAppPath: 'apps/other',
        }),
      },
    });
    expect(
      useMobilePreviewWorkspaceStore.getState().selectedRuntimeKey,
    ).toBe(nextRuntimeKey);
    expect(mocks.paneProps?.appPathOverride).toBe('apps/other');

    await act(async () => root.unmount());
  });

  it('shows an empty state for a task without a mobile runtime', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <RootKeyboardBindings>
          <MobilePreviewWorkspace
            taskId="task-without-mobile"
            onClose={() => {}}
          />
        </RootKeyboardBindings>,
      );
    });

    expect(mocks.paneProps).toBeNull();
    expect(container.textContent).toContain('Enable mobile preview');

    await act(async () => root.unmount());
  });

  it('never exposes project app mutation for a running runtime override', async () => {
    useTaskMessagesStore.setState({
      runCommandRunning: {
        'task-1': {
          isRunning: true,
          commands: [
            {
              id: 'mobile-dev-server:apps%2Fmobile',
              name: 'Metro',
              command: 'pnpm start',
              ports: [19001],
              status: 'running',
            },
          ],
        },
      },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <RootKeyboardBindings>
          <MobilePreviewWorkspace taskId="task-1" onClose={() => {}} />
        </RootKeyboardBindings>,
      );
    });

    expect(mocks.paneProps?.onSelectAppPath).toBeUndefined();
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
    expect(
      useMobilePreviewWorkspaceStore.getState().selectedRuntimeKey,
    ).toBe(
      createMobilePreviewRuntimeKey({
        taskId: 'task-1',
        appPath: 'apps/mobile',
      }),
    );

    await act(async () => root.unmount());
  });

  it('keeps selected runtime mounted without auto-start after Metro exits', async () => {
    useTaskMessagesStore.setState({
      runCommandRunning: {
        'task-1': {
          isRunning: true,
          commands: [
            {
              id: 'mobile-dev-server:apps%2Fmobile',
              name: 'Metro',
              command: 'pnpm start',
              ports: [19001],
              status: 'running',
              pid: 123,
            },
          ],
        },
      },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <RootKeyboardBindings>
          <MobilePreviewWorkspace taskId="task-1" onClose={() => {}} />
        </RootKeyboardBindings>,
      );
    });
    expect(mocks.paneProps?.autoLaunchRunningRuntime).toBe(true);

    await act(async () => {
      useTaskMessagesStore.getState().setRunCommandRunning('task-1', false);
      await Promise.resolve();
    });

    expect(mocks.paneProps).not.toBeNull();
    expect(mocks.paneProps?.autoLaunchRunningRuntime).toBe(false);

    await act(async () => root.unmount());
  });
});
