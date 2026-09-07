// Claude Code Agent SDK adapter.
// Wraps the @anthropic-ai/claude-agent-sdk `query()` function
// into the common AgentBackend interface.
//
// Architecture note: The SDK's `canUseTool` callback is invoked during the
// async generator iteration. When the callback is pending (waiting for user
// response), the SDK generator blocks — no new messages are yielded.
//
// We use an AsyncEventChannel to merge SDK messages with permission/question
// events. The channel allows `handleToolRequest` to push events that are
// immediately available to the consumer (agent-service), even while the SDK
// generator is blocked waiting for the canUseTool promise to resolve.

import {
  type CanUseTool,
  type PermissionResult,
  query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { nanoid } from 'nanoid';



import type {
  AgentBackend,
  AgentBackendConfig,
  AgentEvent,
  AgentSession,
  AgentTaskContext,
  NormalizedPermissionRequest,
  NormalizedPermissionResponse,
  NormalizedQuestion,
  NormalizedQuestionRequest,
  PromptPart,
} from '@shared/agent-backend-types';
import type {
  AgentBackgroundTask,
  AgentMessage,
  AgentQuestion,
  QuestionResponseMetadata,
} from '@shared/agent-types';
import type { InteractionMode } from '@shared/types';

import {
  buildDirectoryAccess,
  getAllowedDirectories,
  toDirectoryPermissionPattern,
} from '../../directory-access';
import {
  buildPromptMarkdown,
  getPromptImages,
  getPromptText,
} from '../../prompt-utils';
import {
  evaluatePermissionWithMatch,
  flattenScope,
  normalizeToolRequest,
} from '../../permission-settings-service';
import { dbg } from '../../../lib/debug';
import { getChildProcessEnv } from '../../../lib/child-process-env';
import type { ResolvedPermissionRule } from '../../../../shared/permission-types';



import type { NormalizationContext } from './normalize-claude-message-v2';
import { normalizeClaudeMessageV2 } from './normalize-claude-message-v2';


const SDK_PERMISSION_MODES = {
  ask: 'default',
  auto: 'bypassPermissions',
  plan: 'plan',
} as const;

// --- Async event channel ---
// Push-based async iterable: events pushed from any async context are
// immediately available to the consumer via `for await`.

class AsyncEventChannel<T> {
  private queue: T[] = [];
  private waiter: ((value: IteratorResult<T>) => void) | null = null;
  private closed = false;

  push(item: T) {
    if (this.closed) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  close() {
    this.closed = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({
            value: this.queue.shift()!,
            done: false as const,
          });
        }
        if (this.closed) {
          return Promise.resolve({
            value: undefined as unknown as T,
            done: true as const,
          });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

interface PendingResolver {
  type: 'permission' | 'question';
  toolName: string;
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
}

/**
 * Build the wire-shape user message the CLI expects on its streaming stdin.
 * Shared by the initial prompt of a run and by mid-run follow-up injection.
 */
function buildSdkUserMessage(
  parts: PromptPart[],
  sessionId: string | null,
): SDKUserMessage {
  const promptText = getPromptText(parts);
  const images = getPromptImages(parts);

  const content: Array<
    | { type: 'text'; text: string }
    | {
        type: 'image';
        source: { type: 'base64'; media_type: string; data: string };
      }
  > = [];

  // Always emit the text block, even when empty: this mirrors what the SDK
  // itself writes for a bare-string prompt, and an empty `content` array is a
  // different wire shape that the CLI may reject.
  if (promptText || images.length === 0) {
    content.push({ type: 'text', text: promptText });
  }

  for (const img of images) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mimeType,
        data: img.data,
      },
    });
  }

  return {
    type: 'user',
    message: {
      role: 'user',
      content: content as SDKUserMessage['message']['content'],
    },
    parent_tool_use_id: null,
    session_id: sessionId ?? '',
  };
}

interface ClaudeSession {
  sessionId: string | null;
  abortController: AbortController;
  queryInstance: ReturnType<typeof query> | null;
  // Callbacks for pending permission/question requests
  pendingResolvers: Map<string, PendingResolver>;
  // Push-based event channel for merging SDK messages with permission/question events
  eventChannel: AsyncEventChannel<AgentEvent>;
  // Session-allowed tools (accumulated during this session)
  sessionAllowedTools: string[];
  // Working directory for permission checking
  workingDir?: string;
  // Backend-agnostic permission rules for runtime evaluation
  permissionRules: ResolvedPermissionRule[];
  // V2 normalization context (tracks session-id state)
  normalizationCtx: NormalizationContext;
  // Next raw message index for persistence ordering
  messageIndex: number;
  // Events from a background-task-notification `result` that were withheld so
  // they don't finalize the turn while background work keeps streaming. Pushed
  // at stream end if no real result arrives after them.
  deferredResultEvents: AgentEvent[] | null;
  // Ends the streaming-input generator, which lets the SDK close the CLI's
  // stdin. Held open for the whole turn so the `canUseTool` control channel
  // survives background-task `result` messages.
  closePromptStream: (() => void) | null;
  // Appends another user message to the streaming input of the live run, so a
  // follow-up prompt continues this run instead of requiring a stop/restart
  // (which would kill any background tasks the run still owns). Returns false
  // once the input stream has closed.
  pushPromptMessage: ((message: SDKUserMessage) => boolean) | null;
  // Task ids of background work (subagents, background bash, Monitor) still
  // live, from the latest `background_tasks_changed` snapshot. While non-empty,
  // no `result` can end the run — the agent will be resumed to handle their
  // notifications, and closing stdin would kill the `canUseTool` channel.
  backgroundTaskIds: Set<string>;
}

