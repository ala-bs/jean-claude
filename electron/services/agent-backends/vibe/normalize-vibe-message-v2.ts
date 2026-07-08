import type {
  NormalizationEvent,
  NormalizedEntry,
  NormalizedResult,
  NormalizedToolUse,
} from '@shared/normalized-message-v2';
import type { ResolvedPermissionRule } from '@shared/permission-types';

import {
  evaluatePermissionWithMatch,
  normalizeToolRequest,
} from '../../permission-settings-service';

type VibeNotification = {
  method: string;
  params?: Record<string, unknown>;
};

type VibeToolCallEntry = NormalizedEntry & { type: 'tool-use' };
type VibeTextEntry = NormalizedEntry & {
  type: 'assistant-message' | 'thinking';
  value: string;
};

type ToolDerivationInput = {
  toolName: string | undefined;
  kind: string | undefined;
  title: string | undefined;
  content: string | undefined;
  rawInput: Record<string, unknown> | undefined;
};

export type VibeNormalizationContext = {
  entriesById: Map<string, NormalizedEntry>;
  textById: Map<string, string>;
  permissionRules?: ResolvedPermissionRule[];
  pendingToolPermissionDecisions?: ToolPermissionDecision[];
  toolPermissionsByEntryId?: Map<string, NormalizedToolUse['permission']>;
};

type ToolPermissionDecision = NonNullable<NormalizedToolUse['permission']> & {
  tool: string;
  matchValue: string;
};

export type { NormalizationEvent, VibeNotification };

export function createVibeNormalizationContext(): VibeNormalizationContext {
  return {
    entriesById: new Map(),
    textById: new Map(),
  };
}

export function normalizeVibeNotification(
  notification: VibeNotification,
  ctx: VibeNormalizationContext,
): NormalizationEvent[] {
  if (notification.method !== 'session/update') {
    return [];
  }

  const update = getUpdate(notification.params ?? {});
  const updateType = updateTypeFrom(update);

  switch (updateType) {
    case 'agent_message_chunk':
      return normalizeTextChunk(update, ctx, 'assistant-message');
    case 'agent_thought_chunk':
      return normalizeTextChunk(update, ctx, 'thinking');
    case 'tool_call':
      return normalizeToolCall(update, ctx);
    case 'tool_call_update':
      return normalizeToolCallUpdate(update, ctx);
    case 'usage_update':
      return normalizeUsageUpdate(update);
    default:
      return [];
  }
}

function normalizeTextChunk(
  update: Record<string, unknown> | undefined,
  ctx: VibeNormalizationContext,
  type: 'assistant-message' | 'thinking',
): NormalizationEvent[] {
  if (update === undefined) return [];

  const messageId = messageIdFromUpdate(update);
  const chunk = textFromUpdate(update);
  if (messageId === undefined || chunk === undefined) return [];

  const existing = ctx.entriesById.get(messageId);
  const value = (ctx.textById.get(messageId) ?? '') + chunk;
  const entry: VibeTextEntry = {
    ...(existing?.type === type
      ? existing
      : {
          id: messageId,
          date: dateFromUpdate(update),
          type,
        }),
    value,
  };

  ctx.entriesById.set(messageId, entry);
  ctx.textById.set(messageId, value);

  return [
    {
      type: existing?.type === type ? 'entry-update' : 'entry',
      entry,
    },
  ];
}

function normalizeToolCall(
  update: Record<string, unknown> | undefined,
  ctx: VibeNormalizationContext,
): NormalizationEvent[] {
  if (update === undefined) return [];

  const toolId = toolIdFromUpdate(update);
  if (toolId === undefined) return [];

  const toolCall = record(update.toolCall);
  const title = str(update.title) ?? str(toolCall?.title);
  const content = textFromUpdate(update) ?? textFromValue(toolCall?.content);
  const rawInput = parseJsonRecord(update.rawInput);
  const toolName = str(record(update._meta)?.tool_name);
  const derived = deriveToolUse({
    toolName,
    kind: str(update.kind),
    title,
    content,
    rawInput,
  });

  if (derived === undefined) return [];

  const existing = ctx.entriesById.get(toolId);
  const entry: VibeToolCallEntry = {
    ...(existing?.type === 'tool-use' ? existing : {}),
    id: toolId,
    date: existing?.date ?? dateFromUpdate(update),
    type: 'tool-use',
    toolId,
    ...derived,
  } as VibeToolCallEntry;
  const permission = getToolPermission(ctx, toolId, entry);
  if (permission) entry.permission = permission;

  ctx.entriesById.set(toolId, entry);
  return [{ type: existing?.type === 'tool-use' ? 'entry-update' : 'entry', entry }];
}

