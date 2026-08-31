// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import type { BranchInfo, TaskStep } from '@shared/types';

import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { RootOverlay } from '@/common/context/overlay';

import { TaskSettingsPane } from './task-settings-pane';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/hooks/use-skills', () => ({
  useSkills: () => ({ data: [], isLoading: false, error: null }),
}));

const setSourceBranchMutate = vi.fn();
const setBranchNameMutate = vi.fn();

const branchFixtures = [
  { name: 'main', lastCommitDate: '2026-01-01T00:00:00.000Z' },
  { name: 'jean-claude/task-1', lastCommitDate: '2026-01-01T00:00:00.000Z' },
  { name: 'develop', lastCommitDate: '2026-01-01T00:00:00.000Z' },
] satisfies BranchInfo[];

vi.mock('@/hooks/use-projects', () => ({
  useProjectBranches: () => ({ data: branchFixtures, isLoading: false }),
}));

vi.mock('@/hooks/use-tasks', () => ({
  useSetTaskSourceBranch: () => ({
    mutate: setSourceBranchMutate,
    isPending: false,
  }),
  useSetTaskBranchName: () => ({
    mutate: setBranchNameMutate,
    isPending: false,
  }),
}));

function step(overrides: Partial<TaskStep> = {}): TaskStep {
  return {
    id: 'step-1',
    taskId: 'task-1',
    name: 'Implementation',
    type: 'agent',
    dependsOn: [],
    promptTemplate: '',
    resolvedPrompt: null,
    status: 'ready',
    sessionId: null,
    interactionMode: 'ask',
    modelPreference: null,
    thinkingEffort: null,
    agentBackend: 'claude-code',
    output: null,
    images: null,
    meta: {},
    sessionRules: { Bash: { 'pnpm test': 'allow' } },
    autoStart: false,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('TaskSettingsPane', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onRemoveTool = vi.fn().mockResolvedValue(undefined);

  function render(activeStep: TaskStep | null) {
    return act(() =>
      root.render(
        <TaskSettingsPane
          activeStep={activeStep}
          sourceBranch={null}
          sourceCommit={null}
          taskId="task-1"
          onRemoveTool={onRemoveTool}
          onClose={vi.fn()}
          onOpenDebugMessages={vi.fn()}
        />,
      ),
    );
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    onRemoveTool.mockClear();
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
  });

  function renderEditableSource() {
    return act(() =>
      root.render(
        <RootKeyboardBindings>
          <RootOverlay>
            <TaskSettingsPane
              activeStep={null}
              sourceBranch="main"
              sourceCommit={null}
              taskId="task-1"
              projectId="project-1"
              taskBranchName="jean-claude/task-1"
              canEditSourceBranch
              onRemoveTool={onRemoveTool}
              onClose={vi.fn()}
              onOpenDebugMessages={vi.fn()}
            />
          </RootOverlay>
        </RootKeyboardBindings>,
      ),
    );
  }

  function sourceBranchTrigger() {
    return Array.from(container.querySelectorAll('button')).find(
      (button) => (button.textContent ?? '').trim() === 'main',
    );
  }

  async function openBranchOptions() {
    await act(async () => {
      sourceBranchTrigger()?.click();
    });
    return Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    );
  }

  it('lets the user change the source branch, excluding the task branch', async () => {
    setSourceBranchMutate.mockClear();
    await renderEditableSource();
    expect(sourceBranchTrigger()).toBeDefined();

    const options = await openBranchOptions();
    const labels = options.map((option) => option.textContent ?? '');
    expect(labels.some((label) => label.includes('jean-claude/task-1'))).toBe(
      false,
    );

    const develop = options.find((option) =>
      (option.textContent ?? '').includes('develop'),
    );
    await act(async () => {
      develop?.click();
    });

    expect(setSourceBranchMutate).toHaveBeenCalledWith(
      { taskId: 'task-1', sourceBranch: 'develop' },
      expect.anything(),
    );
  });

  it('lets the user rename the task branch', async () => {
    setBranchNameMutate.mockClear();
    await renderEditableSource();
    expect(container.textContent).toContain('jean-claude/task-1');

    const renameButton = Array.from(
      container.querySelectorAll('button'),
    ).find(
      (button) => button.getAttribute('aria-label') === 'Rename task branch',
    );
    await act(async () => {
      renameButton?.click();
    });

    const input = container.querySelector('input');
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, 'feature/new-name');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });

    expect(setBranchNameMutate).toHaveBeenCalledWith(
      { taskId: 'task-1', branchName: 'feature/new-name' },
      expect.anything(),
    );
  });

  it('does not mutate when re-selecting the current source branch', async () => {
    setSourceBranchMutate.mockClear();
    await renderEditableSource();

    const options = await openBranchOptions();
    const main = options.find(
      (option) => (option.textContent ?? '').trim() === 'main',
    );
    await act(async () => {
      main?.click();
    });

    expect(setSourceBranchMutate).not.toHaveBeenCalled();
  });

  it('surfaces an error when changing the source branch fails', async () => {
    setSourceBranchMutate.mockClear();
    setSourceBranchMutate.mockImplementation((_vars, options) => {
      options?.onError?.(new Error('No common ancestor'));
    });
    await renderEditableSource();

    const options = await openBranchOptions();
    const develop = options.find((option) =>
      (option.textContent ?? '').includes('develop'),
    );
    await act(async () => {
      develop?.click();
    });

    expect(container.textContent).toContain('No common ancestor');
    setSourceBranchMutate.mockReset();
  });

  it('renders the source branch read-only when editing is not allowed', async () => {
    await act(() =>
      root.render(
        <TaskSettingsPane
          activeStep={null}
          sourceBranch="main"
          sourceCommit={null}
          taskId="task-1"
          onRemoveTool={onRemoveTool}
          onClose={vi.fn()}
          onOpenDebugMessages={vi.fn()}
        />,
      ),
    );

    expect(container.textContent).toContain('main');
    expect(container.querySelector('[role="combobox"]')).toBeNull();
  });

  it('shows active-step identity and switches immediately to its rules', async () => {
    await render(step());
    expect(container.textContent).toContain('Active Session Permissions');
    expect(container.textContent).toContain('Implementation');
    expect(container.textContent).toContain('Bash: pnpm test');

    await render(
      step({
        id: 'step-2',
        name: 'Verify result',
        sessionRules: { Read: 'allow' },
      }),
    );
    expect(container.textContent).toContain('Verify result');
    expect(container.textContent).toContain('Read');
    expect(container.textContent).not.toContain('pnpm test');
  });

  it('explains that a step must be added or selected when none is active', async () => {
    await render(null);
    expect(container.textContent).toContain('Add or select a step');
    expect(container.querySelector('[aria-label^="Remove "]')).toBeNull();
  });

  it('shows review-chat permissions read-only', async () => {
    await render(
      step({
        name: 'Review chat: src/app.ts',
        meta: {
          kind: 'pr-review-chat',
          pullRequestId: 42,
          filePath: 'src/app.ts',
          lineStart: 10,
          selectedText: 'const value = 1;',
        },
      }),
    );
    expect(container.textContent).toContain('Review chat permissions are read-only');
    expect(container.querySelector('[aria-label^="Remove "]')).toBeNull();
  });

  it('allows removing a generic step rule', async () => {
    await render(step());
    const remove = container.querySelector<HTMLButtonElement>(
      '[aria-label="Remove Bash: pnpm test"]',
    );
    expect(remove).not.toBeNull();
    await act(async () => {
      remove!.click();
      await Promise.resolve();
    });
    expect(onRemoveTool).toHaveBeenCalledWith({
      toolName: 'Bash',
      pattern: 'pnpm test',
    });
  });
});
