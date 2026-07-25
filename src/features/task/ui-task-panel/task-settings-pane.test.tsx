// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import type { TaskStep } from '@shared/types';

import { TaskSettingsPane } from './task-settings-pane';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/hooks/use-skills', () => ({
  useSkills: () => ({ data: [], isLoading: false, error: null }),
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