function normalizeToolCallUpdate(
  update: Record<string, unknown> | undefined,
  ctx: VibeNormalizationContext,
): NormalizationEvent[] {
  if (update === undefined) return [];

  const toolId = toolIdFromUpdate(update);
  if (toolId === undefined) return [];

  const existing = ctx.entriesById.get(toolId);
  if (existing?.type !== 'tool-use') return [];

  const rawOutput = parseJsonRecord(update.rawOutput);
  const content =
    resultTextForTool(existing.name, rawOutput) ?? textFromUpdate(update) ?? '';
  const status = str(update.status)?.toLowerCase();
  const exitCode = exitCodeFromRawOutput(rawOutput);
  const isError =
    status === 'failed' ||
    status === 'error' ||
    (exitCode !== undefined && exitCode !== 0);
  const entry = {
    ...existing,
    permission: existing.permission ?? getToolPermission(ctx, toolId, existing),
    result: resultForTool(existing.name, content, isError),
  } as NormalizedEntry;

  ctx.entriesById.set(toolId, entry);
  return [{ type: 'entry-update', entry }];
}

function normalizeUsageUpdate(
  update: Record<string, unknown> | undefined,
): NormalizationEvent[] {
  if (update === undefined) return [];

  const used = numberFrom(update.used) ?? numberFrom(record(update.usage)?.used);
  const cost = record(update.cost);
  const amount =
    numberFrom(cost?.amount) ?? numberFrom(update.amount) ?? numberFrom(update.cost);
  const result: NormalizedResult = {
    isError: false,
    ...(amount === undefined
      ? {}
      : { cost: { costUsd: amount, totalCostUsd: amount } }),
    ...(used === undefined
      ? {}
      : { usage: { inputTokens: used, outputTokens: 0 } }),
  };

  return [{ type: 'result-update', result }];
}

function getUpdate(
  params: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const update =
    record(params.update) ??
    record(params.sessionUpdate) ??
    record(params.session_update) ??
    params;

  return (
    record(update.sessionUpdate) ??
    record(update.session_update) ??
    (updateTypeFrom(update) !== undefined ? update : undefined)
  );
}

function updateTypeFrom(
  update: Record<string, unknown> | undefined,
): string | undefined {
  if (update === undefined) return undefined;
  return (
    str(update.sessionUpdate) ??
    str(update.session_update) ??
    str(update.type) ??
    str(update.kind)
  );
}

function deriveToolUse({
  toolName,
  kind,
  title,
  content,
  rawInput,
}: ToolDerivationInput):
  | Omit<VibeToolCallEntry, 'id' | 'date' | 'type' | 'toolId'>
  | undefined {
  const text = `${toolName ?? ''}\n${kind ?? ''}\n${title ?? ''}\n${content ?? ''}`.toLowerCase();
  const command = stripBashPrefix(
    str(rawInput?.command) ?? (content !== undefined ? content : commandFromTitle(title)),
  );
  const filePath =
    str(rawInput?.file_path) ??
    str(rawInput?.filePath) ??
    extractPath(title, content);
  const value = content ?? title ?? '';

  if (
    toolName === 'bash' ||
    kind === 'execute' ||
    text.includes('bash') ||
    text.includes('shell') ||
    text.includes('command')
  ) {
    if (command === undefined) return undefined;
    return { name: 'bash', input: { command, description: title } };
  }

  if (toolName === 'read_file' || kind === 'read') {
    if (filePath === undefined) return undefined;
    return {
      name: 'read',
      input: { filePath },
      result: `Read from ${fileNameFromPath(filePath)}`,
    };
  }

  if (text.includes('edit') || text.includes('patch')) {
    if (filePath === undefined) return undefined;
    return {
      name: 'edit',
      input: { filePath, oldString: '', newString: value },
    };
  }

  if (text.includes('write_file') || text.includes('write file')) {
    if (filePath === undefined) return undefined;
    return { name: 'write', input: { filePath, value } };
  }

  if (text.includes('grep') || text.includes('search')) {
    const pattern = str(rawInput?.pattern) ?? value;
    if (pattern.length === 0) return undefined;
    return { name: 'grep', input: { pattern } };
  }

  if (text.includes('read')) {
    if (filePath === undefined) return undefined;
    return {
      name: 'read',
      input: { filePath },
      result: `Read from ${fileNameFromPath(filePath)}`,
    };
  }

  return { name: 'tool', input: { title, content } };
}

function getToolPermission(
  ctx: VibeNormalizationContext,
  entryId: string,
  toolUse: NormalizedToolUse,
): NormalizedToolUse['permission'] {
  const permissionsByEntryId = (ctx.toolPermissionsByEntryId ??= new Map());
  const existingPermission = permissionsByEntryId.get(entryId);
  if (existingPermission) return existingPermission;

  const { tool, matchValue } = normalizeToolRequest(
    toolUse.name,
    (toolUse.input ?? {}) as Record<string, unknown>,
  );
  const decisions = (ctx.pendingToolPermissionDecisions ??= []);
  const index = decisions.findIndex(
    (decision) => decision.tool === tool && decision.matchValue === matchValue,
  );
  if (index === -1) {
    const permissionDecision = ctx.permissionRules
      ? evaluatePermissionWithMatch(ctx.permissionRules, tool, matchValue)
      : undefined;
    const permission =
      permissionDecision?.action === 'allow'
        ? {
            allowedBy: 'system' as const,
            rule: permissionDecision.matchedRule
              ? {
                  tool: permissionDecision.matchedRule.tool,
                  pattern: permissionDecision.matchedRule.pattern,
                }
              : undefined,
          }
        : { allowedBy: 'agent' as const };
    permissionsByEntryId.set(entryId, permission);
    return permission;
  }

  const [decision] = decisions.splice(index, 1);
  const permission = decision.rule
    ? { allowedBy: decision.allowedBy, rule: decision.rule }
    : { allowedBy: decision.allowedBy };
  permissionsByEntryId.set(entryId, permission);
  return permission;
}

