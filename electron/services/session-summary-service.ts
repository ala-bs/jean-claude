import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import type { AgentBackendType } from '@shared/agent-backend-types';
import type { AiUsageContext } from '@shared/ai-usage-types';
import type { ModelPreference } from '@shared/types';
import type { NormalizedEntry } from '@shared/normalized-message-v2';

import {
  SESSION_SUMMARY_PROMPT,
  SESSION_SUMMARY_SCHEMA,
} from './session-summary-prompt';
import { generateText } from './ai-generation-service';


const MAX_INLINE_TRANSCRIPT_CHARS = 30_000;
const MAX_TOOL_RESULT_CHARS = 4_000;

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const keep = Math.floor((maxLength - 20) / 2);
  return `${value.slice(0, keep)}\n...[truncated]...\n${value.slice(-keep)}`;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatToolEntry(
  entry: Extract<NormalizedEntry, { type: 'tool-use' }>,
) {
  if (entry.name === 'read') {
    return `Tool: read\nFile: ${(entry as Extract<typeof entry, { name: 'read' }>).input.filePath}`;
  }

  if (entry.name === 'edit') {
    return `Tool: edit\nFile: ${(entry as Extract<typeof entry, { name: 'edit' }>).input.filePath}`;
  }

  if (entry.name === 'grep') {
    return `Tool: grep\nPattern: ${(entry as Extract<typeof entry, { name: 'grep' }>).input.pattern}`;
  }

  if (entry.name === 'glob') {
    return `Tool: glob\nPattern: ${(entry as Extract<typeof entry, { name: 'glob' }>).input.pattern}`;
  }

  if (entry.name === 'write') {
    return `Tool: write\nFile: ${(entry as Extract<typeof entry, { name: 'write' }>).input.filePath}`;
  }

  if (entry.name === 'todo-write') {
    const typedEntry = entry as Extract<typeof entry, { name: 'todo-write' }>;
    const previousCount = typedEntry.result?.oldTodos.length ?? 0;
    const nextCount = typedEntry.result?.newTodos.length ?? 0;
    return `Tool: todo-write\nTodos: ${previousCount} -> ${nextCount}`;
  }

  const lines = [`Tool: ${entry.name}`];

  if ('input' in entry && entry.input !== undefined) {
    lines.push(`Input: ${truncateMiddle(stringifyUnknown(entry.input), 1200)}`);
  }
  if ('filePath' in entry && typeof entry.filePath === 'string') {
    lines.push(`File: ${entry.filePath}`);
  }
  if ('toolName' in entry && typeof entry.toolName === 'string') {
    lines.push(`MCP tool: ${entry.toolName}`);
  }
  if ('result' in entry && entry.result !== undefined) {
    lines.push(
      `Result: ${truncateMiddle(stringifyUnknown(entry.result), MAX_TOOL_RESULT_CHARS)}`,
    );
  }

  return lines.join('\n');
}

function formatEntry(entry: NormalizedEntry): string | null {
  switch (entry.type) {
    case 'user-prompt':
      return `User:\n${entry.value}`;
    case 'assistant-message':
      return `Assistant:\n${entry.value}`;
    case 'thinking':
      return `Thinking:\n${entry.value}`;
    case 'todo-update':
      return `Todos updated:\n${stringifyUnknown(entry.newTodos)}`;
    case 'file-edited':
      return `File edited: ${entry.filePath}`;
    case 'session-summary':
    case 'system-status':
      return null;
    case 'result':
      if (entry.isError) return null;
      return entry.value ? `Result:\n${entry.value}` : null;
    case 'tool-use':
      return formatToolEntry(entry);
    default: {
      const _exhaustive: never = entry;
      return _exhaustive;
    }
  }
}

function formatMessagesForSummary(messages: NormalizedEntry[]): string {
  return messages
    .map(formatEntry)
    .filter((entry): entry is string => Boolean(entry?.trim()))
    .join('\n\n---\n\n');
}

export function buildSummaryGenerationPrompt(
  messages: NormalizedEntry[],
): string {
  const transcript = formatMessagesForSummary(messages);
  if (!transcript) {
    throw new Error('Cannot summarize empty message history');
  }

  return `${SESSION_SUMMARY_PROMPT}\n\nPrior step normalized message history:\n\n${truncateMiddle(transcript, MAX_INLINE_TRANSCRIPT_CHARS)}`;
}

export type PreparedSummaryGenerationPrompt = {
  prompt: string;
  transcriptDir?: string;
  transcriptPath?: string;
};

export async function prepareSummaryGenerationPrompt(
  messages: NormalizedEntry[],
): Promise<PreparedSummaryGenerationPrompt> {
  const transcript = formatMessagesForSummary(messages);
  if (!transcript) {
    throw new Error('Cannot summarize empty message history');
  }

  if (transcript.length <= MAX_INLINE_TRANSCRIPT_CHARS) {
    return {
      prompt: `${SESSION_SUMMARY_PROMPT}\n\nPrior step normalized message history:\n\n${transcript}`,
    };
  }

  const tempRoot = tmpdir();
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(path.join(tempRoot, 'jc-step-summary-'));
  const transcriptPath = path.join(tempDir, 'normalized-messages.md');
  await writeFile(transcriptPath, transcript, 'utf-8');

  return {
    prompt: [
      SESSION_SUMMARY_PROMPT,
      '',
      'Prior step normalized message history is too large to inline.',
      'Read the full transcript from this temporary file before summarizing:',
      transcriptPath,
      '',
      'Use only that transcript and return the summary requested by the schema.',
    ].join('\n'),
    transcriptDir: tempDir,
    transcriptPath,
  };
}

export async function summarizeNormalizedMessages({
  backend,
  model,
  messages,
  preparedPrompt,
  usageContext,
}: {
  backend: AgentBackendType;
  model: ModelPreference;
  messages: NormalizedEntry[];
  preparedPrompt?: PreparedSummaryGenerationPrompt;
  usageContext?: AiUsageContext;
}): Promise<string> {
  const { prompt, transcriptDir, transcriptPath } =
    preparedPrompt ?? (await prepareSummaryGenerationPrompt(messages));

  let result: unknown;
  try {
    result = await generateText({
      backend,
      model,
      outputSchema: SESSION_SUMMARY_SCHEMA,
      prompt,
      ...(transcriptPath
        ? {
            cwd: path.dirname(transcriptPath),
            allowedTools: ['Read'],
            allowedToolPatterns: { Read: [transcriptPath] },
          }
        : {}),
      throwOnError: true,
      usageContext,
    });
  } finally {
    if (transcriptDir) {
      await rm(transcriptDir, { force: true, recursive: true });
    }
  }

  if (
    result &&
    typeof result === 'object' &&
    typeof (result as { summary?: unknown }).summary === 'string'
  ) {
    const summary = (result as { summary: string }).summary.trim();
    if (summary) return summary;
  }

  if (typeof result === 'string') {
    const summary = result.trim();
    if (summary) return summary;
  }

  throw new Error('Failed to generate summary from normalized messages');
}
