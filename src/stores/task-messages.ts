import { create } from 'zustand';

import type {
  AgentBackgroundTask,
  AgentQuestion,
  QueuedPrompt,
} from '@shared/agent-types';
import type {
  NormalizedEntry,
  NormalizedPermissionRequest,
} from '@shared/normalized-message-v2';
import type { RunCommandLogStream, RunStatus } from '@shared/run-command-types';
import type { TaskStatus, TaskStepStatus } from '@shared/types';

import { clearReviewCommentsForTask } from './review-comments';
import { parseRunCommandLogBatch } from './utils-run-command-log-parser';

type StepExecutionStatus = TaskStatus | TaskStepStatus;

const MAX_RUN_COMMAND_LOG_LINES = 5000;
const RUN_COMMAND_LOG_CHUNK_LINE_LIMIT = 200;

function clearsPendingRequests(status: StepExecutionStatus): boolean {
  return (
    status === 'completed' || status === 'errored' || status === 'interrupted'
  );
}

function getQuestionTaskId(key: string): string {
  try {
    const parsed = JSON.parse(key);
    if (Array.isArray(parsed) && typeof parsed[0] === 'string') {
      return parsed[0];
    }
  } catch {
    // Support legacy keys.
  }
  const separatorIndex = key.indexOf(':');
  return separatorIndex === -1 ? key : key.slice(0, separatorIndex);
}

function isQuestionStateForTask(key: string, taskId: string): boolean {
  return key === taskId || getQuestionTaskId(key) === taskId;
}

/**
 * Draft keys for questions that are still pending on *other* steps of the same
 * task. A task can have several steps running at once, so pruning question
 * state task-wide would discard answers the user is still typing into a sibling
 * step's banner.
 */
function getLiveQuestionDraftKeys(
  state: TaskMessagesStore,
  taskId: string,
  excludeStepId?: string,
): Set<string> {
  const keys = new Set<string>();
  for (const [stepId, step] of Object.entries(state.steps)) {
    if (step.taskId !== taskId || stepId === excludeStepId) continue;
    const question = step.pendingQuestion;
    if (question) {
      keys.add(getQuestionDraftKey(question.taskId, question.requestId));
    }
  }
  return keys;
}

/**
 * Invalidates in-flight pending-request fetches for a single step.
 *
 * Deliberately per-step, and deliberately keyed by the step that actually owns
 * the request: a task's steps run concurrently and emit status updates
 * constantly, so bumping task-wide made every sibling tick discard an unrelated
 * step's in-flight fetch and its question banner never rendered.
 */
function bumpStepRequestVersion(state: TaskMessagesStore, stepId: string) {
  return {
    pendingRequestVersions: {
      ...state.pendingRequestVersions,
      [stepId]: (state.pendingRequestVersions[stepId] ?? 0) + 1,
    },
  };
}

/**
 * The pending request still live on some step of `taskId`, if any.
 *
 * `pendingRequestsByTaskId` is a single slot per task but steps run
 * concurrently, so clearing it when one step resolves would drop the feed's
 * "needs answer" attention while a sibling step is still waiting on the user.
 */
function findLivePendingRequestForTask(
  state: TaskMessagesStore,
  taskId: string,
  excludeStepId?: string,
): PendingRequest | null {
  for (const [stepId, step] of Object.entries(state.steps)) {
    if (step.taskId !== taskId || stepId === excludeStepId) continue;
    if (step.pendingPermission) {
      return { type: 'permission', stepId, permission: step.pendingPermission };
    }
    if (step.pendingQuestion) {
      return { type: 'question', stepId, question: step.pendingQuestion };
    }
  }
  return null;
}

/**
 * Prunes question drafts belonging to `taskId`, except those in
 * `keepDraftKeys`. Drafts are keyed by draft key (`getQuestionDraftKey`), i.e.
 * per request — never per task — so sibling steps of the same task keep
 * independent drafts.
 *
 * `questionResponsesInFlight` is intentionally NOT pruned here: a lock is
 * released by the `finally` in the submitting component, which always runs.
 * Pruning it from a store mutation could drop a lock that is still held,
 * re-opening the double-submit window it exists to close.
 */
function removeQuestionStateForTask(
  state: TaskMessagesStore,
  taskId: string,
  keepDraftKeys?: Iterable<string>,
) {
  const keepKeys = new Set(keepDraftKeys ?? []);
  const questionDrafts = Object.fromEntries(
    Object.entries(state.questionDrafts).filter(
      ([key]) => keepKeys.has(key) || !isQuestionStateForTask(key, taskId),
    ),
  );
  return { questionDrafts };
}