function resultForTool(name: string, content: string, isError: boolean): unknown {
  if (name === 'bash') return { content, isError };
  if (name === 'write') return { success: !isError };
  if (name === 'edit') return { changes: [] };
  if (name === 'tool') return { content, isError };
  return content;
}

function messageIdFromUpdate(
  update: Record<string, unknown>,
): string | undefined {
  return (
    str(update.messageId) ??
    str(update.message_id) ??
    str(update.id) ??
    str(record(update.message)?.id)
  );
}

function toolIdFromUpdate(update: Record<string, unknown>): string | undefined {
  return (
    str(update.toolCallId) ??
    str(update.tool_call_id) ??
    str(update.id) ??
    str(record(update.toolCall)?.id) ??
    str(record(update.tool_call)?.id)
  );
}

function textFromUpdate(update: Record<string, unknown>): string | undefined {
  return (
    textFromValue(update.content) ??
    str(update.text) ??
    str(update.delta) ??
    str(update.chunk) ??
    textFromValue(record(update.message)?.content)
  );
}

function textFromValue(value: unknown): string | undefined {
  const direct = str(value);
  if (direct !== undefined) return direct;

  if (Array.isArray(value)) {
    const parts = value.flatMap((item) => {
      const text = textFromValue(item);
      return text === undefined ? [] : [text];
    });
    return parts.length > 0 ? parts.join('') : undefined;
  }

  const valueRecord = record(value);
  if (valueRecord === undefined) return undefined;

  return (
    str(valueRecord.text) ??
    str(valueRecord.content) ??
    textFromValue(valueRecord.content)
  );
}

function resultTextForTool(
  toolName: string,
  rawOutput: Record<string, unknown> | undefined,
): string | undefined {
  if (rawOutput === undefined) return undefined;

  if (toolName === 'bash') {
    return (
      commandOutput(rawOutput) ??
      str(rawOutput.output) ??
      str(rawOutput.content)
    );
  }

  if (toolName === 'read') {
    return (
      str(rawOutput.content) ??
      str(rawOutput.stdout) ??
      str(rawOutput.output) ??
      str(rawOutput.stderr)
    );
  }

  return (
    str(rawOutput.content) ??
    str(rawOutput.stdout) ??
    str(rawOutput.stderr) ??
    str(rawOutput.output)
  );
}

function commandOutput(rawOutput: Record<string, unknown>): string | undefined {
  const stdout = str(rawOutput.stdout);
  const stderr = str(rawOutput.stderr);
  if (stdout === undefined && stderr === undefined) return undefined;

  const parts = [stdout, stderr].filter(
    (part) => part !== undefined && part.length > 0,
  );
  return parts.length > 0 ? parts.join('\n') : '';
}

function exitCodeFromRawOutput(
  rawOutput: Record<string, unknown> | undefined,
): number | undefined {
  if (rawOutput === undefined) return undefined;

  return (
    integerFrom(rawOutput.exit_code) ??
    integerFrom(rawOutput.exitCode) ??
    integerFrom(rawOutput.returncode) ??
    integerFrom(rawOutput.returnCode)
  );
}

function dateFromUpdate(update: Record<string, unknown>): string {
  const timestamp = numberFrom(update.timestamp) ?? numberFrom(update.time);
  if (timestamp !== undefined) {
    return new Date(timestamp).toISOString();
  }

  const date = str(update.date) ?? str(update.createdAt) ?? str(update.created_at);
  return date ?? new Date().toISOString();
}

function extractPath(
  title: string | undefined,
  content: string | undefined,
): string | undefined {
  const match = `${title ?? ''}\n${content ?? ''}`.match(
    /(?:[./~]?[-\w.]+\/[-\w./]+|[-\w.]+\.[-\w.]+)/,
  );
  return match?.[0];
}

function commandFromTitle(title: string | undefined): string | undefined {
  if (title === undefined) return undefined;
  if (/^bash$/i.test(title.trim())) return undefined;

  return title;
}

function stripBashPrefix(command: string | undefined): string | undefined {
  return command?.replace(/^bash:\s*/i, '');
}

function fileNameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).at(-1) ?? filePath;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  const valueRecord = record(value);
  if (valueRecord !== undefined) return valueRecord;

  const json = str(value);
  if (json === undefined) return undefined;

  try {
    return record(JSON.parse(json));
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberFrom(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function integerFrom(value: unknown): number | undefined {
  const number = numberFrom(value);
  if (number !== undefined) return number;

  const text = str(value)?.trim();
  if (text === undefined || text.length === 0) return undefined;

  const parsed = Number(text);
  return Number.isInteger(parsed) ? parsed : undefined;
}
