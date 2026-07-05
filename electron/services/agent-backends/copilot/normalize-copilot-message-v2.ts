// Normalizer V2 for GitHub Copilot SDK events -> NormalizationEvent[].

import { nanoid } from 'nanoid';

import type {
  NormalizationEvent,
  NormalizedResult,
} from '@shared/normalized-message-v2';

export type CopilotRawEvent = {
  type?: unknown;
  data?: unknown;
};

export type CopilotNormalizationContext = {
  lastUsage?: CopilotUsageData;
  lastTaskSummary?: string;
  hasFinalAssistantText?: boolean;
  emittedReasoningIds?: Set<string>;
  emittedToolUseIds?: Set<string>;
};

export function normalizeCopilotEventV2(
  raw: CopilotRawEvent,
  ctx: CopilotNormalizationContext = {},
): NormalizationEvent[] {
  switch (raw.type) {
    case 'session.title_changed':
      return normalizeTitleChanged(raw.data);
    case 'user.message':
      return normalizeUserMessage(raw.data);
    case 'assistant.usage':
      return normalizeAssistantUsage(raw.data, ctx);
    case 'assistant.message':
      return normalizeAssistantMessage(raw.data, ctx);
    case 'assistant.reasoning':
      return normalizeAssistantReasoning(raw.data, ctx);
    case 'tool.execution_start':
      return normalizeToolExecutionStart(raw.data, ctx);
    case 'tool.execution_complete':
      return normalizeToolExecutionComplete(raw.data);
    case 'session.error':
      return normalizeSessionError(raw.data);
    case 'session.task_complete':
      return normalizeTaskComplete(raw.data, ctx);
    case 'session.idle':
      return [
        {
          type: 'complete',
          result: {
            ...(ctx.lastUsage ?? { isError: false }),
            text: ctx.hasFinalAssistantText ? undefined : ctx.lastTaskSummary,
          },
        },
      ];
    default:
      return [];
  }
}

type CopilotUsageData = NormalizedResult & { isError: false };

function normalizeTitleChanged(data: unknown): NormalizationEvent[] {
  if (!data || typeof data !== 'object') return [];
  const title = (data as { title?: unknown }).title;
  if (typeof title !== 'string' || title.length === 0) return [];
  return [{ type: 'session-updated', title }];
}

function normalizeUserMessage(data: unknown): NormalizationEvent[] {
  const content = getContent(data);
  if (!content) return [];

  return [
    {
      type: 'entry',
      entry: {
        id: nanoid(),
        date: new Date().toISOString(),
        type: 'user-prompt',
        value: content,
      },
    },
  ];
}

function normalizeAssistantUsage(
  data: unknown,
  ctx: CopilotNormalizationContext,
): NormalizationEvent[] {
  if (!data || typeof data !== 'object') return [];

  const usage = data as {
    model?: unknown;
    inputTokens?: unknown;
    outputTokens?: unknown;
    cacheReadTokens?: unknown;
    cacheWriteTokens?: unknown;
    reasoningTokens?: unknown;
    duration?: unknown;
    cost?: unknown;
  };

  const previousUsage = ctx.lastUsage?.usage;
  ctx.lastUsage = {
    isError: false,
    model: mergeModel(ctx.lastUsage?.model, usage.model),
    durationMs: addOptional(ctx.lastUsage?.durationMs, usage.duration),
    usage: {
      inputTokens:
        (previousUsage?.inputTokens ?? 0) + numberOrZero(usage.inputTokens),
      outputTokens:
        (previousUsage?.outputTokens ?? 0) + numberOrZero(usage.outputTokens),
      cacheReadTokens: addOptional(
        previousUsage?.cacheReadTokens,
        usage.cacheReadTokens,
      ),
      cacheCreationTokens: addOptional(
        previousUsage?.cacheCreationTokens,
        usage.cacheWriteTokens,
      ),
      reasoningTokens: addOptional(
        previousUsage?.reasoningTokens,
        usage.reasoningTokens,
      ),
    },
  };

  return [];
}

