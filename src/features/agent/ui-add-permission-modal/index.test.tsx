// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

const apiMocks = vi.hoisted(() => ({
  addSessionAllowedTool: vi.fn(),
  allowForProject: vi.fn(),
  allowForProjectWorktrees: vi.fn(),
  allowGlobally: vi.fn(),
}));
const addToast = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({ api: { steps: apiMocks } }));
vi.mock('@/stores/toasts', () => ({
  useToastStore: (selector: (state: { addToast: ReturnType<typeof vi.fn> }) => unknown) =>
    selector({ addToast }),
}));
vi.mock('@/common/ui/modal', () => ({
  Modal: ({
    isOpen,
    ariaLabel,
    ariaDescribedBy,
    children,
  }: {
    isOpen: boolean;
    ariaLabel?: string;
    ariaDescribedBy?: string;
    children: React.ReactNode;
  }) =>
    isOpen ? (
      <div role="dialog" aria-label={ariaLabel} aria-describedby={ariaDescribedBy}>
        {children}
      </div>
    ) : null,
}));

import { AddPermissionModal } from '.';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe('AddPermissionModal', () => {
  let container: HTMLDivElement;
  let root: Root;

  async function renderModal() {
    await act(() =>
      root.render(
        <AddPermissionModal
          isOpen
          onClose={vi.fn()}
          command="pnpm test"
          stepId="origin-step"
          stepName="Implementation"
          hasWorktree
        />,
      ),
    );
  }

  async function submit(scope: 'Session' | 'Project' | 'Worktree' | 'Global') {
    const radio = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find(
      (input) => input.parentElement?.textContent?.includes(scope),
    );
    expect(radio).toBeDefined();
    await act(() => radio!.click());
    const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Add 1 permission'),
    );
    await act(() => button!.click());
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    for (const mock of Object.values(apiMocks)) {
      mock.mockReset().mockResolvedValue({});
    }
    addToast.mockReset();
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
  });

  it.each([
    ['Session', 'addSessionAllowedTool'],
    ['Project', 'allowForProject'],
    ['Worktree', 'allowForProjectWorktrees'],
    ['Global', 'allowGlobally'],
  ] as const)('uses exact %s API with originating step ID', async (scope, method) => {
    await renderModal();
    await submit(scope);
    expect(apiMocks[method]).toHaveBeenCalledWith({
      stepId: 'origin-step',
      toolName: 'Bash',
      input: { command: 'pnpm test' },
    });
    expect(Object.values(apiMocks).filter((mock) => mock.mock.calls.length > 0)).toHaveLength(1);
  });

  it('names and describes dialog, inputs, target, and scope options accessibly', async () => {
    await renderModal();

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-label')).toBe('Add to Permissions');
    const descriptionId = dialog?.getAttribute('aria-describedby');
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId!)?.textContent).toContain(
      'Originating step: Implementation',
    );
    const commandInput = container.querySelector<HTMLInputElement>('input[type="text"]');
    expect(commandInput?.labels?.[0]?.textContent).toContain('Permission command 1');
    const scope = container.querySelector('fieldset');
    expect(scope?.querySelector('legend')?.textContent).toBe('Scope');
    expect(container.textContent).toContain('Current step only');
    expect(container.textContent).toContain('All sessions in this project');
    expect(container.textContent).toContain('All worktrees for this project');
    expect(container.textContent).toContain('All projects');
  });

  it('warns when persisting Bash permissions broadly', async () => {
    await renderModal();
    expect(container.textContent).toContain(
      'Persistent Bash permissions can apply broadly. Keep command patterns specific.',
    );
    await act(() =>
      Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
        .find((input) => input.value === 'session')
        ?.click(),
    );
    expect(container.textContent).not.toContain('Persistent Bash permissions');
  });

  it('keeps modal open and reports rejected writes', async () => {
    const onClose = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    apiMocks.allowForProject.mockRejectedValue(new Error('write failed'));
    await act(() =>
      root.render(
        <AddPermissionModal
          isOpen
          onClose={onClose}
          command="pnpm test"
          stepId="origin-step"
          stepName="Implementation"
          hasWorktree={false}
        />,
      ),
    );
    await submit('Project');
    expect(onClose).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Add 1 permission');
    expect(addToast).toHaveBeenCalledWith({
      message: 'Failed to add permissions: write failed',
      type: 'error',
    });
    consoleError.mockRestore();
  });
});
