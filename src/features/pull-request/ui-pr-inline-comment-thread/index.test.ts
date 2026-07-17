/**
 * @vitest-environment happy-dom
 */
/* eslint-disable sort-imports */
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/use-pull-requests', () => ({
  useAddThreadReply: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCommitFileContent: vi.fn(),
  useCurrentAzureUser: () => ({ data: undefined }),
  useDeleteThreadComment: () => ({ mutate: vi.fn(), isPending: false }),
  usePullRequestFileContent: vi.fn(),
  useSetThreadCommentLike: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateThreadComment: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateThreadStatus: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/features/common/ui-azure-html-content', () => ({
  AzureMarkdownContent: ({ markdown }: { markdown: string }) =>
    createElement('span', null, markdown),
}));

import type { AzureDevOpsCommentThread } from '@/lib/api';
import {
  convertPrThreadsForFile,
  PrInlineCommentThread,
} from '@/features/pull-request/ui-pr-inline-comment-thread';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
});

function makeThread(
  status: AzureDevOpsCommentThread['status'],
): AzureDevOpsCommentThread {
  return {
    id: 42,
    status,
    threadContext: {
      filePath: '/src/file.ts',
      rightFileStart: { line: 2 },
      rightFileEnd: { line: 4 },
    },
    comments: [
      {
        id: 1,
        content: 'First comment',
        commentType: 'text',
        author: {
          id: 'author-1',
          displayName: 'Ada',
          uniqueName: 'ada@example.com',
        },
        usersLiked: [],
        publishedDate: '2026-07-17T10:00:00Z',
        lastUpdatedDate: '2026-07-17T10:00:00Z',
      },
      {
        id: 2,
        parentCommentId: 1,
        content: 'Second comment',
        commentType: 'text',
        author: {
          id: 'author-2',
          displayName: 'Grace',
          uniqueName: 'grace@example.com',
        },
        usersLiked: [],
        publishedDate: '2026-07-17T11:00:00Z',
        lastUpdatedDate: '2026-07-17T11:00:00Z',
      },
    ],
    isDeleted: false,
  };
}

function renderThread(status: AzureDevOpsCommentThread['status']) {
  const [thread] = convertPrThreadsForFile([makeThread(status)], '/src/file.ts');
  if (!thread) throw new Error('Thread conversion failed');

  flushSync(() => {
    root?.render(
      createElement(PrInlineCommentThread, {
        thread,
        projectId: 'project',
        prId: 7,
        readOnly: true,
      }),
    );
  });
}

function click(element: Element) {
  flushSync(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function secondComment() {
  return Array.from(container?.querySelectorAll('span') ?? []).find(
    (element) => element.textContent === 'Second comment',
  );
}

describe('convertPrThreadsForFile', () => {
  it('preserves range and anchors thread after final selected line', () => {
    const [thread] = convertPrThreadsForFile([makeThread('active')], 'src/file.ts');

    expect(thread).toMatchObject({
      line: 4,
      lineStart: 2,
      lineEnd: 4,
    });
  });
});

describe('PrInlineCommentThread collapse', () => {
  it('starts active threads expanded and lets user collapse them', () => {
    renderThread('active');

    const expandedSecondComment = secondComment();
    expect(expandedSecondComment?.closest('[hidden]')).toBeNull();
    const collapse = container?.querySelector(
      'button[aria-label="Collapse thread"]',
    );
    expect(collapse).not.toBeNull();

    click(collapse!);

    expect(secondComment()).toBe(expandedSecondComment);
    expect(secondComment()?.closest('[hidden]')).not.toBeNull();
    expect(
      container?.querySelector('[role="button"][aria-label="Expand thread"]'),
    ).not.toBeNull();
  });

  it('starts resolved threads collapsed and lets user expand them', () => {
    renderThread('fixed');

    expect(secondComment()?.closest('[hidden]')).not.toBeNull();
    const expand = container?.querySelector(
      '[role="button"][aria-label="Expand thread"]',
    );
    expect(expand).not.toBeNull();

    click(expand!);

    expect(secondComment()?.closest('[hidden]')).toBeNull();
    expect(
      container?.querySelector('button[aria-label="Collapse thread"]'),
    ).not.toBeNull();
  });

  it('aligns collapsed content and clamps first comment to two lines', () => {
    renderThread('fixed');

    const summary = container?.querySelector(
      '[role="button"][aria-label="Expand thread"]',
    );
    expect(summary?.className).not.toContain('py-1');
    expect(summary?.firstElementChild?.className).toContain('w-[26px]');
    expect(
      summary?.children[1]?.firstElementChild?.className,
    ).toContain('min-h-7');

    const preview = summary?.querySelector('.line-clamp-2');
    expect(preview?.className).toContain('break-words');
    expect(preview?.className).toContain('overflow-hidden');
    expect(preview?.className).toContain('text-ellipsis');
    expect(preview?.className).toContain('text-[12.5px]');
    expect(preview?.className).toContain('leading-[1.66]');
    expect(preview?.className).not.toContain('text-xs');
  });

  it('resets default collapse state when thread status changes', () => {
    renderThread('active');
    expect(secondComment()?.closest('[hidden]')).toBeNull();

    renderThread('fixed');
    expect(secondComment()?.closest('[hidden]')).not.toBeNull();

    renderThread('active');
    expect(secondComment()?.closest('[hidden]')).toBeNull();
  });
});