function normalizeSessionError(data: unknown): NormalizationEvent[] {
  const message = getErrorMessage(data);
  return [
    { type: 'error', error: message },
    { type: 'complete', result: { isError: true, text: message } },
  ];
}

function normalizeTaskComplete(
  data: unknown,
  ctx: CopilotNormalizationContext,
): NormalizationEvent[] {
  if (!data || typeof data !== 'object') return [];
  const summary = (data as { summary?: unknown }).summary;
  if (typeof summary !== 'string' || summary.length === 0) return [];
  ctx.lastTaskSummary = summary;
  if (ctx.hasFinalAssistantText) return [];

  return [
    {
      type: 'entry',
      entry: {
        id: nanoid(),
        date: new Date().toISOString(),
        type: 'assistant-message',
        value: summary,
      },
    },
  ];
}

function normalizeAssistantMessage(
  data: unknown,
  ctx: CopilotNormalizationContext,
): NormalizationEvent[] {
  const content = getContent(data);
  const reasoningEvents = normalizeReasoningFromAssistantMessage(data, ctx);
  const toolEvents = normalizeToolRequestsFromAssistantMessage(data, ctx);
  if (!content) return [...reasoningEvents, ...toolEvents];
  const model = getModel(data);
  if (isFinalAssistantMessage(data)) {
    ctx.hasFinalAssistantText = true;
  }

  return [
    ...reasoningEvents,
    ...toolEvents,
    {
      type: 'entry',
      entry: {
        id: nanoid(),
        date: new Date().toISOString(),
        model,
        type: 'assistant-message',
        value: content,
      },
    },
  ];
}

function isFinalAssistantMessage(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const toolRequests = (data as { toolRequests?: unknown }).toolRequests;
  if (!Array.isArray(toolRequests)) return false;
  return toolRequests.some((request) => {
    if (!request || typeof request !== 'object') return false;
    return (request as { name?: unknown }).name === 'task_complete';
  });
}

function normalizeToolRequestsFromAssistantMessage(
  data: unknown,
  ctx: CopilotNormalizationContext,
): NormalizationEvent[] {
  if (!data || typeof data !== 'object') return [];
  const toolRequests = (data as { toolRequests?: unknown }).toolRequests;
  if (!Array.isArray(toolRequests)) return [];
  const model = getModel(data);

  return toolRequests.flatMap((request) => normalizeToolRequest(request, ctx, model));
}

function normalizeToolExecutionStart(
  data: unknown,
  ctx: CopilotNormalizationContext,
): NormalizationEvent[] {
  return normalizeToolRequest(data, ctx, getModel(data));
}

function normalizeToolRequest(
  data: unknown,
  ctx: CopilotNormalizationContext,
  model?: string,
): NormalizationEvent[] {
  if (!data || typeof data !== 'object') return [];
  const toolId = (data as { toolCallId?: unknown }).toolCallId;
  if (typeof toolId !== 'string' || toolId.length === 0) return [];

  const name = (data as { name?: unknown; toolName?: unknown }).name;
  const toolName = typeof name === 'string'
    ? name
    : (data as { toolName?: unknown }).toolName;
  if (typeof toolName !== 'string' || toolName.length === 0) return [];
  if (hasEmittedToolUse(ctx, toolId)) return [];
  markToolUseEmitted(ctx, toolId);
  const input = (data as { arguments?: unknown }).arguments;
  const parentToolId = (data as { parentToolCallId?: unknown }).parentToolCallId;

  return [
    {
      type: 'entry',
      entry: {
        id: nanoid(),
        date: new Date().toISOString(),
        model,
        type: 'tool-use',
        toolId,
        name: toolName,
        input,
        ...(typeof parentToolId === 'string' ? { parentToolId } : {}),
      },
    },
  ];
}

function normalizeToolExecutionComplete(data: unknown): NormalizationEvent[] {
  if (!data || typeof data !== 'object') return [];
  const toolId = (data as { toolCallId?: unknown }).toolCallId;
  if (typeof toolId !== 'string' || toolId.length === 0) return [];
  const success = (data as { success?: unknown }).success;
  const result = (data as { result?: unknown }).result;
  const error = (data as { error?: unknown }).error;

  return [
    {
      type: 'tool-result',
      toolId,
      result: getToolResultText(result, error),
      isError: success === false,
    },
  ];
}

