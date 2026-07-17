/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { NormalizedEntry } from '@shared/normalized-message-v2';

vi.mock('@/common/ui/modal', () => ({
  Modal: ({
    isOpen,
    children,
  }: {
    isOpen: boolean;
    children: ReactNode;
  }) => (isOpen ? children : null),
}));

vi.mock('@/features/common/ui-file-diff/file-tree', () => ({
  DiffFileTree: ({ files }: { files: Array<{ path: string }> }) =>
    files.map((file) => file.path).join('|'),
}));

vi.mock('@/features/common/ui-file-diff/file-diff-header', () => ({
  FileDiffHeader: ({ actions }: { actions?: ReactNode }) => actions ?? null,
}));

vi.mock('@/features/common/ui-file-diff', () => ({
  FileDiffContent: ({ headerActions }: { headerActions?: ReactNode }) =>
    headerActions ?? null,
}));

vi.mock('@/stores/navigation', () => ({
  useDiffFileTreeWidth: () => ({
    width: 224,
    minWidth: 150,
    setWidth: vi.fn(),
  }),
}));

vi.mock('@/stores/review-comments', () => ({
  useReviewCommentsForFile: () => [],
  useReviewCommentsStore: (selector: (state: object) => unknown) =>
    selector({
      addComment: vi.fn(),
      removeComment: vi.fn(),
      updateComment: vi.fn(),
      resolveComment: vi.fn(),
    }),
}));

import { PromptGroupDiffModal } from './prompt-group-diff-modal';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
});

function editEntry(filePath: string, hasStructuredDiff = true): NormalizedEntry {
  return {
    id: 'entry-1',
    type: 'tool-use',
    name: 'edit',
    toolId: 'tool-1',
    date: '2026-07-17T00:00:00Z',
    input: {
      filePath,
      oldString: 'before',
      newString: 'after',
      ...(hasStructuredDiff
        ? {}
        : { files: [{ filePath, type: 'update' as const }] }),
    },
  } as NormalizedEntry;
}

function renderModal({
  filePath,
  additionalFilePaths = [],
  hasStructuredDiff = true,
  rootPath = '/repo',
  onClose = vi.fn(),
  onOpenFileInReview = vi.fn(),
  onOpenFileInEditor = vi.fn(),
}: {
  filePath: string;
  additionalFilePaths?: string[];
  hasStructuredDiff?: boolean;
  rootPath?: string;
  onClose?: () => void;
  onOpenFileInReview?: (filePath: string) => void;
  onOpenFileInEditor?: (filePath: string) => void | Promise<void>;
}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => {
    root?.render(
      createElement(PromptGroupDiffModal, {
        isOpen: true,
        onClose,
        fileChangeEntries: [filePath, ...additionalFilePaths].map((path) =>
          editEntry(path, hasStructuredDiff),
        ),
        rootPath,
        taskId: 'task-1',
        onOpenFileInReview,
        onOpenFileInEditor,
      }),
    );
  });

  return { onClose, onOpenFileInReview, onOpenFileInEditor };
}

describe('PromptGroupDiffModal review navigation', () => {
  it('opens relative project files in task diff', () => {
    const { onClose, onOpenFileInReview } = renderModal({
      filePath: 'src/app.ts',
    });
    const button = container?.querySelector<HTMLButtonElement>(
      'button[title="Open in task diff"]',
    );

    button?.click();

    expect(button?.disabled).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onOpenFileInReview).toHaveBeenCalledWith('src/app.ts');
  });

  it('disables task diff action for external files', () => {
    const { onClose, onOpenFileInReview } = renderModal({
      filePath: '/tmp/external.ts',
    });
    const button = container?.querySelector<HTMLButtonElement>(
      'button[title="External files are unavailable in task diff"]',
    );

    button?.click();

    expect(button?.disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(onOpenFileInReview).not.toHaveBeenCalled();
  });

  it('disables task diff action for relative paths outside root', () => {
    const { onOpenFileInReview } = renderModal({
      filePath: 'src/../../external.ts',
    });
    const button = container?.querySelector<HTMLButtonElement>(
      'button[title="External files are unavailable in task diff"]',
    );

    button?.click();

    expect(button?.disabled).toBe(true);
    expect(onOpenFileInReview).not.toHaveBeenCalled();
  });

  it('disables task diff action for Windows rooted paths', () => {
    const { onOpenFileInReview } = renderModal({
      filePath: '\\external.ts',
    });
    const button = container?.querySelector<HTMLButtonElement>(
      'button[title="External files are unavailable in task diff"]',
    );

    button?.click();

    expect(button?.disabled).toBe(true);
    expect(onOpenFileInReview).not.toHaveBeenCalled();
  });

  it('matches Windows project roots case-insensitively', () => {
    const { onOpenFileInReview } = renderModal({
      filePath: 'c:\\repo\\src\\app.ts',
      rootPath: 'C:\\Repo',
    });
    const button = container?.querySelector<HTMLButtonElement>(
      'button[title="Open in task diff"]',
    );

    button?.click();

    expect(onOpenFileInReview).toHaveBeenCalledWith('src/app.ts');
  });

  it('merges absolute and relative aliases for one project file', () => {
    renderModal({
      filePath: '/repo/src/app.ts',
      additionalFilePaths: ['src/app.ts'],
    });

    expect(container?.textContent?.match(/src\/app\.ts/g)).toHaveLength(1);
  });

  it('opens project files without structured diff content', () => {
    const { onOpenFileInReview } = renderModal({
      filePath: 'src/app.ts',
      hasStructuredDiff: false,
    });
    const button = container?.querySelector<HTMLButtonElement>(
      'button[title="Open in task diff"]',
    );

    button?.click();

    expect(onOpenFileInReview).toHaveBeenCalledWith('src/app.ts');
  });

  it('opens selected file in configured editor', () => {
    const { onClose, onOpenFileInEditor } = renderModal({
      filePath: 'src/app.ts',
    });
    const button = container?.querySelector<HTMLButtonElement>(
      'button[title="Open file in editor"]',
    );

    button?.click();

    expect(onOpenFileInEditor).toHaveBeenCalledWith('/repo/src/app.ts');
    expect(onClose).not.toHaveBeenCalled();
  });
});