function areRunCommandPortsEqual(
  left: readonly number[] | undefined,
  right: readonly number[] | undefined,
) {
  const normalizedLeft = left ?? [];
  const normalizedRight = right ?? [];
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((port, index) => port === normalizedRight[index])
  );
}

export interface RunCommandLogLine {
  stream: RunCommandLogStream;
  line: string;
  timestamp: number;
}

export interface RunCommandLogChunk {
  id: string;
  lines: RunCommandLogLine[];
  lineCount: number;
}

export interface RunCommandLogState {
  chunks: RunCommandLogChunk[];
  pendingLines: Record<RunCommandLogStream, RunCommandLogLine | null>;
  trailingText: Record<RunCommandLogStream, string>;
  totalLineCount: number;
  updatedAt: number;
  version: number;
}

export interface QuestionDraft {
  answers: Record<string, string>;
  otherAnswers: Record<string, string>;
  notes: Record<string, string>;
}

export function getQuestionDraftKey(taskId: string, requestId: string): string {
  return JSON.stringify([taskId, requestId]);
}

export type RunCommandLogs = Record<string, RunCommandLogState>;

export function getRunCommandLogLineCount(
  log: RunCommandLogState | null | undefined,
): number {
  if (!log) return 0;
  return (
    log.totalLineCount +
    (log.pendingLines.stdout ? 1 : 0) +
    (log.pendingLines.stderr ? 1 : 0)
  );
}

export function getRunCommandLogLines(
  log: RunCommandLogState | null | undefined,
): RunCommandLogLine[] {
  if (!log) return [];

  const lines = log.chunks.flatMap((chunk) => chunk.lines);
  if (log.pendingLines.stdout) lines.push(log.pendingLines.stdout);
  if (log.pendingLines.stderr) lines.push(log.pendingLines.stderr);
  return lines;
}

export interface TaskState {
  taskId: string;
  messages: NormalizedEntry[];
  status: StepExecutionStatus;
  error: string | null;
  pendingPermission: (NormalizedPermissionRequest & { taskId: string }) | null;
  pendingQuestion: {
    taskId: string;
    requestId: string;
    contextReminder?: string;
    questions: AgentQuestion[];
  } | null;
  queuedPrompts: QueuedPrompt[];
  lastAccessedAt: number;
}

/**
 * Lightweight pending-request tracking keyed by taskId.
 * Always populated on permission/question IPC events regardless of whether the
 * step is fully loaded, so the feed can refine attention even for tasks whose
 * panel has never been opened.
 */
export interface PendingRequest {
  type: 'permission' | 'question';
  /**
   * The step that owns the request. Needed by per-step UI (the step flow bar)
   * to color the right chip when the step itself isn't in the `steps` cache.
   */
  stepId?: string;
  permission?: NormalizedPermissionRequest & { taskId: string };
  question?: {
    taskId: string;
    requestId: string;
    contextReminder?: string;
    questions: AgentQuestion[];
  };
}

interface TaskMessagesStore {
  /** Keyed by stepId — each step has its own message/state entry */
  steps: Record<string, TaskState>;
  /** Keyed by taskId — lightweight pending request tracking (always populated) */
  pendingRequestsByTaskId: Record<string, PendingRequest>;
  /**
   * Keyed by stepId — background jobs (background subagents, `run_in_background`
   * shells, Monitor) the agent is still waiting on. Kept outside `steps` so the
   * indicator survives step-cache eviction and arrives even before the step's
   * messages are loaded. Empty snapshots delete the key.
   */
  backgroundTasksByStepId: Record<string, AgentBackgroundTask[]>;
  /**
   * Keyed by stepId — bumped on every live `background-tasks` event so an
   * in-flight `getBackgroundTasks` hydration fetch can tell that a newer
   * snapshot landed while it was awaiting, and drop its stale result. A
   * reference check on the array is not enough: a set-then-clear pair during
   * the await returns the key to `undefined`, which looks unchanged.
   */
  backgroundTasksVersions: Record<string, number>;
  /**
   * Keyed by stepId — bumped whenever a step's pending request changes, so an
   * in-flight `getPendingRequest` fetch can detect that it raced. Per-step (not
   * global): sibling steps of the same task emit status updates constantly, and
   * a global counter made every sibling tick invalidate an unrelated step's
   * fetch, so its question banner never rendered.
   */
  pendingRequestVersions: Record<string, number>;
  /** Keyed by taskId — run command logs are task-level, not step-level */
  runCommandLogs: Record<string, RunCommandLogs>;
  /** Keyed by taskId/runCommandId — drops stale IPC batches after log reset. */
  runCommandLogGenerations: Record<string, Record<string, number>>;
  /** Keyed by taskId — running command status with command details */
  runCommandRunning: Record<string, RunStatus>;
  questionDrafts: Record<string, QuestionDraft>;
  questionResponsesInFlight: Record<string, boolean>;
  /** True after initial run-command status discovery settles. */
  areRunCommandStatusesHydrated: boolean;
  cacheLimit: number;

