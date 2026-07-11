/**
 * @vitest-environment happy-dom
 */
/* eslint-disable sort-imports */
import { createElement, type ComponentProps } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';


import type { TaskStep } from '@shared/types';


import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';
import {
  PrReviewAgentChatCard,
  submitPrReviewAgentChatFollowUp,
} from '.';


let renderedRoot: Root | null = null;
let renderedContainer: HTMLDivElement | null = null;

afterEach(() => {
  renderedRoot?.unmount();
  renderedRoot = null;
  renderedContainer?.remove();
  renderedContainer = null;
});

function buildStep(overrides: Partial<TaskStep> = {}): TaskStep {
  return {
    id: 'step-1',
    taskId: 'task-1',
    name: 'Ask Agent',
    type: 'agent',
    dependsOn: [],
    promptTemplate: '',
    resolvedPrompt: null,
    status: 'completed',
    sessionId: 'session-1',
    interactionMode: 'plan',
    modelPreference: null,
    thinkingEffort: null,
    agentBackend: 'opencode',
    output: null,
    images: null,
    meta: {},
    autoStart: false,
    sortOrder: 0,
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    ...overrides,
  };
}

function renderStaticCard({
  step = buildStep(),
  messages = [],
  onFollowUp = vi.fn(),
  isSubmittingFollowUp = false,
  ...props
}: Partial<ComponentProps<typeof PrReviewAgentChatCard>> = {}) {
  return renderToStaticMarkup(
    createElement(
      RootKeyboardBindings,
      null,
      createElement(PrReviewAgentChatCard, {
        step,
        messages,
        onFollowUp,
        isSubmittingFollowUp,
        ...props,
      }),
    ),
  );
}

function renderInteractiveCard({
  step = buildStep(),
  messages = [],
  onFollowUp = vi.fn(),
  isSubmittingFollowUp = false,
  ...props
}: Partial<ComponentProps<typeof PrReviewAgentChatCard>> = {}) {
  renderedContainer = document.createElement('div');
  document.body.appendChild(renderedContainer);
  renderedRoot = createRoot(renderedContainer);
  flushSync(() =>
    renderedRoot?.render(
      createElement(
        RootKeyboardBindings,
        null,
        createElement(PrReviewAgentChatCard, {
          step,
          messages,
          onFollowUp,
          isSubmittingFollowUp,
          ...props,
        }),
      ),
    ),
  );
}

function getButtonByName(name: string | RegExp) {
  const buttons = Array.from(document.querySelectorAll('button'));
  const button = buttons.find((candidate) => {
    const accessibleName =
      candidate.getAttribute('aria-label') ?? candidate.textContent ?? '';
    return typeof name === 'string'
      ? accessibleName === name
      : name.test(accessibleName);
  });
  if (!button) throw new Error(`Button not found: ${String(name)}`);
  return button;
}

function getTextboxByPlaceholder(placeholder: string) {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    `textarea[placeholder="${placeholder}"]`,
  );
  if (!textarea) throw new Error(`Textbox not found: ${placeholder}`);
  return textarea;
}

function getByRole(role: string) {
  const element = document.querySelector(`[role="${role}"]`);
  if (!element) throw new Error(`Role not found: ${role}`);
  return element;
}

function queryByText(text: string) {
  return document.body.textContent?.includes(text) ? document.body : null;
}

function countText(markup: string, text: string) {
  return markup.split(text).length - 1;
}