/**
 * A `result` emitted because a background task (background bash, Monitor,
 * background subagent) notified the agent. It reports a zero-turn no-op, not
 * the end of the user's turn — finalizing on it marks the step completed while
 * the agent is still working.
 */
/**
 * How long the SDK stream may stay silent after a withheld background-task
 * `result` before we assume nothing more is coming and close the input stream.
 * Generous on purpose: background work (long builds, Monitor polls) reports
 * back sporadically, and closing early would truncate a live run.
 */
const WITHHELD_RESULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

function isBackgroundNotificationResult(message: AgentMessage): boolean {
  if (message.type !== 'result') return false;
  // Origins other than a human prompt (`task-notification`, `auto-continuation`,
  // `observer`, …) never end the user's turn.
  const origin = message.origin?.kind;
  if (!origin || origin === 'human') return false;
  // A notification-triggered turn that actually did work still reports a real
  // turn end; only the zero-turn no-op is withheld.
  return !message.num_turns;
}

/**
 * Grace period between a `result` and closing the CLI's stdin.
 *
 * NO property of a `result` message reliably means "the run is over". Both
 * directions are disproven by one real transcript:
 *
 *   idx 427  result, `origin` ABSENT, num_turns 17, 11 background tasks live
 *            -> looked like a human end-of-turn; the run continued 25 minutes
 *   idx 1164 result, origin `task-notification`, num_turns 1, 0 tasks live
 *            -> looked like a real end-of-turn; the run continued 20 minutes
 *
 * stdin is the `canUseTool` control channel, so closing it early kills every
 * later permission request ("Tool permission request failed: AbortError:
 * Stream closed" — 44 of them in that transcript, none before idx 427).
 *
 * So stop classifying. Silence is the only trustworthy end-of-run signal: after
 * a `result`, wait a beat, and let ANY further message cancel the close. A run
 * that is genuinely finished emits nothing more and closes on schedule; a run
 * that keeps working keeps its control channel. This costs a short-lived idle
 * CLI process at the end of a turn and nothing else — the `result` events are
 * still emitted immediately, so the step finalizes in the UI exactly as before.
 */
const POST_RESULT_CLOSE_GRACE_MS = 30 * 1000;

/**
 * Longer grace while background work (subagents, background bash, Monitor) is
 * live: those report back sporadically, and a notification can resume the agent
 * long after the `result`. Bounded on purpose — an unbounded wait would hang a
 * run whose background task never terminates.
 *
 * 10 minutes, not 5: every message re-arms this timer, so the cap only bites on
 * TOTAL silence, and a real transcript already showed a 4m21s quiet stretch
 * mid-run (a Monitor on a long poll or a subagent on a slow build goes quiet for
 * longer still). Closing early kills the `canUseTool` channel, so the resumed
 * agent fails every later tool call with "AbortError: Stream closed" — the cost
 * of waiting longer is one idle CLI process, which is far cheaper. Matches
 * WITHHELD_RESULT_IDLE_TIMEOUT_MS so both silence-based exits agree.
 */
const BACKGROUND_WORK_CLOSE_GRACE_MS = 10 * 60 * 1000;

/**
 * Live background tasks reported by a `background_tasks_changed` system
 * message.
 *
 * The SDK documents this as REPLACE semantics ("swap your set for this
 * payload"), so it replaces the tracked set wholesale. A malformed or missing
 * `tasks` array is treated as an empty snapshot rather than "no update":
 * retaining a stale non-empty set would silently extend every close grace to
 * the maximum for the rest of the run.
 */
function readBackgroundTaskSnapshot(
  message: AgentMessage,
): AgentBackgroundTask[] | null {
  if (message.type !== 'system') return null;
  const system = message as unknown as {
    subtype?: string;
    tasks?: Array<{
      task_id?: string;
      description?: string;
      task_type?: string;
    }>;
  };
  if (system.subtype !== 'background_tasks_changed') return null;
  if (!Array.isArray(system.tasks)) return [];
  return system.tasks
    .filter((task) => typeof task.task_id === 'string')
    .map((task) => ({
      taskId: task.task_id as string,
      ...(typeof task.description === 'string'
        ? { description: task.description }
        : {}),
      ...(typeof task.task_type === 'string'
        ? { taskType: task.task_type }
        : {}),
    }));
}