  // Actions (all keyed by stepId)
  loadStep: (
    stepId: string,
    taskId: string,
    messages: NormalizedEntry[],
    status: StepExecutionStatus,
  ) => void;
  applyEntryBatch: (
    updates: Array<{
      stepId: string;
      entry: NormalizedEntry;
      mode: 'append' | 'upsert';
    }>,
  ) => void;
  addEntry: (stepId: string, entry: NormalizedEntry) => void;
  updateEntry: (stepId: string, entry: NormalizedEntry) => void;
  updateToolResult: (
    stepId: string,
    toolId: string,
    result: string | undefined,
    isError: boolean,
    durationMs?: number,
  ) => void;
  setStatus: (
    stepId: string,
    status: TaskStatus,
    error?: string | null,
    taskId?: string,
  ) => void;
  setPermission: (
    stepId: string,
    permission: TaskState['pendingPermission'],
  ) => void;
  setQuestion: (stepId: string, question: TaskState['pendingQuestion']) => void;
  updateQuestionDraft: (
    key: string,
    update: (draft: QuestionDraft) => QuestionDraft,
  ) => void;
  clearQuestionDraft: (key: string, expected?: QuestionDraft | null) => void;
  tryStartQuestionResponse: (key: string) => boolean;
  finishQuestionResponse: (key: string) => void;
  setQueuedPrompts: (stepId: string, queuedPrompts: QueuedPrompt[]) => void;
  setBackgroundTasks: (stepId: string, tasks: AgentBackgroundTask[]) => void;
  appendRunCommandLogBatch: (
    taskId: string,
    runCommandId: string,
    stream: RunCommandLogStream,
    text: string,
    generation: number,
  ) => void;
  clearRunCommandLogs: (taskId: string, runCommandId: string) => void;
  resetRunCommandLogs: (taskId: string, runCommandId: string) => number;
  applyRunCommandLogsReset: (
    taskId: string,
    runCommandId: string,
    generation: number,
  ) => void;
  clearAllRunCommandLogs: (taskId: string) => void;
  setRunCommandRunning: (taskId: string, status: RunStatus | false) => void;
  setRunCommandStatusesHydrated: (hydrated: boolean) => void;
  /** `stepId` is the step owning the request; omit only when unknown. */
  setPendingRequestForTask: (args: {
    taskId: string;
    request: PendingRequest;
    stepId?: string;
  }) => void;
  clearPendingRequestForTask: (args: {
    taskId: string;
    stepId?: string;
  }) => void;
  touchStep: (stepId: string) => void;
  unloadStep: (stepId: string) => void;

  // Selectors
  isLoaded: (stepId: string) => boolean;
  getRunningStepIds: () => string[];
}

export const DEFAULT_CACHE_LIMIT = 25;

/**
 * Message-stream scroll offsets, keyed by stepId — same key space and same
 * lifetime as `steps`, so eviction/unload below drops them too.
 *
 * Deliberately outside the Zustand state: offsets change on every wheel tick
 * and must never trigger a re-render of the stream we are scrolling.
 */
const stepScrollPositions = new Map<string, number>();

export function getStepScrollPosition(stepId: string): number | undefined {
  return stepScrollPositions.get(stepId);
}

export function setStepScrollPosition(stepId: string, offset: number): void {
  stepScrollPositions.set(stepId, offset);
}

/** Forget an offset (e.g. the user is parked at the bottom again). */
export function clearStepScrollPosition(stepId: string): void {
  stepScrollPositions.delete(stepId);
}

