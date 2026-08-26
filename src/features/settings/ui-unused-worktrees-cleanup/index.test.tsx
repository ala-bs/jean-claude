// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import type { UnusedWorktreeInfo } from '@shared/worktree-cleanup-types';

const scan = vi.hoisted(() => vi.fn());
const cleanup = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  api: { unusedWorktrees: { scan, cleanup } },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: ({ mutationFn }: { mutationFn: (vars: unknown) => unknown }) => ({
    mutateAsync: mutationFn,
    isPending: false,
    isSuccess: true,
  }),
}));

vi.mock('@/common/ui/modal', () => ({
  Modal: ({
    isOpen,
    title,
    children,
  }: {
    isOpen: boolean;
    title?: React.ReactNode;
    children: React.ReactNode;
  }) =>
    isOpen ? (
      <div role="dialog" aria-label="Unused worktrees">
        <div>{title}</div>
        {children}
      </div>
    ) : null,
}));

import { UnusedWorktreesCleanup } from '.';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function worktree(overrides: Partial<UnusedWorktreeInfo> = {}) {
  return {
    path: '/home/u/.jean-claude/worktrees/demo/feature-a',
    name: 'feature-a',
    projectId: 'p1',
    projectName: 'Demo',
    projectPath: '/repo',
    branchName: 'jean-claude/feature-a',
    taskId: null,
    taskName: null,
    reason: 'orphaned' as const,
    registered: true,
    hasUncommittedChanges: false,
    unpushedCommits: 0,
    stateUnknown: false,
    sizeBytes: 1024 * 1024,
    lastModifiedAt: new Date().toISOString(),
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  scan.mockResolvedValue({
    worktrees: [
      worktree(),
      worktree({ path: '/p/b', name: 'feature-b' }),
      worktree({
        path: '/p/c',
        name: 'feature-c',
        hasUncommittedChanges: true,
      }),
    ],
    scannedProjects: 1,
    totalWorktrees: 4,
    activeWorktrees: 1,
    errors: [],
  });
  cleanup.mockResolvedValue({
    removed: [],
    skipped: [],
    failed: [],
    freedBytes: 0,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function dialog() {
  return container.querySelector('[role="dialog"]');
}

function checkboxes() {
  return Array.from(
    container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  );
}

function button(text: string) {
  return Array.from(container.querySelectorAll('button')).find((element) =>
    element.textContent?.includes(text),
  );
}

async function scanAndOpen() {
  await act(async () => {
    root.render(<UnusedWorktreesCleanup />);
  });
  await act(async () => {
    button('Scan for Unused Worktrees')?.click();
  });
}

describe('UnusedWorktreesCleanup', () => {
  it('shows no dialog before scanning', async () => {
    await act(async () => {
      root.render(<UnusedWorktreesCleanup />);
    });
    expect(dialog()).toBeNull();
  });

  it('opens the results in a modal after scanning', async () => {
    await scanAndOpen();

    expect(dialog()).not.toBeNull();
    expect(dialog()?.textContent).toContain('Unused worktrees');
    expect(dialog()?.textContent).toContain('feature-a');
    expect(dialog()?.textContent).toContain('feature-c');
  });

  it('keeps the scan summary in the settings panel', async () => {
    await scanAndOpen();
    expect(container.textContent).toContain('4 worktrees total');
    expect(container.textContent).toContain('1 in use by active tasks');
  });

  it('pre-selects only worktrees without unsaved work', async () => {
    await scanAndOpen();
    // feature-c has uncommitted changes and must stay unchecked
    expect(checkboxes().map((box) => box.checked)).toEqual([true, true, false]);
    expect(button('Remove Selected')?.textContent).toContain('(2');
  });

  it('keeps rendering after toggling a checkbox', async () => {
    await scanAndOpen();

    await act(async () => checkboxes()[0]?.click());

    expect(dialog()?.textContent).toContain('feature-a');
    expect(button('Remove Selected')?.textContent).toContain('(1');
  });

  it('supports select all / none / safe', async () => {
    await scanAndOpen();

    await act(async () => button('Select all')?.click());
    expect(button('Remove Selected')?.textContent).toContain('(3');

    await act(async () => button('Select none')?.click());
    expect(button('Remove Selected')?.textContent).toContain('(0)');

    await act(async () => button('Select safe')?.click());
    expect(button('Remove Selected')?.textContent).toContain('(2');
  });

  it('focuses the clicked checkbox without the browser default scroll', async () => {
    await scanAndOpen();

    // Regression: the browser's scroll-into-view for the focused `sr-only`
    // input shifted the whole layout. We suppress the default and focus the
    // input ourselves with preventScroll, so focus must still land on it.
    const input = checkboxes()[0];
    const focusSpy = vi.spyOn(input, 'focus');
    const mousedown = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    });
    container.querySelector('label')?.dispatchEvent(mousedown);

    expect(mousedown.defaultPrevented).toBe(true);
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('still toggles when clicked after focus suppression', async () => {
    await scanAndOpen();

    container.querySelector('label')?.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    );
    await act(async () => checkboxes()[0]?.click());

    expect(checkboxes()[0]?.checked).toBe(false);
    expect(button('Remove Selected')?.textContent).toContain('(1');
  });

  it('resets the selection when a new scan returns different worktrees', async () => {
    await scanAndOpen();
    // User deselects everything, then closes without deleting
    await act(async () => button('Select none')?.click());
    expect(button('Remove Selected')?.textContent).toContain('(0)');
    await act(async () => button('Cancel')?.click());

    scan.mockResolvedValue({
      worktrees: [worktree({ path: '/p/x', name: 'feature-x' })],
      scannedProjects: 1,
      totalWorktrees: 1,
      activeWorktrees: 0,
      errors: [],
    });
    await act(async () => {
      button('Scan for Unused Worktrees')?.click();
    });

    // Stale selection must not survive into a differently-shaped result
    expect(dialog()?.textContent).toContain('feature-x');
    expect(button('Remove Selected')?.textContent).toContain('(1');
  });

  it('never submits a path that is not visible in the list', async () => {
    await scanAndOpen();
    await act(async () => button('Select all')?.click());
    await act(async () => button('Remove Selected')?.click());

    const submitted = cleanup.mock.calls[0]?.[0] as { paths: string[] };
    expect(submitted.paths).toEqual([
      '/home/u/.jean-claude/worktrees/demo/feature-a',
      '/p/b',
      '/p/c',
    ]);
  });

  it('treats an unknown working state as unsafe and leaves it unselected', async () => {
    scan.mockResolvedValue({
      worktrees: [worktree({ path: '/p/u', name: 'unknown-state', stateUnknown: true })],
      scannedProjects: 1,
      totalWorktrees: 1,
      activeWorktrees: 0,
      errors: [],
    });
    await scanAndOpen();

    expect(checkboxes()[0]?.checked).toBe(false);
    expect(dialog()?.textContent).toContain('state unknown');
  });

  it('shows scan errors inside the modal', async () => {
    scan.mockResolvedValue({
      worktrees: [],
      scannedProjects: 1,
      totalWorktrees: 0,
      activeWorktrees: 0,
      errors: [{ projectName: 'Broken', error: 'Could not read git worktrees' }],
    });
    await scanAndOpen();

    expect(dialog()?.textContent).toContain('Broken');
    expect(dialog()?.textContent).toContain('Could not read git worktrees');
    // Must not claim everything is clean when projects failed to scan
    expect(dialog()?.textContent).not.toContain('Everything is clean');
  });

  it('reports a failed scan instead of opening an empty modal', async () => {
    scan.mockRejectedValue(new Error('EACCES'));
    await scanAndOpen();

    expect(dialog()).toBeNull();
    expect(container.textContent).toContain('Scan failed: EACCES');
  });

  it('reports a rejected cleanup instead of failing silently', async () => {
    cleanup.mockRejectedValue(new Error('main process exploded'));
    await scanAndOpen();
    await act(async () => button('Remove Selected')?.click());

    expect(container.textContent).toContain(
      'Cleanup failed: main process exploded',
    );
    // The list is untouched, so the user can retry
    expect(dialog()?.textContent).toContain('feature-a');
  });

  it('keeps the user selection minus what was actually removed', async () => {
    cleanup.mockResolvedValue({
      removed: ['/home/u/.jean-claude/worktrees/demo/feature-a'],
      skipped: [],
      failed: [{ path: '/p/b', error: 'branch mismatch' }],
      freedBytes: 1024,
    });

    await scanAndOpen();
    await act(async () => button('Remove Selected')?.click());

    // feature-b failed and stays selected for a retry; feature-c was never
    // selected (uncommitted changes) and must not become selected.
    expect(button('Remove Selected')?.textContent).toContain('(1');
    expect(checkboxes().map((box) => box.checked)).toEqual([true, false]);
  });

  it('closes the modal and reports the result once everything is removed', async () => {
    cleanup.mockResolvedValue({
      removed: [
        '/home/u/.jean-claude/worktrees/demo/feature-a',
        '/p/b',
        '/p/c',
      ],
      skipped: [],
      failed: [],
      freedBytes: 3 * 1024 * 1024,
    });

    await scanAndOpen();
    await act(async () => button('Select all')?.click());
    await act(async () => button('Remove Selected')?.click());

    expect(dialog()).toBeNull();
    expect(container.textContent).toContain('Removed 3 worktrees');
    expect(container.textContent).toContain('3.0 MB freed');
  });

  it('keeps the modal open and lists failures when cleanup partially fails', async () => {
    cleanup.mockResolvedValue({
      removed: ['/p/b'],
      skipped: [],
      failed: [{ path: '/p/c', error: 'branch mismatch' }],
      freedBytes: 1024,
    });

    await scanAndOpen();
    await act(async () => button('Remove Selected')?.click());

    expect(dialog()).not.toBeNull();
    expect(container.textContent).toContain('branch mismatch');
    expect(dialog()?.textContent).not.toContain('feature-b');
  });
});
