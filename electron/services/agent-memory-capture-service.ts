import { createHash } from 'node:crypto';

import { BrowserWindow } from 'electron';

import {
  AGENT_MEMORY_SCHEMA_VERSION,
  type AgentMemoryCaptureWarning,
  type AgentMemoryEvent,
  type AgentMemoryTaskReviewCapture,
  normalizeAgentMemoryEvent,
} from '@shared/agent-memory-types';

import { appendAgentMemoryEvent } from './agent-memory-storage';
import { dbg } from '../lib/debug';
import { redactAgentMemoryValue } from './agent-memory-redaction';
import { SettingsRepository } from '../database/repositories/settings';

export const AGENT_MEMORY_CAPTURE_WARNING_CHANNEL =
  'agentMemory:captureWarning';
export const AGENT_MEMORY_CONTEXT_LIMIT = 20_000;

type AgentMemoryCaptureInput = AgentMemoryEvent extends infer Event
  ? Event extends AgentMemoryEvent
    ? Omit<Event, 'schemaVersion' | 'id' | 'redactions'>
    : never
  : never;

export type AgentMemoryPromptSubmission = {
  source: 'follow-up-prompt' | 'queued-prompt' | 'new-step-prompt';
  sourceId: string;
  projectId: string;
  taskId: string;
  stepId: string;
  userText: string;
  previousAgentResult: string | null;
  reviews?: AgentMemoryTaskReviewCapture[];
  createdAt?: string;
};

function deterministicEventId(projectId: string, sourceId: string): string {
  const digest = createHash('sha256')
    .update(`agent-memory-event\0${projectId}\0${sourceId}`)
    .digest('hex');
  return `event-${digest}`;
}

function truncateAgentMemoryContext<T extends AgentMemoryEvent>(event: T): T {
  if (!event.context || typeof event.context !== 'object') return event;
  const context = { ...event.context } as Record<string, unknown>;
  for (const key of ['previousAgentResult', 'threadContext']) {
    if (typeof context[key] === 'string') {
      context[key] = latestAgentMemoryContextTail(context[key] as string);
    }
  }
  return { ...event, context } as T;
}

const REVIEW_PRESET_EVIDENCE: Record<string, string> = {
  refactor: 'Refactor this code',
  simplify: 'Simplify this code',
  rename: 'Rename this code for clarity',
  tests: 'Add tests',
  explain: 'Explain this code',
  remove: 'Remove this code',
};

function taskReviewEvidenceText(review: AgentMemoryTaskReviewCapture): string {
  if (review.body.trim()) return review.body.trim();
  const semantics = review.presets.flatMap((preset) => {
    const semantic = REVIEW_PRESET_EVIDENCE[preset];
    return semantic ? [semantic] : [];
  });
  if (semantics.length === 0) return '';
  if (semantics.length === 1) return `${semantics[0]}.`;
  return `${semantics.slice(0, -1).join(', ')} and ${semantics.at(-1)!.toLowerCase()}.`;
}

function mergeRedactionMarkers(
  ...markerGroups: AgentMemoryEvent['redactions'][]
): AgentMemoryEvent['redactions'] {
  const merged = new Map<string, AgentMemoryEvent['redactions'][number]>();
  for (const marker of markerGroups.flat()) {
    const key = `${marker.path}\0${marker.kind}`;
    const existing = merged.get(key);
    merged.set(key, {
      ...marker,
      count: marker.count + (existing?.count ?? 0),
    });
  }
  return [...merged.values()];
}

export function latestAgentMemoryContextTail(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  return value.slice(-AGENT_MEMORY_CONTEXT_LIMIT);
}

export function stripAgentMemoryPromptArtifacts(text: string): string {
  return text
    .replace(/\n*<attached_files>[\s\S]*?<\/attached_files>/g, '')
    .replace(/\n*<user_review>[\s\S]*?<\/user_review>/g, '')
    .trim();
}

export async function isAgentMemoryCaptureEnabled(): Promise<boolean> {
  return (await SettingsRepository.get('agentMemory')).enabled;
}