/**
 * Drop offsets for steps evicted from the message cache. Only the evicted ids
 * are removed — a step can be briefly absent from `steps` while refetching
 * (unloadStep + reload), and its offset must survive that window.
 */
function pruneScrollPositions(evictedStepIds: Iterable<string>): void {
  for (const stepId of evictedStepIds) stepScrollPositions.delete(stepId);
}

function evictIfNeeded(
  steps: Record<string, TaskState>,
  cacheLimit: number,
): Record<string, TaskState> {
  const entries = Object.entries(steps);
  const inactiveSteps = entries.filter(
    ([, state]) => state.status !== 'running',
  );

  if (inactiveSteps.length <= cacheLimit) {
    return steps;
  }

  // Sort by lastAccessedAt ascending (oldest first)
  inactiveSteps.sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);

  const toEvict = inactiveSteps.length - cacheLimit;
  const idsToEvict = new Set(inactiveSteps.slice(0, toEvict).map(([id]) => id));

  // Collect taskIds of evicted steps
  const evictedTaskIds = new Set<string>();

  const newSteps: Record<string, TaskState> = {};
  for (const [id, state] of entries) {
    if (!idsToEvict.has(id)) {
      newSteps[id] = state;
    } else {
      evictedTaskIds.add(state.taskId);
    }
  }

  // Saved scroll offsets for evicted steps are no longer meaningful
  pruneScrollPositions(idsToEvict);

  // Clear review comments for tasks that have no remaining loaded steps
  for (const taskId of evictedTaskIds) {
    const hasRemainingSteps = Object.values(newSteps).some(
      (s) => s.taskId === taskId,
    );
    if (!hasRemainingSteps) {
      clearReviewCommentsForTask(taskId);
    }
  }

  return newSteps;
}

function appendLinesToChunks({
  chunks,
  lines,
  runCommandId,
}: {
  chunks: RunCommandLogChunk[];
  lines: RunCommandLogLine[];
  runCommandId: string;
}): RunCommandLogChunk[] {
  if (lines.length === 0) return chunks;

  const nextChunks = chunks.slice();
  let current = nextChunks[nextChunks.length - 1];

  for (const line of lines) {
    if (!current || current.lineCount >= RUN_COMMAND_LOG_CHUNK_LINE_LIMIT) {
      current = {
        id: `${runCommandId}:${Date.now()}:${nextChunks.length}`,
        lines: [],
        lineCount: 0,
      };
      nextChunks.push(current);
    }

    current = {
      ...current,
      lines: [...current.lines, line],
      lineCount: current.lineCount + 1,
    };
    nextChunks[nextChunks.length - 1] = current;
  }

  return nextChunks;
}

function capLogChunks({
  chunks,
  totalLineCount,
}: {
  chunks: RunCommandLogChunk[];
  totalLineCount: number;
}): { chunks: RunCommandLogChunk[]; totalLineCount: number } {
  let nextChunks = chunks;
  let nextLineCount = totalLineCount;

  while (
    nextLineCount > MAX_RUN_COMMAND_LOG_LINES &&
    nextChunks.length > 1 &&
    nextLineCount - nextChunks[0].lineCount >= MAX_RUN_COMMAND_LOG_LINES
  ) {
    const [removed, ...rest] = nextChunks;
    nextChunks = rest;
    nextLineCount -= removed.lineCount;
  }

  if (nextLineCount > MAX_RUN_COMMAND_LOG_LINES && nextChunks.length > 0) {
    const excess = nextLineCount - MAX_RUN_COMMAND_LOG_LINES;
    const [chunk, ...rest] = nextChunks;
    const lines = chunk.lines.slice(excess);
    nextChunks = [{ ...chunk, lines, lineCount: lines.length }, ...rest];
    nextLineCount = MAX_RUN_COMMAND_LOG_LINES;
  }

  return { chunks: nextChunks, totalLineCount: nextLineCount };
}

function shouldKeepExistingEntry({
  existing,
  next,
}: {
  existing: NormalizedEntry;
  next: NormalizedEntry;
}): boolean {
  if (
    (existing.type === 'assistant-message' ||
      existing.type === 'thinking' ||
      existing.type === 'user-prompt') &&
    existing.type === next.type &&
    next.value.length < existing.value.length &&
    existing.value.startsWith(next.value)
  ) {
    return true;
  }

  if (
    existing.type === 'tool-use' &&
    next.type === 'tool-use' &&
    'result' in existing &&
    existing.result !== undefined &&
    (!('result' in next) || next.result === undefined)
  ) {
    return true;
  }

  return false;
}