function normalizeAssistantReasoning(
  data: unknown,
  ctx: CopilotNormalizationContext,
): NormalizationEvent[] {
  if (!data || typeof data !== 'object') return [];
  const reasoningId = (data as { reasoningId?: unknown }).reasoningId;
  if (typeof reasoningId === 'string' && hasEmittedReasoning(ctx, reasoningId)) {
    return [];
  }
  const content = (data as { content?: unknown }).content;
  if (typeof content !== 'string' || content.length === 0) return [];
  markReasoningEmitted(ctx, reasoningId);

  return [
    {
      type: 'entry',
      entry: {
        id: nanoid(),
        date: new Date().toISOString(),
        type: 'thinking',
        value: content,
      },
    },
  ];
}

function normalizeReasoningFromAssistantMessage(
  data: unknown,
  ctx: CopilotNormalizationContext,
): NormalizationEvent[] {
  if (!data || typeof data !== 'object') return [];
  const reasoningId = (data as { reasoningOpaque?: unknown }).reasoningOpaque;
  if (typeof reasoningId === 'string' && hasEmittedReasoning(ctx, reasoningId)) {
    return [];
  }
  const content = (data as { reasoningText?: unknown }).reasoningText;
  if (typeof content !== 'string' || content.length === 0) return [];
  markReasoningEmitted(ctx, reasoningId);

  return [
    {
      type: 'entry',
      entry: {
        id: nanoid(),
        date: new Date().toISOString(),
        model: getModel(data),
        type: 'thinking',
        value: content,
      },
    },
  ];
}

function getContent(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const content = (data as { content?: unknown }).content;
  return typeof content === 'string' && content.length > 0 ? content : null;
}

function getModel(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const model = (data as { model?: unknown }).model;
  return typeof model === 'string' ? model : undefined;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function addOptional(current: number | undefined, next: unknown): number | undefined {
  if (typeof next !== 'number') return current;
  return (current ?? 0) + next;
}

function mergeModel(current: string | undefined, next: unknown): string | undefined {
  if (typeof next !== 'string') return current;
  if (!current || current === next) return next;
  return undefined;
}

function getErrorMessage(data: unknown): string {
  if (typeof data === 'string') return data;
  if (!data || typeof data !== 'object') return 'Copilot session failed';
  const error = (data as { error?: unknown; message?: unknown }).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const errorMessage = (error as { message?: unknown }).message;
    if (typeof errorMessage === 'string') return errorMessage;
  }
  const message = (data as { message?: unknown }).message;
  return typeof message === 'string' ? message : 'Copilot session failed';
}

function hasEmittedReasoning(
  ctx: CopilotNormalizationContext,
  reasoningId: string,
): boolean {
  return ctx.emittedReasoningIds?.has(reasoningId) ?? false;
}

function markReasoningEmitted(
  ctx: CopilotNormalizationContext,
  reasoningId: unknown,
) {
  if (typeof reasoningId !== 'string') return;
  ctx.emittedReasoningIds ??= new Set();
  ctx.emittedReasoningIds.add(reasoningId);
}

function hasEmittedToolUse(
  ctx: CopilotNormalizationContext,
  toolId: string,
): boolean {
  return ctx.emittedToolUseIds?.has(toolId) ?? false;
}

function markToolUseEmitted(
  ctx: CopilotNormalizationContext,
  toolId: string,
) {
  ctx.emittedToolUseIds ??= new Set();
  ctx.emittedToolUseIds.add(toolId);
}

function getToolResultText(result: unknown, error: unknown): string | undefined {
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  if (!result || typeof result !== 'object') return undefined;
  const detailedContent = (result as { detailedContent?: unknown }).detailedContent;
  if (typeof detailedContent === 'string') return detailedContent;
  const content = (result as { content?: unknown }).content;
  return typeof content === 'string' ? content : undefined;
}
