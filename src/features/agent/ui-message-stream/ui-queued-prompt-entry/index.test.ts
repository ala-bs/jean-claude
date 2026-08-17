// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import type { AgentMemoryTaskReviewCapture } from '@shared/agent-memory-types';
import type { QueuedPrompt } from '@shared/agent-types';

const { updateQueuedPromptMock } = vi.hoisted(() => ({
  updateQueuedPromptMock: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@/lib/api', () => ({
  api: {
    agent: {
      cancelQueuedPrompt: vi.fn(),
      getPendingRequest: vi.fn(),
      queuePrompt: vi.fn(),
      respond: vi.fn(),
      sendMessage: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      updateQueuedPrompt: updateQueuedPromptMock,
    },
  },
}));

import { useAgentControls } from '@/hooks/use-agent';
import { QueuedPromptEntry } from '.';

const reviews: AgentMemoryTaskReviewCapture[] = [
  {
    commentId: 'review-alpha',
    body: 'Keep alpha',
    selectedText: 'alpha',
    filePath: 'src/alpha.ts',
    lineStart: 1,
    lineEnd: 1,
    presets: [],
  },
  {
    commentId: 'review-beta',
    body: 'Remove beta',
    selectedText: 'beta',
    filePath: 'src/beta.ts',
    lineStart: 2,
    lineEnd: 2,
    presets: [],
  },
  {
    commentId: 'review-gamma',
    body: 'Keep gamma',
    selectedText: 'gamma',
    filePath: 'src/gamma.ts',
    lineStart: 3,
    lineEnd: 3,
    presets: [],
  },
];

function reviewXml(review: AgentMemoryTaskReviewCapture, index: number): string {
  const lineRange =
    review.lineStart === null
      ? ''
      : ` line_range="L${review.lineStart}${review.lineEnd === review.lineStart ? '' : `-L${review.lineEnd}`}"`;
  const tags =
    review.presets.length > 0
      ? `  <tags>${review.presets.join(', ')}</tags>\n`
      : '';
  const selectedText = review.selectedText
    ? `  <selected_lines>\n${review.selectedText}\n  </selected_lines>\n`
    : '';
  return `<comment index="${index}" comment_id="${review.commentId}" type="file" file_path="${review.filePath}"${lineRange}>
${tags}${selectedText}  <instruction>
${review.body}
  </instruction>
</comment>`;
}

function queuedPrompt(content: string): QueuedPrompt {
  return {
    id: 'queued-1',
    content,
    createdAt: 1,
    agentMemoryCapture: { userText: content, reviews },
  };
}

describe('QueuedPromptEntry Agent Memory updates', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    updateQueuedPromptMock.mockResolvedValue(undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = false;
    container.remove();
  });

  async function editPrompt(prompt: QueuedPrompt, content: string) {
    function Harness() {
      const controls = useAgentControls({ taskId: 'task-1', stepId: 'step-1' });
      return createElement(QueuedPromptEntry, {
        prompt,
        onCancel: vi.fn(),
        onUpdate: controls.updateQueuedPrompt,
      });
    }

    await act(async () => root.render(createElement(Harness)));
    const editButton = container.querySelector<HTMLButtonElement>(
      'button[title="Edit queued prompt"]',
    );
    if (!editButton) throw new Error('Edit button not found');
    await act(async () => editButton.click());

    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('Queued prompt textarea not found');
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      if (!setValue) throw new Error('Textarea value setter not found');
      setValue.call(textarea, content);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const saveButton = container.querySelector<HTMLButtonElement>(
      'button[title="Save queued prompt"]',
    );
    if (!saveButton) throw new Error('Save button not found');
    await act(async () => saveButton.click());
  }

  it('retains review evidence represented in final review XML', async () => {
    const content = `<user_review>\n${reviewXml(reviews[0], 1)}\n</user_review>`;

    await editPrompt(queuedPrompt(content), content);

    expect(updateQueuedPromptMock).toHaveBeenCalledWith(
      'step-1',
      'queued-1',
      content,
      { userText: content, reviews: [reviews[0]] },
    );
  });

  it('removes review evidence when final review XML is deleted', async () => {
    const original = `<user_review>\n${reviewXml(reviews[0], 1)}\n</user_review>`;

    await editPrompt(queuedPrompt(original), 'Continue without review comments');

    expect(updateQueuedPromptMock).toHaveBeenCalledWith(
      'step-1',
      'queued-1',
      'Continue without review comments',
      { userText: 'Continue without review comments', reviews: [] },
    );
  });

  it('keeps only surviving stable-ID comments and updates edited bodies', async () => {
    const original = `<user_review>\n${reviews
      .map((review, index) => reviewXml(review, index + 1))
      .join('\n')}\n</user_review>`;
    const editedGamma = { ...reviews[2], body: 'Updated gamma' };
    const unknownReview = { ...reviews[1], commentId: 'unknown-review' };
    const finalContent = `<user_review>\n${reviewXml(reviews[0], 1)}\n${reviewXml(
      unknownReview,
      2,
    )}\n${reviewXml(editedGamma, 3)}\n</user_review>`;

    await editPrompt(queuedPrompt(original), finalContent);

    expect(updateQueuedPromptMock).toHaveBeenCalledWith(
      'step-1',
      'queued-1',
      finalContent,
      {
        userText: finalContent,
        reviews: [reviews[0], editedGamma],
      },
    );
  });
});
