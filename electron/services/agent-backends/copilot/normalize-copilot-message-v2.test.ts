import { describe, expect, it } from 'vitest';

import { normalizeCopilotEventV2 } from './normalize-copilot-message-v2';

describe('normalizeCopilotEventV2', () => {
  it('normalizes assistant.message into assistant text entry', () => {
    const events = normalizeCopilotEventV2({
      type: 'assistant.message',
      data: { content: 'Hello from Copilot' },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'entry',
      entry: {
        type: 'assistant-message',
        value: 'Hello from Copilot',
      },
    });
  });

  it('normalizes user.message into user prompt entry', () => {
    const events = normalizeCopilotEventV2({
      type: 'user.message',
      data: { content: 'Summarize this project' },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'entry',
      entry: {
        type: 'user-prompt',
        value: 'Summarize this project',
      },
    });
  });

  it('normalizes assistant reasoning before assistant text and dedupes later reasoning event', () => {
    const ctx = {};
    const events = normalizeCopilotEventV2(
      {
        type: 'assistant.message',
        data: {
          model: 'claude-sonnet-4.5',
          content: 'Answer',
          reasoningOpaque: 'reasoning-1',
          reasoningText: 'Thinking',
        },
      },
      ctx,
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'entry',
      entry: {
        model: 'claude-sonnet-4.5',
        type: 'thinking',
        value: 'Thinking',
      },
    });
    expect(events[1]).toMatchObject({
      type: 'entry',
      entry: {
        model: 'claude-sonnet-4.5',
        type: 'assistant-message',
        value: 'Answer',
      },
    });

    expect(
      normalizeCopilotEventV2(
        {
          type: 'assistant.reasoning',
          data: { reasoningId: 'reasoning-1', content: 'Thinking' },
        },
        ctx,
      ),
    ).toEqual([]);
  });

  it('normalizes assistant tool requests from assistant messages', () => {
    const events = normalizeCopilotEventV2({
      type: 'assistant.message',
      data: {
        model: 'gpt-5',
        content: '',
        toolRequests: [
          {
            toolCallId: 'tool-1',
            name: 'bash',
            arguments: { command: 'pnpm test' },
          },
        ],
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'entry',
      entry: {
        model: 'gpt-5',
        type: 'tool-use',
        toolId: 'tool-1',
        name: 'bash',
        input: { command: 'pnpm test' },
      },
    });
  });

  it('normalizes tool execution completion into tool result', () => {
    expect(
      normalizeCopilotEventV2({
        type: 'tool.execution_complete',
        data: {
          toolCallId: 'tool-1',
          success: true,
          result: { detailedContent: 'tests passed', content: 'ok' },
        },
      }),
    ).toEqual([
      {
        type: 'tool-result',
        toolId: 'tool-1',
        result: 'tests passed',
        isError: false,
      },
    ]);
  });

  it('normalizes session.title_changed into session update', () => {
    expect(
      normalizeCopilotEventV2({
        type: 'session.title_changed',
        data: { title: 'Project summary' },
      }),
    ).toEqual([{ type: 'session-updated', title: 'Project summary' }]);
  });

  it('uses assistant.usage for session idle result', () => {
    const ctx = {};

    expect(
      normalizeCopilotEventV2(
        {
          type: 'assistant.usage',
          data: {
            model: 'claude-sonnet-4.5',
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 3,
            cacheWriteTokens: 4,
            reasoningTokens: 5,
            duration: 1234,
          },
        },
        ctx,
      ),
    ).toEqual([]);

    expect(
      normalizeCopilotEventV2({ type: 'session.idle', data: {} }, ctx),
    ).toEqual([
      {
        type: 'complete',
        result: {
          isError: false,
          model: 'claude-sonnet-4.5',
          durationMs: 1234,
          usage: {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 3,
            cacheCreationTokens: 4,
            reasoningTokens: 5,
          },
        },
      },
    ]);
  });

  it('accumulates assistant.usage before session idle result', () => {
    const ctx = {};

    normalizeCopilotEventV2(
      {
        type: 'assistant.usage',
        data: {
          model: 'claude-sonnet-4.5',
          inputTokens: 10,
          outputTokens: 20,
          cacheWriteTokens: 30,
          duration: 100,
        },
      },
      ctx,
    );
    normalizeCopilotEventV2(
      {
        type: 'assistant.usage',
        data: {
          model: 'claude-sonnet-4.5',
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 3,
          reasoningTokens: 4,
          duration: 200,
        },
      },
      ctx,
    );

    expect(
      normalizeCopilotEventV2({ type: 'session.idle', data: {} }, ctx),
    ).toEqual([
      {
        type: 'complete',
        result: {
          isError: false,
          model: 'claude-sonnet-4.5',
          durationMs: 300,
          usage: {
            inputTokens: 11,
            outputTokens: 22,
            cacheReadTokens: 3,
            cacheCreationTokens: 30,
            reasoningTokens: 4,
          },
        },
      },
    ]);
  });

  it('normalizes session.error into error and errored result', () => {
    expect(
      normalizeCopilotEventV2({
        type: 'session.error',
        data: { error: { message: 'rate limited' } },
      }),
    ).toEqual([
      { type: 'error', error: 'rate limited' },
      { type: 'complete', result: { isError: true, text: 'rate limited' } },
    ]);
  });

  it('normalizes session.task_complete summary and carries it into idle result', () => {
    const ctx = {};
    const events = normalizeCopilotEventV2(
      {
        type: 'session.task_complete',
        data: { summary: 'Project summary' },
      },
      ctx,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'entry',
      entry: {
        type: 'assistant-message',
        value: 'Project summary',
      },
    });
    expect(
      normalizeCopilotEventV2({ type: 'session.idle', data: {} }, ctx),
    ).toEqual([
      {
        type: 'complete',
        result: { isError: false, text: 'Project summary' },
      },
    ]);
  });

  it('does not emit task complete summary as assistant output after assistant text', () => {
    const ctx = {};
    normalizeCopilotEventV2(
      {
        type: 'assistant.message',
        data: {
          content: 'Actual answer',
          toolRequests: [{ toolCallId: 'complete-1', name: 'task_complete' }],
        },
      },
      ctx,
    );

    expect(
      normalizeCopilotEventV2(
        {
          type: 'session.task_complete',
          data: { summary: 'Completed task summary' },
        },
        ctx,
      ),
    ).toEqual([]);

    expect(
      normalizeCopilotEventV2({ type: 'session.idle', data: {} }, ctx),
    ).toEqual([
      {
        type: 'complete',
        result: { isError: false, text: undefined },
      },
    ]);
  });

  it('still emits task complete summary after non-final assistant preamble', () => {
    const ctx = {};
    normalizeCopilotEventV2(
      {
        type: 'assistant.message',
        data: { content: 'I will inspect package.json first.' },
      },
      ctx,
    );

    const events = normalizeCopilotEventV2(
      {
        type: 'session.task_complete',
        data: { summary: 'Completed task summary' },
      },
      ctx,
    );

    expect(events[0]).toMatchObject({
      type: 'entry',
      entry: { type: 'assistant-message', value: 'Completed task summary' },
    });
  });

  it('normalizes session.idle into result event', () => {
    const events = normalizeCopilotEventV2({ type: 'session.idle', data: {} });

    expect(events).toEqual([
      {
        type: 'complete',
        result: { isError: false },
      },
    ]);
  });
});