export async function captureAgentMemoryEvent(
  input: AgentMemoryCaptureInput,
): Promise<{ appended: boolean; disabled: boolean }> {
  if (!(await isAgentMemoryCaptureEnabled())) {
    return { appended: false, disabled: true };
  }

  const event = {
    ...input,
    schemaVersion: AGENT_MEMORY_SCHEMA_VERSION,
    id: deterministicEventId(input.projectId, input.sourceId),
    redactions: [],
  } as AgentMemoryEvent;
  const fullRedaction = redactAgentMemoryValue(event);
  const truncated = truncateAgentMemoryContext(fullRedaction.value);
  const defensiveRedaction = redactAgentMemoryValue(truncated);
  const safeEvent = normalizeAgentMemoryEvent({
    ...defensiveRedaction.value,
    redactions: mergeRedactionMarkers(
      fullRedaction.markers,
      defensiveRedaction.markers,
    ),
  });
  const result = await appendAgentMemoryEvent({ event: safeEvent });
  return { appended: result.appended, disabled: false };
}

export function reportAgentMemoryCaptureFailure(
  input: Pick<AgentMemoryCaptureInput, 'source' | 'projectId'> &
    Partial<Pick<AgentMemoryCaptureInput, 'taskId' | 'stepId'>>,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  const warning: AgentMemoryCaptureWarning = {
    source: input.source,
    projectId: input.projectId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.stepId ? { stepId: input.stepId } : {}),
    message,
  };
  dbg.agent(
    'Agent Memory capture failed source=%s projectId=%s taskId=%s stepId=%s: %O',
    input.source,
    input.projectId,
    input.taskId ?? '-',
    input.stepId ?? '-',
    error,
  );
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(AGENT_MEMORY_CAPTURE_WARNING_CHANNEL, warning);
    }
  }
}

export async function captureAgentMemoryEventSafe(
  input: AgentMemoryCaptureInput,
): Promise<void> {
  try {
    await captureAgentMemoryEvent(input);
  } catch (error) {
    try {
      reportAgentMemoryCaptureFailure(input, error);
    } catch {
      // Renderer teardown must not turn capture warning delivery into a rejection.
    }
  }
}

export async function captureAgentMemoryPromptSubmissionSafe({
  source,
  sourceId,
  projectId,
  taskId,
  stepId,
  userText,
  previousAgentResult,
  reviews = [],
  createdAt = new Date().toISOString(),
}: AgentMemoryPromptSubmission): Promise<void> {
  const captures: Promise<void>[] = [];
  const text = stripAgentMemoryPromptArtifacts(userText);
  if (text) {
    captures.push(
      captureAgentMemoryEventSafe({
        source,
        sourceId,
        projectId,
        taskId,
        stepId,
        text,
        context: {
          previousAgentResult,
        },
        createdAt,
      }),
    );
  }
  for (const review of reviews) {
    const reviewText = taskReviewEvidenceText(review);
    if (!reviewText) continue;
    captures.push(
      captureAgentMemoryEventSafe({
        source: 'task-review',
        sourceId: `task-review:${review.commentId}`,
        projectId,
        taskId,
        stepId,
        text: reviewText,
        context: {
          selectedText: review.selectedText,
          filePath: review.filePath,
          lineStart: review.lineStart,
          lineEnd: review.lineEnd,
          presets: review.presets,
        },
        createdAt,
      }),
    );
  }
  await Promise.all(captures);
}

export async function captureInitialTaskPromptSafe({
  projectId,
  taskId,
  stepId,
  userText,
  reviews = [],
  createdAt = new Date().toISOString(),
}: {
  projectId: string;
  taskId: string;
  stepId: string;
  userText: string;
  reviews?: AgentMemoryTaskReviewCapture[];
  createdAt?: string;
}): Promise<void> {
  const text = stripAgentMemoryPromptArtifacts(userText);
  const captures: Promise<void>[] = [];
  if (text) {
    captures.push(
      captureAgentMemoryEventSafe({
        source: 'initial-task-prompt',
        sourceId: `task:${taskId}:initial-prompt`,
        projectId,
        taskId,
        stepId,
        text,
        context: null,
        createdAt,
      }),
    );
  }
  for (const review of reviews) {
    const reviewText = taskReviewEvidenceText(review);
    if (!reviewText) continue;
    captures.push(
      captureAgentMemoryEventSafe({
        source: 'task-review',
        sourceId: `task-review:${review.commentId}`,
        projectId,
        taskId,
        stepId,
        text: reviewText,
        context: {
          selectedText: review.selectedText,
          filePath: review.filePath,
          lineStart: review.lineStart,
          lineEnd: review.lineEnd,
          presets: review.presets,
        },
        createdAt,
      }),
    );
  }
  await Promise.all(captures);
}