export class ClaudeCodeBackend implements AgentBackend {
  private sessions = new Map<string, ClaudeSession>();
  private taskContext: AgentTaskContext;

  static async compactRawMessagesForTask(_taskId: string): Promise<void> {
    // Claude raw events are already coarse enough for storage.
  }

  constructor(context: AgentTaskContext) {
    this.taskContext = context;
  }

  async start(
    config: AgentBackendConfig,
    parts: PromptPart[],
  ): Promise<AgentSession> {
    const sessionKey = nanoid();
    const abortController = new AbortController();

    // Build initial session-allowed list from persisted task rules.
    // Keep canonical entries ("tool" | "tool:pattern") because runtime checks
    // in handleToolRequest use canonical format.
    const rules = config.permissionRules ?? [];
    const persistedRules = config.persistedSessionRules ?? {};
    const persistedAllow = flattenScope(persistedRules)
      .filter((rule) => rule.action === 'allow')
      .map((rule) =>
        rule.pattern === '*' ? rule.tool : `${rule.tool}:${rule.pattern}`,
      );
    const initialSessionAllowedTools = [...new Set(persistedAllow)];

    const session: ClaudeSession = {
      sessionId: config.sessionId ?? null,
      abortController,
      queryInstance: null,
      pendingResolvers: new Map(),
      eventChannel: new AsyncEventChannel<AgentEvent>(),
      sessionAllowedTools: initialSessionAllowedTools,
      workingDir: config.cwd,
      permissionRules: rules,
      normalizationCtx: {
        sessionIdEmitted: false,
        pendingToolUses: new Map(),
        permissionRules: rules,
      },
      messageIndex: this.taskContext.sessionStartIndex,
      deferredResultEvents: null,
      backgroundTaskIds: new Set<string>(),
      closePromptStream: null,
      pushPromptMessage: null,
    };
    this.sessions.set(sessionKey, session);

    // Start processing the SDK generator in the background.
    // Events are pushed to the channel and consumed by agent-service.
    this.runSdkGenerator(config, parts, session, sessionKey);

    return {
      sessionId: sessionKey,
      events: session.eventChannel,
    };
  }

  /**
   * Continue a live run with another user prompt instead of stopping it.
   *
   * Only works while the run's streaming input is still open. That window is
   * exactly the one that matters here: a run holding background tasks keeps
   * stdin open past its `result`, and stopping it to send a follow-up would
   * take those background tasks down with the CLI process.
   */
  async sendUserMessage(
    sessionId: string,
    parts: PromptPart[],
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    const push = session?.pushPromptMessage;
    if (!session || !push) return false;
    const accepted = push(buildSdkUserMessage(parts, session.sessionId));
    if (!accepted) return false;

    // Emit the same synthetic entry `runSdkGenerator` pushes for a run's
    // initial prompt. Without it the user's follow-up never reaches the
    // timeline, so no new prompt group opens — the prompt would be invisible in
    // the stream and absent from history on reload, and the live background
    // jobs (which render against the LAST prompt group) would stay pinned under
    // the previous one. Pushing it here makes an injected prompt behave exactly
    // like the start of a run.
    //
    // Emitted only after the push is accepted, so a refused injection can't
    // leave an orphan prompt in the timeline.
    session.eventChannel.push({
      type: 'entry',
      rawMessageId: null,
      entry: {
        id: nanoid(),
        date: new Date().toISOString(),
        isSynthetic: true,
        type: 'user-prompt',
        value: buildPromptMarkdown(parts),
      },
    });
    return true;
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.abortController.abort();
    session.closePromptStream?.();

    // Reject all pending resolvers
    for (const [, resolver] of session.pendingResolvers) {
      resolver.resolve({ behavior: 'deny', message: 'Session stopped' });
    }
    session.pendingResolvers.clear();

    // Close the channel so the consumer (agent-service) finishes iterating
    session.eventChannel.close();

    this.sessions.delete(sessionId);
  }

