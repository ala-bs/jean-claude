// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

const { queuePromptMock, sendMessageMock } = vi.hoisted(() => ({
  queuePromptMock: vi.fn(),
  sendMessageMock: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@/lib/api', () => ({
  api: {
    agent: {
      sendMessage: sendMessageMock,
      queuePrompt: queuePromptMock,
      start: vi.fn(),
      stop: vi.fn(),
      respond: vi.fn(),
      getPendingRequest: vi.fn(),
      cancelQueuedPrompt: vi.fn(),
      updateQueuedPrompt: vi.fn(),
    },
  },
}));

import { useAgentControls } from './use-agent';

describe('useAgentControls Agent Memory submission metadata', () => {
  let container: HTMLDivElement;
  let root: Root;
  let controls: ReturnType<typeof useAgentControls> | null;

  beforeEach(() => {
    vi.clearAllMocks();
    sendMessageMock.mockResolvedValue(undefined);
    queuePromptMock.mockResolvedValue({ promptId: 'queued-1' });
    controls = null;
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

  it('reuses submission-variable id across immediate transport retries', async () => {
    function Harness() {
      controls = useAgentControls({ taskId: 'task-1', stepId: 'step-1' });
      return null;
    }
    await act(async () => root.render(createElement(Harness)));

    const capture = {
      submissionId: 'stable-immediate-id',
      userText: 'Follow up',
      reviews: [],
    };
    await act(async () => {
      await controls?.sendMessage(
        [{ type: 'text', text: 'Follow up' }],
        capture,
      );
      await controls?.sendMessage([{ type: 'text', text: 'Follow up' }], capture);
    });

    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMock).toHaveBeenNthCalledWith(
      1,
      'step-1',
      [{ type: 'text', text: 'Follow up' }],
      capture,
    );
    expect(sendMessageMock).toHaveBeenNthCalledWith(
      2,
      'step-1',
      [{ type: 'text', text: 'Follow up' }],
      capture,
    );
  });

  it('reuses submission-variable id across queued transport retries', async () => {
    function Harness() {
      controls = useAgentControls({ taskId: 'task-1', stepId: 'step-1' });
      return null;
    }
    await act(async () => root.render(createElement(Harness)));
    const capture = {
      submissionId: 'stable-queue-id',
      userText: 'Queue this',
      reviews: [],
    };

    await act(async () => {
      await controls?.queuePrompt([{ type: 'text', text: 'Queue this' }], capture);
      await controls?.queuePrompt([{ type: 'text', text: 'Queue this' }], capture);
    });

    expect(queuePromptMock).toHaveBeenCalledTimes(2);
    expect(queuePromptMock).toHaveBeenNthCalledWith(
      1,
      'step-1',
      [{ type: 'text', text: 'Queue this' }],
      capture,
    );
    expect(queuePromptMock).toHaveBeenNthCalledWith(
      2,
      'step-1',
      [{ type: 'text', text: 'Queue this' }],
      capture,
    );
  });
});
