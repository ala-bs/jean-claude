// @vitest-environment happy-dom
/* eslint-disable sort-imports */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import { RootOverlay } from '@/common/context/overlay';

import { DeletePrWorkspaceDialog } from '.';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe('DeletePrWorkspaceDialog', () => {
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

  async function renderDialog(
    props: Partial<Parameters<typeof DeletePrWorkspaceDialog>[0]> = {},
  ) {
    const onConfirm = props.onConfirm ?? vi.fn();
    await act(async () => {
      root.render(
        <RootOverlay>
          <RootKeyboardBindings>
            <DeletePrWorkspaceDialog
              isOpen
              scope="current"
              isPending={false}
              error={null}
              onClose={vi.fn()}
              onConfirm={onConfirm}
              {...props}
            />
          </RootKeyboardBindings>
        </RootOverlay>,
      );
    });
    return onConfirm;
  }

  it('uses exact current-workspace action copy and confirms current only', async () => {
    const onConfirm = await renderDialog();
    const text = document.body.textContent ?? '';

    expect(text).toContain('Delete PR Workspace');
    expect(text).toContain('task history');
    expect(text).toContain('steps and messages');
    expect(text).toContain('worktree');
    expect(text).toContain('local branch');
    expect(text).toContain('agents');
    expect(text).toContain('commands');

    await act(async () => findButton('Delete PR Workspace').click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('uses exact all-workspaces action label', async () => {
    const onConfirm = await renderDialog({ scope: 'all' });

    await act(async () => findButton('Delete PR Workspaces').click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('disables dismissal while running and keeps backend failure for retry', async () => {
    const onClose = vi.fn();
    const onConfirm = await renderDialog({
      error: new Error('Branch removal failed'),
      onClose,
    });

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Branch removal failed',
    );
    await act(async () => findButton('Delete PR Workspace').click());
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await renderDialog({ isPending: true, onClose, onConfirm });
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(
      'Delete PR Workspace',
    );
    expect(findButton('Cancel').disabled).toBe(true);
    expect(findButton('Delete PR Workspace').disabled).toBe(true);
    expect(document.querySelector('[aria-label="Close dialog"]')).toBeNull();

    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      document.querySelector('[role="dialog"]')?.parentElement?.click();
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});

function findButton(label: string) {
  const button = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}