  async respondToPermission(
    sessionId: string,
    requestId: string,
    response: NormalizedPermissionResponse,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`No Claude session: ${sessionId}`);
    }

    const resolver = session.pendingResolvers.get(requestId);
    if (!resolver) {
      throw new Error(`No pending request: ${requestId}`);
    }

    // Handle session-level tool allow
    if (response.toolsToAllow) {
      session.sessionAllowedTools.push(...response.toolsToAllow);
    }
    if (response.allowedDirectory) {
      session.sessionAllowedTools.push(
        `external_directory:${toDirectoryPermissionPattern(response.allowedDirectory)}`,
      );
    }

    session.pendingResolvers.delete(requestId);

    if (response.behavior === 'allow') {
      resolver.resolve({
        behavior: 'allow',
        updatedInput: response.updatedInput,
        ...(response.allowedDirectory
          ? {
              updatedPermissions: [
                {
                  type: 'addDirectories' as const,
                  directories: [response.allowedDirectory],
                  destination: 'session' as const,
                },
              ],
            }
          : {}),
      });
    } else {
      resolver.resolve({
        behavior: 'deny',
        message: response.message ?? 'Denied by user',
      });
    }
  }

  async respondToQuestion(
    sessionId: string,
    requestId: string,
    answer: Record<string, string>,
    _metadata: QuestionResponseMetadata,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`No Claude session: ${sessionId}`);
    }

    const resolver = session.pendingResolvers.get(requestId);
    if (!resolver) {
      throw new Error(`No pending request: ${requestId}`);
    }

    session.pendingResolvers.delete(requestId);
    // For questions, we return the answer as updatedInput with behavior: allow
    // This matches how the original agent-service handled AskUserQuestion
    resolver.resolve({
      behavior: 'allow',
      updatedInput: {
        questions: resolver.input.questions,
        answers: answer,
      },
    });
  }

  async setMode(sessionId: string, mode: InteractionMode): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session?.queryInstance) {
      await session.queryInstance.setPermissionMode(SDK_PERMISSION_MODES[mode]);
    }
  }

  /**
   * Replace the permission-rule snapshot used by `canUseTool` evaluation.
   * Safe to call while a run is in flight.
   */
  updatePermissionRules({
    sessionId,
    rules,
  }: {
    sessionId: string;
    rules: ResolvedPermissionRule[];
  }): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // A mid-run snapshot that collapses to (near) nothing is the signature of a
    // failed settings read upstream: every previously-allowed tool would start
    // prompting or denying at once. Loud enough to spot in the logs.
    const before = session.permissionRules.length;
    if (before > 0 && rules.length < before / 2) {
      dbg.agentPermission(
        'Permission rule snapshot for session %s shrank sharply: %d -> %d rules',
        sessionId,
        before,
        rules.length,
      );
    }
    dbg.agentPermission(
      'Permission rules for session %s updated: %d -> %d rules',
      sessionId,
      before,
      rules.length,
    );
    session.permissionRules = rules;
    session.normalizationCtx.permissionRules = rules;
  }

  /**
   * Get the accumulated session-allowed tools for a session.
   * Used by agent-service to persist back to the task.
   */
  getSessionAllowedTools(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    return session?.sessionAllowedTools ?? [];
  }

  async dispose(): Promise<void> {
    for (const [sessionId] of this.sessions) {
      await this.stop(sessionId);
    }
  }

  // --- Private: SDK generator processing ---

  /**
   * Run the SDK generator in the background, pushing events to the channel.
   * Permission/question events from handleToolRequest are also pushed to the
   * same channel, so they're immediately available even when the SDK is blocked.
   */
  private async runSdkGenerator(
    config: AgentBackendConfig,
    parts: PromptPart[],
    session: ClaudeSession,
    sessionKey: string,
  ): Promise<void> {
    session.eventChannel.push({
      type: 'entry',
      rawMessageId: null,
      entry: {
        id: nanoid(),
        date: new Date().toISOString(),
        isSynthetic: true,
        type: 'user-prompt',
        value: buildPromptMarkdown(parts),
      },
    });

    const sdkPermissionMode =
      SDK_PERMISSION_MODES[config.interactionMode ?? 'ask'];

    const queryOptions: NonNullable<Parameters<typeof query>[0]['options']> = {
      cwd: config.cwd,
      env: getChildProcessEnv({ overrides: config.env }),
      allowedTools: [],
      // Disable the built-in question tool: we expose our own
      // `mcp__jean-claude-mcp__ask_question` which renders in the task UI.
      disallowedTools: ['AskUserQuestion'],
      canUseTool: async (
        toolName: string,
        input: Record<string, unknown>,
        options: Parameters<CanUseTool>[2],
      ): Promise<PermissionResult> => {
        return this.handleToolRequest(session, toolName, input, options);
      },
      permissionMode: sdkPermissionMode,
      settingSources: ['user', 'project', 'local'],
      abortController: session.abortController,
    };

    // `permissionRules` already carries global + project + worktree + session
    // rules in last-match-wins order; the persisted session scope is appended
    // as a fallback for callers that only supply that one.
    const additionalDirectories = getAllowedDirectories([
      ...(config.permissionRules ?? []),
      ...flattenScope(config.persistedSessionRules ?? {}),
    ]);
    if (additionalDirectories.length > 0) {
      queryOptions.additionalDirectories = additionalDirectories;
    }

    if (config.model && config.model !== 'default') {
      queryOptions.model = config.model;
    }

    if (
      config.thinkingEffort === 'low' ||
      config.thinkingEffort === 'medium' ||
      config.thinkingEffort === 'high' ||
      config.thinkingEffort === 'max'
    ) {
      queryOptions.effort = config.thinkingEffort;
    }

    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      queryOptions.mcpServers = config.mcpServers;
    }

    if (session.sessionId) {
      queryOptions.resume = session.sessionId;
    }

    // The prompt is ALWAYS sent as a streaming AsyncIterable, never as a bare
    // string. A string prompt puts the SDK in `isSingleUserTurn` mode, where it
    // closes the CLI's stdin as soon as the *first* `result` message arrives.
    // stdin is also the control channel that carries `canUseTool` responses, so
    // once a background task (background bash, Monitor, background subagent)
    // triggers an early zero-turn `result`, every later permission prompt dies
    // with "Tool permission request failed: AbortError: Stream closed".
    // Keeping the input stream open until the real end-of-turn result keeps the
    // control channel alive for the whole run.
    const userMessage = buildSdkUserMessage(parts, session.sessionId);

    // NOTE: `Query.streamInput()` is NOT an alternative to the mailbox below.
    // The SDK is already inside `streamInput` consuming this very generator
    // (its start path calls it for any AsyncIterable prompt), and its
    // implementation calls `transport.endInput()` — closing the CLI's stdin —
    // as soon as the iterable it was given ends. Calling it again would race
    // two writers into one stdin and kill the `canUseTool` channel.
    //
    // The generator stays alive until `closePromptStream` fires (real `result`
    // + grace, error, or abort), which keeps stdin — and therefore the
    // permission control channel — open. While open it also acts as a mailbox:
    // `pushPromptMessage` appends follow-up prompts that the SDK picks up as
    // new user turns on the SAME run, so a follow-up sent while background
    // tasks are live no longer requires killing (and orphaning) them.
    const pendingPrompts: SDKUserMessage[] = [];
    let promptStreamOpen = true;
    let notifyPrompt: (() => void) | null = null;
    // Set once the generator has actually handed an injected prompt to the SDK
    // (i.e. it was written to stdin), so messages still in flight from a
    // previous turn can't be mistaken for a response to it.
    let injectedPromptWritten = false;

    const closePromptStream = () => {
      promptStreamOpen = false;
      // Wake the generator so it can observe the close and return.
      notifyPrompt?.();
    };
    session.closePromptStream = closePromptStream;

    const prompt = (async function* () {
      yield userMessage;
      // Drain first, THEN test for close: a message accepted by
      // `pushPromptMessage` (which only accepts while open) must always be
      // handed to the CLI, even if the stream closes before the generator is
      // pulled again. Dropping it here would lose the user's prompt silently.
      for (;;) {
        while (pendingPrompts.length > 0) {
          const next = pendingPrompts.shift();
          if (next) {
            yield next;
            // Control returns here only when the SDK pulls again, i.e. after it
            // has written this message to the CLI's stdin.
            injectedPromptWritten = true;
          }
        }
        if (!promptStreamOpen) break;
        // No `await` between the emptiness check above and installing the
        // waiter, so a concurrent push can never be missed.
        await new Promise<void>((resolve) => {
          notifyPrompt = resolve;
        });
        notifyPrompt = null;
      }
    })();

    // Holding stdin open costs us the SDK's implicit liveness guarantee: with a
    // string prompt the CLI exited on its own at the first `result`, which is
    // what let the deferred-result replay below finalize a run that never
    // produced a real result. Now that we keep the channel open past that
    // point, an agent that goes silent after a background notification would
    // idle forever. The watchdog restores the old terminating behaviour: after
    // a withheld result, a long enough silence closes the input stream, the CLI
    // exits, and the replay path finalizes the step as before.
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const clearIdleWatchdog = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };
    // Set when a follow-up prompt has been injected and the CLI has not yet
    // answered with any message. Without this the run has NO liveness guarantee
    // after an injection: the withheld-result watchdog below is gated on
    // `deferredResultEvents`, which injection clears, so a CLI that swallows the
    // message would leave the generator suspended, stdin open, and the step
    // stuck `running` forever. Any message at all clears it.
    let awaitingInjectedResponse = false;
    const syncIdleWatchdog = () => {
      clearIdleWatchdog();
      // Only armed while a withheld result or an unanswered injected prompt is
      // outstanding — a normal run in progress may legitimately be silent for a
      // long time (a slow tool call).
      const reason = session.deferredResultEvents
        ? 'a withheld background result'
        : awaitingInjectedResponse
          ? 'an injected follow-up prompt'
          : null;
      if (!reason) return;
      idleTimer = setTimeout(() => {
        dbg.agent(
          'Session %s idle for %dms after %s — closing input stream',
          sessionKey,
          WITHHELD_RESULT_IDLE_TIMEOUT_MS,
          reason,
        );
        closePromptStream();
      }, WITHHELD_RESULT_IDLE_TIMEOUT_MS);
      idleTimer.unref?.();
    };

    // Deferred close of the input stream after a `result`. Any subsequent
    // message proves the run wasn't over and cancels it, which is what keeps
    // the `canUseTool` control channel alive for misclassified results.
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelScheduledClose = () => {
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = null;
    };
    const schedulePromptStreamClose = () => {
      cancelScheduledClose();
      const graceMs =
        session.backgroundTaskIds.size > 0
          ? BACKGROUND_WORK_CLOSE_GRACE_MS
          : POST_RESULT_CLOSE_GRACE_MS;
      dbg.agentPermission(
        'Result for session %s — closing stdin in %dms unless more activity arrives (%d background task(s) live, %d pending permission request(s))',
        sessionKey,
        graceMs,
        session.backgroundTaskIds.size,
        session.pendingResolvers.size,
      );
      closeTimer = setTimeout(() => {
        closeTimer = null;
        dbg.agentPermission(
          'Session %s stayed silent after its result — closing input stream',
          sessionKey,
        );
        closePromptStream();
      }, graceMs);
      closeTimer.unref?.();
    };

    const generator = query({ prompt, options: queryOptions });
    session.queryInstance = generator;
    let sawRealResult = false;

    session.pushPromptMessage = (message) => {
      if (!promptStreamOpen || session.abortController.signal.aborted) {
        return false;
      }
      // A pending stdin close (armed by the previous turn's result) would kill
      // the CLI moments after we hand it this prompt, and the idle watchdog is
      // no longer measuring idleness. The run is live again — stand both down.
      cancelScheduledClose();
      // A new user turn starts here, so the previous turn's result no longer
      // means "the run ends on the next silence", and any withheld
      // background-notification result must not be replayed onto this turn.
      sawRealResult = false;
      session.deferredResultEvents = null;
      pendingPrompts.push(message);
      notifyPrompt?.();
      // Re-arm the watchdog against THIS prompt, so a CLI that never answers
      // still terminates the run instead of wedging the step on `running`.
      awaitingInjectedResponse = true;
      syncIdleWatchdog();
      dbg.agentSession(
        'Injected follow-up prompt into live session %s (%d background task(s) still live)',
        sessionKey,
        session.backgroundTaskIds.size,
      );
      return true;
    };

    try {
      for await (const rawMessage of generator) {
        if (session.abortController.signal.aborted) {
          break;
        }

        const message = rawMessage as AgentMessage;

        // Any message at all proves the previous `result` did not end the run,
        // so stand down the pending stdin close and keep `canUseTool` alive.
        cancelScheduledClose();

        // 1. Persist raw message
        const rawMessageId = await this.taskContext.persistRaw({
          messageIndex: session.messageIndex++,
          backendSessionId: session.sessionId,
          rawData: message,
        });

        // 2. Normalize (stateful V2)
        const events = normalizeClaudeMessageV2(
          message,
          session.normalizationCtx,
        );

        // 3. Update normalization context
        for (const event of events) {
          if (event.type === 'session-id') {
            session.sessionId = event.sessionId;
            session.normalizationCtx.sessionIdEmitted = true;
          }
        }

        // 4. Convert normalization events to AgentEvents and push
        // Only 'entry' needs special handling (add rawMessageId);
        // all other variants are structurally compatible.
        const agentEvents = events.map((event) =>
          event.type === 'entry'
            ? ({ ...event, rawMessageId } as AgentEvent)
            : (event as AgentEvent),
        );

        // Track live background work. The SDK documents REPLACE semantics, so
        // the payload swaps the set rather than merging into it. Used only to
        // pick how long to wait before closing stdin — never to decide whether
        // the run is over, which would hang a run whose background task never
        // terminates (a leftover `run_in_background` shell, a Monitor).
        const taskSnapshot = readBackgroundTaskSnapshot(message);
        if (taskSnapshot) {
          session.backgroundTaskIds = new Set(
            taskSnapshot.map((task) => task.taskId),
          );
          dbg.agentPermission(
            'Session %s background tasks: %d live %o',
            sessionKey,
            session.backgroundTaskIds.size,
            taskSnapshot,
          );
          // Surface the snapshot to the UI so a turn that "finished" while
          // background work is still live doesn't look idle.
          session.eventChannel.push({
            type: 'background-tasks',
            tasks: taskSnapshot,
          });
        }

        // A background-task notification produces a no-op `result`. Withhold it
        // (it would finalize the turn while the agent keeps working) and replay
        // it only if the run ends without ever emitting a real result.
        if (isBackgroundNotificationResult(message)) {
          if (!sawRealResult) session.deferredResultEvents = agentEvents;
          syncIdleWatchdog();
          // Re-arm the close: silence after a result still ends the run, even
          // when the last thing we saw was a withheld notification.
          if (sawRealResult) schedulePromptStreamClose();
          continue;
        }
        if (message.type === 'result') {
          // Do NOT close stdin here. No property of a `result` reliably means
          // "the run is over" (see POST_RESULT_CLOSE_GRACE_MS), and closing
          // early kills the `canUseTool` channel for every later tool call.
          sawRealResult = true;
          session.deferredResultEvents = null;
          awaitingInjectedResponse = false;
        }

        // A top-level assistant message received AFTER the injected prompt
        // reached stdin is our evidence that the CLI is answering it.
        //
        // The bounds are narrow on both sides. Clearing on *any* message lets
        // unrelated background chatter — streaming precisely when injection
        // happens — disarm the watchdog while the prompt sits unread. But
        // waiting for a `result` subjects the injected turn to a 10-minute idle
        // kill that a normal turn never faces: one long foreground tool call
        // emits nothing, and closing stdin mid-turn would kill the `canUseTool`
        // channel and the background jobs this path exists to protect.
        //
        // `parent_tool_use_id` filters out subagent output (it is set for
        // anything spawned by a Task tool_use) but NOT background bash/Monitor
        // completions: those resume the main agent, so their messages are
        // top-level. `injectedPromptWritten` is what excludes those — it is set
        // only once the generator has actually handed the prompt to the SDK, so
        // messages produced by an in-flight background-notification turn cannot
        // disarm the watchdog before the CLI has even seen the prompt.
        //
        // A residual wire race remains: a message written to stdout just before
        // the CLI reads stdin can still clear the flag. Closing that would need
        // request/response correlation the SDK does not expose. The exposure is
        // one watchdog cycle, not data loss — the prompt is already in stdin.
        if (
          injectedPromptWritten &&
          message.type === 'assistant' &&
          !message.parent_tool_use_id
        ) {
          awaitingInjectedResponse = false;
          injectedPromptWritten = false;
        }

        for (const event of agentEvents) {
          session.eventChannel.push(event);
        }

        // Re-arm (or drop) the idle watchdog after every message.
        syncIdleWatchdog();

        // Once a result has been seen, the run ends on silence, not on the
        // result itself. Every message re-arms this, so the stream closes a
        // grace period after the LAST message rather than the first result.
        if (sawRealResult) schedulePromptStreamClose();
      }
    } catch (error) {
      // SDK threw an unexpected error — push it as an error event so
      // agent-service can surface it to the user instead of silently
      // dropping it (runSdkGenerator is called fire-and-forget).
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown SDK error';
      dbg.agent(
        'SDK generator error for session %s: %s',
        sessionKey,
        errorMessage,
      );
      // A terminal error already finalizes the step — replaying a success
      // result on top of it would resurrect a failed run.
      session.deferredResultEvents = null;
      session.eventChannel.push({
        type: 'error',
        error: errorMessage,
      });
    } finally {
      // Never leave the input generator suspended — it would hold stdin (and
      // the CLI process) open forever.
      clearIdleWatchdog();
      cancelScheduledClose();
      closePromptStream();
      session.closePromptStream = null;
      session.pushPromptMessage = null;
      // The stream ended on a withheld background-notification result and no
      // real result ever arrived: replay it so the step isn't stuck `running`.
      // The run is over, so nothing is still working in the background —
      // clear the UI indicator even if the SDK never sent a final empty
      // snapshot (it stops streaming once the process exits).
      if (
        session.backgroundTaskIds.size > 0 &&
        !session.abortController.signal.aborted
      ) {
        session.backgroundTaskIds = new Set();
        session.eventChannel.push({ type: 'background-tasks', tasks: [] });
      }
      const deferred = session.deferredResultEvents;
      session.deferredResultEvents = null;
      if (deferred && !session.abortController.signal.aborted) {
        for (const event of deferred) session.eventChannel.push(event);
      }
      // The stream is gone, so nobody can answer a still-open permission card.
      // Settle the resolvers here — otherwise they dangle forever and the later
      // `stop()` short-circuits on the already-deleted session key.
      //
      // This is the mass-denial path: if the generator ends while tool requests
      // are still outstanding, EVERY one of them fails at once and every
      // still-rendered permission card in the UI then throws "No Claude
      // session" on click. Log it — it is the prime suspect for reports of
      // "randomly all tool permissions fail".
      if (session.pendingResolvers.size > 0) {
        dbg.agentPermission(
          'Session %s ended with %d unanswered permission request(s) — denying all. aborted=%s sawRealResult=%s pendingTools=%o',
          sessionKey,
          session.pendingResolvers.size,
          session.abortController.signal.aborted,
          sawRealResult,
          [...session.pendingResolvers.values()].map((r) => r.toolName),
        );
      }
      for (const [, resolver] of session.pendingResolvers) {
        resolver.resolve({ behavior: 'deny', message: 'Session ended' });
      }
      session.pendingResolvers.clear();
      session.eventChannel.close();
      this.sessions.delete(sessionKey);
    }
  }

  /**
   * Build a session-allow button for a given tool request.
   * This determines what appears as the "Allow for session" button in the UI.
   */
  private getSessionAllowButton(
    toolName: string,
    input: Record<string, unknown>,
  ): NormalizedPermissionRequest['sessionAllowButton'] | undefined {
    if (toolName === 'ExitPlanMode') {
      return {
        label: 'Allow and Auto-Edit',
        toolsToAllow: ['Edit', 'Write'],
        setModeOnAllow: 'ask',
      };
    }

    const { tool, matchValue } = normalizeToolRequest(toolName, input);
    const permission = matchValue ? `${tool}:${matchValue}` : tool;

    return {
      label: `Allow ${toolName} for Session`,
      toolsToAllow: [permission],
    };
  }

  /**
   * Handle a tool use request from the SDK's `canUseTool` callback.
   *
   * This runs inside the SDK's async iteration — the generator won't produce
   * the next message until this promise resolves. We push permission/question
   * events directly to the eventChannel so they're immediately available to
   * the consumer (agent-service), even while the SDK generator is blocked.
   */
  private handleToolRequest(
    session: ClaudeSession,
    toolName: string,
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    dbg.agentPermission('Tool request: %s', toolName, input);

    // Check against backend-agnostic permission rules
    const { tool, matchValue } = normalizeToolRequest(toolName, input);
    const permissionDecision = evaluatePermissionWithMatch(
      session.permissionRules,
      tool,
      matchValue,
      tool === 'bash' ? String(input.command ?? '') : undefined,
    );
    const action = permissionDecision.action;
    if (action === 'allow' && !options.blockedPath) {
      dbg.agentPermission('Tool %s auto-allowed by permission rules', toolName);
      // No decision is recorded here: the SDK already yielded (and we already
      // normalized) the assistant tool_use block before this callback runs, so
      // a decision pushed now would be consumed by the *next* identical tool
      // call. The normalizer re-evaluates the same rules itself instead.
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    if (action === 'deny') {
      dbg.agentPermission('Tool %s auto-denied by permission rules', toolName);
      return Promise.resolve({
        behavior: 'deny',
        message: `Tool "${toolName}" is denied by permission rules`,
      });
    }

    // Check session-allowed tools (canonical format: "tool:matchValue" or "tool")
    // Bare tool name (e.g., "read") acts as a wildcard — matches any "read:*" request
    const canonicalPermission = matchValue ? `${tool}:${matchValue}` : tool;
    if (
      !options.blockedPath &&
      (session.sessionAllowedTools.includes(canonicalPermission) ||
        (matchValue && session.sessionAllowedTools.includes(tool)))
    ) {
      dbg.agentPermission('Tool %s is session-allowed', toolName);
      // Same ordering caveat as above; session-allowed tools resolve to
      // "allowed by agent", which is the normalizer's fallback anyway.
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }

    const requestId = nanoid();

    return new Promise<PermissionResult>((resolve) => {
      const isQuestion = toolName === 'AskUserQuestion';

      // Store the resolver so respondToPermission/respondToQuestion can complete it
      session.pendingResolvers.set(requestId, {
        type: isQuestion ? 'question' : 'permission',
        toolName,
        input,
        resolve,
      });

      // Push events directly to the channel — they're immediately available
      // to the consumer even though the SDK generator is blocked here.
      if (isQuestion) {
        const questions = (input.questions as AgentQuestion[]).map(
          (q): NormalizedQuestion => ({
            question: q.question,
            header: q.header,
            options: q.options.map((o) => ({
              label: o.label,
              description: o.description,
            })),
            multiSelect: q.multiSelect,
          }),
        );

        session.eventChannel.push({
          type: 'question',
          request: {
            requestId,
            questions,
          } satisfies NormalizedQuestionRequest,
        });
      } else {
        const sessionAllowButton = this.getSessionAllowButton(toolName, input);
        const directoryAccess = options.blockedPath
          ? options.suggestions
              ?.filter(
                (suggestion) => suggestion.type === 'addDirectories',
              )
              .flatMap((suggestion) => suggestion.directories)
              .map((requestedDirectory) =>
                buildDirectoryAccess({
                  requestedPath: options.blockedPath!,
                  requestedDirectory,
                }),
              )
              .find((access) => access !== undefined)
          : undefined;
        session.eventChannel.push({
          type: 'permission-request',
          request: {
            requestId,
            toolName,
            input,
            sessionAllowButton,
            permissionEvaluation: {
              action: options.blockedPath ? 'ask' : action,
              matchValue,
              ...(permissionDecision.matchedRule
                ? {
                    matchedRule: {
                      tool: permissionDecision.matchedRule.tool,
                      pattern: permissionDecision.matchedRule.pattern,
                      action: permissionDecision.matchedRule.action,
                    },
                  }
                : {}),
              ...(permissionDecision.subCommands
                ? {
                    subCommands: permissionDecision.subCommands.map((sub) => ({
                      command: sub.command,
                      action: sub.action,
                      ...(sub.matchedRule
                        ? {
                            matchedRule: {
                              tool: sub.matchedRule.tool,
                              pattern: sub.matchedRule.pattern,
                              action: sub.matchedRule.action,
                            },
                          }
                        : {}),
                    })),
                  }
                : {}),
            },
            directoryAccess,
          } satisfies NormalizedPermissionRequest,
        });
      }
    });
  }
}