export const useTaskMessagesStore = create<TaskMessagesStore>((set, get) => ({
  steps: {},
  pendingRequestsByTaskId: {},
  backgroundTasksByStepId: {},
  backgroundTasksVersions: {},
  pendingRequestVersions: {},
  runCommandLogs: {},
  runCommandLogGenerations: {},
  runCommandRunning: {},
  questionDrafts: {},
  questionResponsesInFlight: {},
  areRunCommandStatusesHydrated: false,
  cacheLimit: DEFAULT_CACHE_LIMIT,

  loadStep: (stepId, taskId, messages, status) => {
    set((state) => {
      const newSteps = {
        ...state.steps,
        [stepId]: {
          taskId,
          messages,
          status,
          error: null,
          pendingPermission: null,
          pendingQuestion: null,
          queuedPrompts: [],
          lastAccessedAt: Date.now(),
        },
      };
      return { steps: evictIfNeeded(newSteps, state.cacheLimit) };
    });
  },

  applyEntryBatch: (updates) => {
    if (updates.length === 0) return;

    set((state) => {
      let changed = false;
      const nextSteps = { ...state.steps };

      for (const update of updates) {
        const step = nextSteps[update.stepId];
        if (!step) continue;

        let updatedMessages: NormalizedEntry[];
        if (update.mode === 'append') {
          const idx = step.messages.findIndex((m) => m.id === update.entry.id);
          if (idx !== -1) {
            const existing = step.messages[idx];
            if (shouldKeepExistingEntry({ existing, next: update.entry })) {
              continue;
            }
            updatedMessages = [...step.messages];
            updatedMessages[idx] = update.entry;
          } else {
            updatedMessages = [...step.messages, update.entry];
          }
        } else {
          const idx = step.messages.findIndex((m) => m.id === update.entry.id);
          if (idx !== -1) {
            const existing = step.messages[idx];
            if (shouldKeepExistingEntry({ existing, next: update.entry })) {
              continue;
            }
            updatedMessages = [...step.messages];
            updatedMessages[idx] = update.entry;
          } else {
            updatedMessages = [...step.messages, update.entry];
          }
        }

        nextSteps[update.stepId] = {
          ...step,
          messages: updatedMessages,
        };
        changed = true;
      }

      if (!changed) return state;
      return { steps: nextSteps };
    });
  },

  addEntry: (stepId, entry) => {
    set((state) => {
      const step = state.steps[stepId];
      if (!step) return state;
      return {
        steps: {
          ...state.steps,
          [stepId]: {
            ...step,
            messages: [...step.messages, entry],
          },
        },
      };
    });
  },

  updateEntry: (stepId, entry) => {
    set((state) => {
      const step = state.steps[stepId];
      if (!step) return state;
      const idx = step.messages.findIndex((m) => m.id === entry.id);
      let updatedMessages: NormalizedEntry[];
      if (idx !== -1) {
        updatedMessages = [...step.messages];
        updatedMessages[idx] = entry;
      } else {
        updatedMessages = [...step.messages, entry];
      }
      return {
        steps: {
          ...state.steps,
          [stepId]: { ...step, messages: updatedMessages },
        },
      };
    });
  },

  updateToolResult: (stepId, toolId, result, _isError, _durationMs) => {
    set((state) => {
      const step = state.steps[stepId];
      if (!step) return state;
      const idx = step.messages.findIndex(
        (m) => m.type === 'tool-use' && 'toolId' in m && m.toolId === toolId,
      );
      if (idx === -1) return state;
      const entry = step.messages[idx] as NormalizedEntry;
      if (entry.type !== 'tool-use') return state;
      // MCP results should be objects — wrap plain text in { content } to stay
      // consistent with the primary entry-update path in the normalizer.
      const patchedResult =
        entry.name === 'mcp' && typeof result === 'string'
          ? (tryParseJsonObject(result) ?? { content: result })
          : result;
      const patched = { ...entry, result: patchedResult } as NormalizedEntry;
      const updatedMessages = [...step.messages];
      updatedMessages[idx] = patched;
      return {
        steps: {
          ...state.steps,
          [stepId]: { ...step, messages: updatedMessages },
        },
      };
    });
  },

  setStatus: (stepId, status, error = null, taskId) => {
    set((state) => {
      const step = state.steps[stepId];
      const shouldClearPending = clearsPendingRequests(status);
      const resolvedTaskId = taskId ?? step?.taskId;
      const questionState =
        shouldClearPending && resolvedTaskId
          ? removeQuestionStateForTask(
              state,
              resolvedTaskId,
              // Only this step finished — sibling steps of the same task may
              // still be showing a question the user is part-way through
              // answering, so their drafts must survive.
              getLiveQuestionDraftKeys(state, resolvedTaskId, stepId),
            )
          : null;
      if (!step) {
        if (!taskId) return state;
        return {
          steps: {
            ...state.steps,
            [stepId]: {
              taskId,
              messages: [],
              status,
              error,
              pendingPermission: null,
              pendingQuestion: null,
              queuedPrompts: [],
              lastAccessedAt: Date.now(),
            },
          },
          ...(shouldClearPending && bumpStepRequestVersion(state, stepId)),
          ...(questionState ?? {}),
        };
      }
      return {
        steps: {
          ...state.steps,
          [stepId]: {
            ...step,
            status,
            error,
            ...(shouldClearPending && {
              pendingPermission: null,
              pendingQuestion: null,
            }),
          },
        },
        ...(shouldClearPending && bumpStepRequestVersion(state, stepId)),
        ...(questionState ?? {}),
      };
    });
  },

  setPermission: (stepId, permission) => {
    set((state) => {
      const step = state.steps[stepId];
      if (!step) return state;
      return {
        steps: {
          ...state.steps,
          [stepId]: {
            ...step,
            pendingPermission: permission,
          },
        },
        ...bumpStepRequestVersion(state, stepId),
      };
    });
  },

  setQuestion: (stepId, question) => {
    set((state) => {
      const step = state.steps[stepId];
      if (!step) return state;
      // Drafts belonging to questions still pending on sibling steps of this
      // task are preserved — only this step's own stale drafts are pruned.
      const keepKeys = getLiveQuestionDraftKeys(state, step.taskId, stepId);
      if (question) {
        keepKeys.add(getQuestionDraftKey(question.taskId, question.requestId));
      }
      const questionState = removeQuestionStateForTask(
        state,
        step.taskId,
        keepKeys,
      );
      return {
        steps: {
          ...state.steps,
          [stepId]: {
            ...step,
            pendingQuestion: question,
          },
        },
        ...bumpStepRequestVersion(state, stepId),
        ...questionState,
      };
    });
  },

  updateQuestionDraft: (key, update) => {
    set((state) => {
      const current = state.questionDrafts[key] ?? {
        answers: {},
        otherAnswers: {},
        notes: {},
      };
      return {
        questionDrafts: {
          // Typing in one step's banner must not drop a sibling step's draft.
          ...removeQuestionStateForTask(state, getQuestionTaskId(key), [
            ...getLiveQuestionDraftKeys(state, getQuestionTaskId(key)),
            key,
          ]).questionDrafts,
          [key]: update(current),
        },
      };
    });
  },

  clearQuestionDraft: (key, expected) => {
    set((state) => {
      if (
        expected !== undefined &&
        (expected === null
          ? state.questionDrafts[key] !== undefined
          : state.questionDrafts[key] !== expected)
      ) {
        return state;
      }
      const { [key]: _removed, ...rest } = state.questionDrafts;
      void _removed;
      return { questionDrafts: rest };
    });
  },

  tryStartQuestionResponse: (key) => {
    if (get().questionResponsesInFlight[key]) return false;
    set((state) => ({
      questionResponsesInFlight: {
        ...state.questionResponsesInFlight,
        [key]: true,
      },
    }));
    return true;
  },

  finishQuestionResponse: (key) => {
    set((state) => {
      if (!state.questionResponsesInFlight[key]) return state;
      const { [key]: _removed, ...rest } = state.questionResponsesInFlight;
      void _removed;
      return { questionResponsesInFlight: rest };
    });
  },

  setQueuedPrompts: (stepId, queuedPrompts) => {
    set((state) => {
      const step = state.steps[stepId];
      if (!step) return state;
      return {
        steps: {
          ...state.steps,
          [stepId]: {
            ...step,
            queuedPrompts,
          },
        },
      };
    });
  },

  setBackgroundTasks: (stepId, tasks) => {
    set((state) => {
      const bumpVersion = {
        backgroundTasksVersions: {
          ...state.backgroundTasksVersions,
          [stepId]: (state.backgroundTasksVersions[stepId] ?? 0) + 1,
        },
      };
      const current = state.backgroundTasksByStepId[stepId];
      if (tasks.length === 0) {
        if (!current) return bumpVersion;
        const { [stepId]: _removed, ...rest } = state.backgroundTasksByStepId;
        void _removed;
        return { ...bumpVersion, backgroundTasksByStepId: rest };
      }
      // Identity check keeps the array reference stable across no-op
      // snapshots. Compares every field, so a description that arrives late
      // for an already-known task still updates the UI.
      if (
        current &&
        current.length === tasks.length &&
        current.every(
          (task, index) =>
            task.taskId === tasks[index]?.taskId &&
            task.description === tasks[index]?.description &&
            task.taskType === tasks[index]?.taskType,
        )
      ) {
        return bumpVersion;
      }
      return {
        ...bumpVersion,
        backgroundTasksByStepId: {
          ...state.backgroundTasksByStepId,
          [stepId]: tasks,
        },
      };
    });
  },

  appendRunCommandLogBatch: (
    taskId,
    runCommandId,
    stream,
    text,
    generation,
  ) => {
    set((state) => {
      const now = Date.now();
      const currentGeneration =
        state.runCommandLogGenerations[taskId]?.[runCommandId] ?? 0;
      if (generation < currentGeneration) return state;

      const taskLogs = state.runCommandLogs[taskId] ?? {};
      const existingLog = taskLogs[runCommandId] ?? {
        chunks: [],
        pendingLines: { stdout: null, stderr: null },
        trailingText: { stdout: '', stderr: '' },
        totalLineCount: 0,
        updatedAt: now,
        version: 0,
      };

      const parsed = parseRunCommandLogBatch({
        trailingText: existingLog.trailingText[stream],
        stream,
        text,
        timestamp: now,
      });
      const chunks = appendLinesToChunks({
        chunks: existingLog.chunks,
        lines: parsed.completedLines,
        runCommandId,
      });
      const capped = capLogChunks({
        chunks,
        totalLineCount:
          existingLog.totalLineCount + parsed.completedLines.length,
      });

      return {
        runCommandLogs: {
          ...state.runCommandLogs,
          [taskId]: {
            ...taskLogs,
            [runCommandId]: {
              chunks: capped.chunks,
              pendingLines: {
                ...existingLog.pendingLines,
                [stream]: parsed.pendingLine,
              },
              trailingText: {
                ...existingLog.trailingText,
                [stream]: parsed.trailingText,
              },
              totalLineCount: capped.totalLineCount,
              updatedAt: now,
              version: existingLog.version + 1,
            },
          },
        },
      };
    });
  },

  clearRunCommandLogs: (taskId, runCommandId) => {
    set((state) => {
      const taskLogs = state.runCommandLogs[taskId];
      if (!taskLogs) return state;

      const { [runCommandId]: _removed, ...restLogs } = taskLogs;
      void _removed;

      return {
        runCommandLogs: {
          ...state.runCommandLogs,
          [taskId]: restLogs,
        },
      };
    });
  },

  resetRunCommandLogs: (taskId, runCommandId) => {
    const currentGeneration =
      get().runCommandLogGenerations[taskId]?.[runCommandId] ?? 0;
    const nextGeneration = Math.max(currentGeneration + 1, Date.now());

    set((state) => {
      const taskLogs = state.runCommandLogs[taskId];
      const restLogs = taskLogs
        ? Object.fromEntries(
            Object.entries(taskLogs).filter(([id]) => id !== runCommandId),
          )
        : {};

      return {
        runCommandLogs: {
          ...state.runCommandLogs,
          [taskId]: restLogs,
        },
        runCommandLogGenerations: {
          ...state.runCommandLogGenerations,
          [taskId]: {
            ...(state.runCommandLogGenerations[taskId] ?? {}),
            [runCommandId]: nextGeneration,
          },
        },
      };
    });

    return nextGeneration;
  },

  applyRunCommandLogsReset: (taskId, runCommandId, generation) => {
    set((state) => {
      const currentGeneration =
        state.runCommandLogGenerations[taskId]?.[runCommandId] ?? 0;
      if (generation < currentGeneration) return state;

      const taskLogs = state.runCommandLogs[taskId];
      const restLogs = taskLogs
        ? Object.fromEntries(
            Object.entries(taskLogs).filter(([id]) => id !== runCommandId),
          )
        : {};

      return {
        runCommandLogs: {
          ...state.runCommandLogs,
          [taskId]: restLogs,
        },
        runCommandLogGenerations: {
          ...state.runCommandLogGenerations,
          [taskId]: {
            ...(state.runCommandLogGenerations[taskId] ?? {}),
            [runCommandId]: generation,
          },
        },
      };
    });
  },

  clearAllRunCommandLogs: (taskId) => {
    set((state) => {
      if (!state.runCommandLogs[taskId]) return state;

      const { [taskId]: _removedLogs, ...restLogs } = state.runCommandLogs;
      const { [taskId]: _removedGenerations, ...restGenerations } =
        state.runCommandLogGenerations;
      void _removedLogs;
      void _removedGenerations;

      return {
        runCommandLogs: restLogs,
        runCommandLogGenerations: restGenerations,
      };
    });
  },

  setRunCommandRunning: (taskId, status) => {
    set((state) => {
      if (!status && !state.runCommandRunning[taskId]) {
        return state;
      }
      if (!status) {
        const { [taskId]: _removed, ...rest } = state.runCommandRunning;
        void _removed;
        return { runCommandRunning: rest };
      }
      // Skip update if command list is unchanged
      const existing = state.runCommandRunning[taskId];
      if (existing) {
        const prev = existing.commands;
        const next = status.commands;
        if (
          prev.length === next.length &&
          prev.every(
            (c, i) =>
              c.id === next[i].id &&
              c.name === next[i].name &&
              c.command === next[i].command &&
              areRunCommandPortsEqual(c.ports, next[i].ports) &&
              c.status === next[i].status,
          )
        ) {
          return state;
        }
      }
      return {
        runCommandRunning: {
          ...state.runCommandRunning,
          [taskId]: status,
        },
      };
    });
  },
  setRunCommandStatusesHydrated: (hydrated) =>
    set((state) =>
      state.areRunCommandStatusesHydrated === hydrated
        ? state
        : { areRunCommandStatusesHydrated: hydrated },
    ),

  setPendingRequestForTask: ({ taskId, stepId, request }) => {
    set((state) => ({
      pendingRequestsByTaskId: {
        ...state.pendingRequestsByTaskId,
        [taskId]: stepId ? { ...request, stepId } : request,
      },
      // Bump only the owning step. Bumping task-wide (or inferring the step set
      // from `state.steps`, which misses steps unloaded mid-refetch) would
      // discard a sibling step's in-flight fetch.
      ...(stepId ? bumpStepRequestVersion(state, stepId) : {}),
    }));
  },

  clearPendingRequestForTask: ({ taskId, stepId }) => {
    set((state) => {
      const versions = stepId ? bumpStepRequestVersion(state, stepId) : {};
      if (!state.pendingRequestsByTaskId[taskId]) {
        return { ...state, ...versions };
      }
      // A sibling step may still be waiting on the user — hand the slot over to
      // it rather than dropping the task's attention entirely.
      const live = findLivePendingRequestForTask(state, taskId, stepId);
      if (live) {
        return {
          pendingRequestsByTaskId: {
            ...state.pendingRequestsByTaskId,
            [taskId]: live,
          },
          ...versions,
        };
      }
      const { [taskId]: _removed, ...rest } = state.pendingRequestsByTaskId;
      void _removed;
      return {
        pendingRequestsByTaskId: rest,
        ...versions,
      };
    });
  },

  touchStep: (stepId) => {
    set((state) => {
      const step = state.steps[stepId];
      if (!step) return state;
      return {
        steps: {
          ...state.steps,
          [stepId]: {
            ...step,
            lastAccessedAt: Date.now(),
          },
        },
      };
    });
  },

  unloadStep: (stepId) => {
    set((state) => {
      const { [stepId]: _removed, ...rest } = state.steps;
      void _removed; // Intentionally unused - destructuring to exclude from rest
      // Scroll offsets are intentionally NOT dropped here: unloadStep doubles
      // as "invalidate and refetch" for the step the user is currently looking
      // at, and losing the offset there would be a visible regression. Offsets
      // for steps that never come back are reaped by pruneScrollPositions on
      // the next load.
      return { steps: rest };
    });
  },

  isLoaded: (stepId) => !!get().steps[stepId],

  getRunningStepIds: () =>
    Object.entries(get().steps)
      .filter(([, state]) => state.status === 'running')
      .map(([id]) => id),
}));

function tryParseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // not JSON
  }
  return null;
}