function click(element: Element) {
  flushSync(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function typeInto(textarea: HTMLTextAreaElement, value: string) {
  flushSync(() => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    valueSetter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function flushAsyncUpdates() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('PrReviewAgentChatCard', () => {
  it('renders collapsed latest assistant answer', () => {
    const markup = renderStaticCard({
      messages: [
        {
          id: 'msg-1',
          date: '2026-07-05T00:00:00.000Z',
          type: 'assistant-message',
          value: 'Earlier answer',
        },
        {
          id: 'msg-2',
          date: '2026-07-05T00:00:01.000Z',
          type: 'result',
          value: 'Latest answer',
          isError: false,
        },
      ],
    });

    expect(markup).toContain('Ask Agent');
    expect(markup).toContain('Done');
    expect(markup).toContain('Latest answer');
    expect(markup).not.toContain('Earlier answer');
  });

  it('shows thinking text for running steps', () => {
    const markup = renderStaticCard({ step: buildStep({ status: 'running' }) });

    expect(markup).toContain('Running');
    expect(markup).toContain('Thinking...');
  });

  it('renders collapsed step output without messages', () => {
    const markup = renderStaticCard({
      step: buildStep({ output: 'Summary from step output.' }),
      messages: [],
    });

    expect(markup).toContain('Summary from step output.');
  });

  it('renders expanded Q/A chat only', () => {
    const markup = renderStaticCard({
      defaultExpanded: true,
      messages: [
        {
          id: 'msg-1',
          date: '2026-07-05T00:00:00.000Z',
          type: 'user-prompt',
          value: 'Why does this line need a guard?',
        },
        {
          id: 'msg-2',
          date: '2026-07-05T00:00:01.000Z',
          type: 'thinking',
          value: 'Hidden timeline reasoning',
        },
        {
          id: 'tool-1',
          date: '2026-07-05T00:00:02.000Z',
          type: 'tool-use',
          toolId: 'tool-1',
          name: 'read',
          input: { filePath: 'src/secret-tool-file.ts' },
          result: 'Hidden tool result',
        },
        {
          id: 'msg-3',
          date: '2026-07-05T00:00:03.000Z',
          type: 'assistant-message',
          value: 'Add a null check before dereferencing.',
        },
        {
          id: 'msg-4',
          date: '2026-07-05T00:00:04.000Z',
          type: 'result',
          value: 'Final answer: guard the nullable value.',
          isError: false,
        },
      ],
    });

    expect(markup).toContain('You');
    expect(markup).toContain('Agent');
    expect(markup).toContain('Why does this line need a guard?');
    expect(markup).toContain('Final answer: guard the nullable value.');
    expect(markup).not.toContain('Add a null check before dereferencing.');
    expect(markup).not.toContain('Hidden timeline reasoning');
    expect(markup).not.toContain('src/secret-tool-file.ts');
    expect(markup).not.toContain('Hidden tool result');
  });

  it('renders each user prompt with only the final response for that turn', () => {
    const markup = renderStaticCard({
      defaultExpanded: true,
      messages: [
        {
          id: 'prompt-1',
          date: '2026-07-05T00:00:00.000Z',
          type: 'user-prompt',
          value: 'First question?',
        },
        {
          id: 'draft-1',
          date: '2026-07-05T00:00:01.000Z',
          type: 'assistant-message',
          value: 'Intermediate first answer',
        },
        {
          id: 'result-1',
          date: '2026-07-05T00:00:02.000Z',
          type: 'result',
          value: 'Final first answer',
          isError: false,
        },
        {
          id: 'prompt-2',
          date: '2026-07-05T00:00:03.000Z',
          type: 'user-prompt',
          value: 'Second question?',
        },
        {
          id: 'draft-2',
          date: '2026-07-05T00:00:04.000Z',
          type: 'assistant-message',
          value: 'Final second answer',
        },
      ],
    });

    expect(markup).toContain('First question?');
    expect(markup).toContain('Final first answer');
    expect(markup).toContain('Second question?');
    expect(markup).toContain('Final second answer');
    expect(markup).not.toContain('Intermediate first answer');
  });

  it('deduplicates repeated user prompts before the response', () => {
    const markup = renderStaticCard({
      defaultExpanded: true,
      messages: [
        {
          id: 'synthetic-prompt',
          date: '2026-07-05T00:00:00.000Z',
          type: 'user-prompt',
          value: 'Why does this repeat?',
          isSDKSynthetic: true,
        },
        {
          id: 'real-prompt',
          date: '2026-07-05T00:00:01.000Z',
          type: 'user-prompt',
          value: 'Why does this repeat?',
        },
        {
          id: 'answer',
          date: '2026-07-05T00:00:02.000Z',
          type: 'result',
          value: 'One answer.',
          isError: false,
        },
      ],
    });

    expect(countText(markup, 'Why does this repeat?')).toBe(1);
    expect(markup).toContain('One answer.');
  });

  it('submits trimmed follow-up questions only when enabled', async () => {
    const onFollowUp = vi.fn();

    await expect(
      submitPrReviewAgentChatFollowUp({
        question: '  Can you explain this branch?  ',
        isDisabled: false,
        onFollowUp,
      }),
    ).resolves.toBe(true);
    expect(onFollowUp).toHaveBeenCalledWith('Can you explain this branch?');

    await expect(
      submitPrReviewAgentChatFollowUp({
        question: '   ',
        isDisabled: false,
        onFollowUp,
      }),
    ).resolves.toBe(false);
    await expect(
      submitPrReviewAgentChatFollowUp({
        question: 'Blocked question',
        isDisabled: true,
        onFollowUp,
      }),
    ).resolves.toBe(false);
    expect(onFollowUp).toHaveBeenCalledTimes(1);
  });

  it('renders disabled and submitting states', () => {
    const disabledMarkup = renderStaticCard({
      defaultExpanded: true,
      disabled: true,
      disableReason: 'Review task unavailable',
    });
    const submittingMarkup = renderStaticCard({
      defaultExpanded: true,
      isSubmittingFollowUp: true,
    });

    expect(disabledMarkup).toContain('Review task unavailable');
    expect(disabledMarkup).toMatch(/<textarea[^>]*disabled=""/);
    expect(disabledMarkup).toMatch(/<button[^>]*disabled=""/);
    expect(submittingMarkup).toContain('Sending...');
    expect(submittingMarkup).toMatch(/<textarea[^>]*disabled=""/);
    expect(submittingMarkup).toMatch(/<button[^>]*disabled=""/);
  });

  it('renders expanded message load errors without changing step status', () => {
    const markup = renderStaticCard({
      defaultExpanded: true,
      loadError: 'Failed to fetch messages',
      step: buildStep({ status: 'completed' }),
    });

    expect(markup).toContain('Done');
    expect(markup).toContain('Message load error');
    expect(markup).toContain('Failed to fetch messages');
  });

  it('expands with accessible button state and controls', () => {
    renderInteractiveCard({
      messages: [
        {
          id: 'msg-1',
          date: '2026-07-05T00:00:00.000Z',
          type: 'user-prompt',
          value: 'What changed?',
        },
        {
          id: 'msg-2',
          date: '2026-07-05T00:00:01.000Z',
          type: 'assistant-message',
          value: 'A guard changed.',
        },
      ],
    });

    const expandButton = getButtonByName('Expand agent chat');
    const controlledId = expandButton.getAttribute('aria-controls');

    expect(expandButton.getAttribute('aria-expanded')).toBe('false');
    expect(controlledId).toBeTruthy();
    expect(document.getElementById(controlledId ?? '')).toBeTruthy();

    click(expandButton);

    expect(expandButton.getAttribute('aria-expanded')).toBe('true');
    expect(getButtonByName('Collapse agent chat')).toBeTruthy();
    expect(getTextboxByPlaceholder('Ask a follow-up...')).toBeTruthy();
    expect(queryByText('What changed?')).toBeTruthy();
    expect(queryByText('A guard changed.')).toBeTruthy();
  });

  it('submits typed follow-up, trims value, and clears textarea', async () => {
    const onFollowUp = vi.fn();
    renderInteractiveCard({ defaultExpanded: true, onFollowUp });

    const textarea = getTextboxByPlaceholder('Ask a follow-up...');
    const sendButton = getButtonByName(/ask agent/i);

    typeInto(textarea, '  Explain this branch  ');
    click(sendButton);
    await flushAsyncUpdates();
    await flushAsyncUpdates();

    expect(onFollowUp).toHaveBeenCalledWith('Explain this branch');
    expect(onFollowUp).toHaveBeenCalledTimes(1);
    expect(getTextboxByPlaceholder('Ask a follow-up...').value).toBe('');
  });

  it('keeps typed follow-up and shows error when submission fails', async () => {
    const onFollowUp = vi.fn().mockRejectedValue(new Error('Network failed'));
    renderInteractiveCard({ defaultExpanded: true, onFollowUp });

    const textarea = getTextboxByPlaceholder('Ask a follow-up...');
    const sendButton = getButtonByName(/ask agent/i);

    typeInto(textarea, 'Explain this branch');
    click(sendButton);
    await flushAsyncUpdates();

    expect(onFollowUp).toHaveBeenCalledWith('Explain this branch');
    expect(textarea.value).toBe('Explain this branch');
    expect(getByRole('alert').textContent).toContain('Network failed');
  });

  it('prevents disabled follow-up submission and describes reason', () => {
    const onFollowUp = vi.fn();
    renderInteractiveCard({
      defaultExpanded: true,
      disabled: true,
      disableReason: 'Review task unavailable',
      onFollowUp,
    });

    const textarea = getTextboxByPlaceholder('Review task unavailable');
    const sendButton = getButtonByName(/ask agent/i);

    expect(textarea.disabled).toBe(true);
    expect(sendButton.disabled).toBe(true);
    expect(queryByText('Review task unavailable')).toBeTruthy();

    click(sendButton);

    expect(onFollowUp).not.toHaveBeenCalled();
  });

  it('prevents submitting follow-up while request is submitting', () => {
    const onFollowUp = vi.fn();
    renderInteractiveCard({
      defaultExpanded: true,
      isSubmittingFollowUp: true,
      onFollowUp,
    });

    const textarea = getTextboxByPlaceholder('Ask a follow-up...');
    const sendButton = getButtonByName(/sending/i);

    expect(textarea.disabled).toBe(true);
    expect(sendButton.disabled).toBe(true);

    click(sendButton);

    expect(onFollowUp).not.toHaveBeenCalled();
  });

  it('renders errored result as distinct error state', () => {
    renderInteractiveCard({
      messages: [
        {
          id: 'msg-1',
          date: '2026-07-05T00:00:00.000Z',
          type: 'assistant-message',
          value: 'Normal answer',
        },
        {
          id: 'msg-2',
          date: '2026-07-05T00:00:01.000Z',
          type: 'result',
          value: 'Agent failed',
          isError: true,
        },
      ],
    });

    expect(getByRole('alert').textContent).toContain('Agent error');
    expect(getByRole('alert').textContent).toContain('Agent failed');
    expect(queryByText('Normal answer')).toBeNull();
  });
});
