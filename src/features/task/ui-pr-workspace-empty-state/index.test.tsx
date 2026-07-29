// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import {
  PrWorkspaceEmptyState,
  shouldShowPrWorkspaceEmptyState,
} from '.';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe('PrWorkspaceEmptyState', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
  });

  async function renderState({
    hasConfiguredCommands = true,
    state = 'ready',
    isPulling = false,
  }: {
    hasConfiguredCommands?: boolean;
    state?: 'loading' | 'error' | 'ready';
    isPulling?: boolean;
  } = {}) {
    const onPull = vi.fn();
    const onAddStep = vi.fn();
    const onDelete = vi.fn();
    const onOpenLogs = vi.fn();
    const onOpenPullRequest = vi.fn();
    const onOpenProjectSettings = vi.fn();
    const retryCommands = vi.fn();

    await act(async () => {
      root.render(
        <PrWorkspaceEmptyState
          pullRequestId="42"
          projectName="Jean-Claude"
          commandAvailability={{
            state,
            hasConfiguredItems: hasConfiguredCommands,
            retry: retryCommands,
          }}
          onAddStep={onAddStep}
          onDelete={onDelete}
          onOpenLogs={onOpenLogs}
          onOpenPullRequest={onOpenPullRequest}
          onPull={onPull}
          isPulling={isPulling}
          onOpenProjectSettings={onOpenProjectSettings}
          commandControls={<button type="button">Run workspace command</button>}
        />,
      );
    });

    return {
      onAddStep,
      onDelete,
      onOpenLogs,
      onOpenPullRequest,
      onOpenProjectSettings,
      onPull,
      retryCommands,
    };
  }

  function findButton(label: string) {
    return Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(label),
    );
  }

  it('only selects loaded, zero-step PR review tasks', () => {
    expect(
      shouldShowPrWorkspaceEmptyState({ taskType: 'pr-review', steps: [] }),
    ).toBe(true);
    expect(
      shouldShowPrWorkspaceEmptyState({
        taskType: 'pr-review',
        steps: undefined,
      }),
    ).toBe(false);
    expect(
      shouldShowPrWorkspaceEmptyState({ taskType: 'pr-review', steps: [{}] }),
    ).toBe(false);
    expect(
      shouldShowPrWorkspaceEmptyState({ taskType: 'agent', steps: [] }),
    ).toBe(false);
  });

  it('renders workspace identity and actions without conversation placeholders', async () => {
    const callbacks = await renderState();

    expect(container.textContent).toContain('PR Workspace');
    expect(container.textContent).toContain('#42');
    expect(container.textContent).toContain('Jean-Claude');
    expect(container.textContent).toContain('Ready for your first step');
    expect(container.textContent).toContain(
      'Add Step creates an agent session in this pull request workspace.',
    );
    expect(container.textContent).toContain('Run workspace command');
    expect(container.textContent).not.toContain('Prompt');
    expect(container.textContent).not.toContain('Reload messages');
    expect(container.textContent).not.toContain('No messages');
    expect(container.textContent).not.toContain('Continue');

    const buttons = Array.from(container.querySelectorAll('button'));
    await act(async () => buttons.find((button) => button.textContent?.includes('Add Step'))?.click());
    await act(async () => buttons.find((button) => button.textContent?.includes('View Pull Request'))?.click());
    await act(async () => buttons.find((button) => button.textContent?.includes('Logs'))?.click());
    await act(async () => buttons.find((button) => button.textContent?.includes('Delete PR Workspace'))?.click());

    expect(callbacks.onAddStep).toHaveBeenCalledOnce();
    expect(callbacks.onDelete).toHaveBeenCalledOnce();
    expect(callbacks.onOpenLogs).toHaveBeenCalledOnce();
    expect(callbacks.onOpenPullRequest).toHaveBeenCalledOnce();
  });

  it('pulls the latest changes and disables the button while pulling', async () => {
    const callbacks = await renderState();

    await act(async () => findButton('Pull')?.click());
    expect(callbacks.onPull).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderState({ isPulling: true });

    const pullingButton = findButton('Pulling...');
    expect(pullingButton).toBeTruthy();
    expect(pullingButton?.disabled).toBe(true);
  });

  it('shows project command setup guidance when no commands are configured', async () => {
    const callbacks = await renderState({ hasConfiguredCommands: false });

    expect(container.textContent).toContain(
      'No project commands configured. Add commands in Project Settings to run this workspace.',
    );

    const settingsButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Project Settings'),
    );
    await act(async () => settingsButton?.click());
    expect(callbacks.onOpenProjectSettings).toHaveBeenCalledOnce();
  });

  it('shows compact loading without confirmed-empty guidance', async () => {
    await renderState({ hasConfiguredCommands: false, state: 'loading' });

    expect(container.textContent).toContain('Loading project commands...');
    expect(container.textContent).not.toContain('No project commands configured');
  });

  it('shows command query errors with retry instead of confirmed-empty guidance', async () => {
    const callbacks = await renderState({
      hasConfiguredCommands: false,
      state: 'error',
    });

    expect(container.textContent).toContain('Could not load project commands.');
    expect(container.textContent).not.toContain('No project commands configured');
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Retry'))
        ?.click(),
    );
    expect(callbacks.retryCommands).toHaveBeenCalledOnce();
  });
});
