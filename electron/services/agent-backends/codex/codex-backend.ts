import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { nanoid } from 'nanoid';

import type {
  AgentBackend,
  AgentBackendConfig,
  AgentEvent,
  AgentSession,
  AgentTaskContext,
  NormalizedPermissionResponse,
  PromptImagePart,
  PromptPart,
} from '@shared/agent-backend-types';
import type { InteractionMode } from '@shared/types';
import type { NormalizedQuestionRequest } from '@shared/agent-backend-types';
import type { QuestionResponseMetadata } from '@shared/agent-types';
import type { ResolvedPermissionRule } from '@shared/permission-types';

import {
  codexMcpElicitationContentFromAnswers,
  createCodexNormalizationContext,
  normalizeCodexMcpElicitation,
  normalizeCodexNotification,
  normalizeCodexQuestionRequest,
} from './normalize-codex-message-v2';
import {
  evaluatePermission,
  flattenScope,
  normalizeToolRequest,
} from '../../permission-settings-service';
import { dbg } from '../../../lib/debug';
import { getAllowedDirectories } from '../../directory-access';
import { getOrCreateCodexAppServer } from './codex-app-server';
import { interleavePromptParts } from '../../prompt-utils';

import type {
  CodexJsonRpcId,
  CodexJsonRpcNotification,
  CodexJsonRpcRequest,
} from './codex-json-rpc-client';
import type { CodexNormalizationContext } from './normalize-codex-message-v2';

const CODEX_IDLE_COMPLETION_TIMEOUT_MS = 60_000;

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

type CodexSessionState = {
  sessionId: string;
  threadId: string | null;
  turnId: string | null;
  /** Env this session's app-server was pooled under; interrupts must reuse it. */
  env?: Record<string, string>;
  eventChannel: AsyncEventChannel<AgentEvent>;
  normalizationCtx: CodexNormalizationContext;
  messageIndex: number;
  unsubscribe: (() => void) | null;
  unsubscribeRequest: (() => void) | null;
  processing: Promise<void>;
  closed: boolean;
  pendingItemIds: Set<string>;
  /** server name -> tool name for MCP tool calls Codex has started but not
   *  finished. The approval request Codex sends does NOT carry the tool name
   *  (verified against codex-cli 0.155.0: `_meta` has `tool_description` and
   *  `tool_params` but no `tool_name`), so it is taken from the preceding
   *  `item/started` notification instead. */
  inFlightMcpTools: Map<string, string>;
  /** Permission keys (`mcp__<server>__<tool>`) the user allowed beyond this one
   *  call. Codex offers no verified way to persist an MCP tool-call approval on
   *  its side, so "allow for session/project" is honoured here instead of being
   *  silently dropped. Only ever holds fully-qualified server+tool keys, so a
   *  grant can never widen to a whole MCP server. */
  sessionAllowedMcpTools: Set<string>;
  /** Live snapshot of resolved permission rules, evaluated before prompting so
   *  a persisted "allow"/"deny" for an MCP tool is honoured instead of asking
   *  again. Replaced wholesale by `updatePermissionRules`. */
  permissionRules: ResolvedPermissionRule[];
  /** Step-scoped rules, re-appended on every refresh so they survive it. */
  persistedPermissionRules: ResolvedPermissionRule[];
  sawTurnActivity: boolean;
  idleCompletionTimer: ReturnType<typeof setTimeout> | null;
  rawDeltaRows: Map<
    string,
    {
      rowId: string;
      notification: CodexDeltaNotification;
      dirty: boolean;
    }
  >;
  pendingApprovals: Map<
    string,
    {
      client: Awaited<ReturnType<typeof getOrCreateCodexAppServer>>['client'];
      rpcId: CodexJsonRpcId;
      type: 'command' | 'file-change' | 'permissions' | 'mcp-tool-call';
      permissions?: Record<string, unknown>;
      // Only for 'mcp-tool-call': mirrors the elicitation-question path so the
      // Codex-side elicitation timeout is paused while a human decides.
      elicitationPaused?: boolean;
      threadId?: string;
      /** Only for 'mcp-tool-call': the key to remember if the user picks an
       *  allow mode wider than this single call. `null` when the tool name
       *  could not be resolved, in which case nothing is remembered. */
      allowKey?: string | null;
    }
  >;
  pendingQuestions: Map<
    string,
    {
      client: Awaited<ReturnType<typeof getOrCreateCodexAppServer>>['client'];
      rpcId: CodexJsonRpcId;
      request: NormalizedQuestionRequest;
      kind: 'user-input' | 'mcp-elicitation';
      schema?: Record<string, unknown>;
      elicitationPaused?: boolean;
      threadId?: string;
    }
  >;
};

type CodexDeltaNotification = {
  method: 'item/agentMessage/delta' | 'item/commandExecution/outputDelta';
  params: {
    threadId?: string;
    turnId?: string;
    itemId: string;
    delta: string;
  };
};

export class CodexBackend implements AgentBackend {
  private readonly sessions = new Map<string, CodexSessionState>();

  constructor(private readonly taskContext: AgentTaskContext) {}

  async start(
    config: AgentBackendConfig,
    parts: PromptPart[],
  ): Promise<AgentSession> {
    const sessionKey = nanoid();
    const session: CodexSessionState = {
      sessionId: sessionKey,
      threadId: null,
      turnId: null,
      env: config.env,
      eventChannel: new AsyncEventChannel<AgentEvent>(),
      normalizationCtx: createCodexNormalizationContext({
        interactionMode: config.interactionMode,
      }),
      messageIndex: this.taskContext.sessionStartIndex,
      unsubscribe: null,
      unsubscribeRequest: null,
      processing: Promise.resolve(),
      closed: false,
      pendingItemIds: new Set(),
      inFlightMcpTools: new Map(),
      sessionAllowedMcpTools: new Set(),
      permissionRules: [],
      persistedPermissionRules: [],
      sawTurnActivity: false,
      idleCompletionTimer: null,
      rawDeltaRows: new Map(),
      pendingApprovals: new Map(),
      pendingQuestions: new Map(),
    };
    session.persistedPermissionRules = flattenScope(
      config.persistedSessionRules ?? {},
    );
    session.permissionRules = [
      ...(config.permissionRules ?? []),
      ...session.persistedPermissionRules,
    ];
    session.normalizationCtx.model =
      config.model === 'default' ? undefined : config.model;
    this.sessions.set(sessionKey, session);

    try {
      const { client, rootPid } = await getOrCreateCodexAppServer(config.env);
      const threadConfig = createCodexThreadConfig(config);
      dbg.agent(
        'Starting Codex thread mode=%s approvalPolicy=%s sandbox=%s model=%s',
        config.interactionMode,
        threadConfig.approvalPolicy,
        threadConfig.sandbox,
        threadConfig.model ?? 'default',
      );
      const threadResult = config.sessionId
        ? await client.request('thread/resume', {
            threadId: config.sessionId,
            ...threadConfig,
          })
        : await client.request('thread/start', {
            ...threadConfig,
            serviceName: 'jean_claude',
          });

      session.threadId =
        idFromResult(threadResult, 'thread') ?? config.sessionId ?? null;
      if (session.threadId === null) {
        throw new Error('Codex thread/start did not return a thread id');
      }
      session.normalizationCtx.emittedSessionIds.add(session.threadId);
      session.eventChannel.push({
        type: 'session-id',
        sessionId: session.threadId,
      });

      session.unsubscribe = client.onNotification((notification) => {
        this.enqueueNotification(session, notification);
      });
      session.unsubscribeRequest = client.onRequest((request) => {
        void this.handleServerRequest(session, client, request);
      });

      const collaborationMode = await createCodexCollaborationMode(
        client,
        config,
      );
      const turnResult = await client.request('turn/start', {
        threadId: session.threadId,
        input: partsToCodexInput(parts),
        model: config.model === 'default' ? undefined : config.model,
        collaborationMode,
      });
      session.turnId = idFromResult(turnResult, 'turn');
      if (session.turnId === null) {
        throw new Error('Codex turn/start did not return a turn id');
      }

      return {
        sessionId: sessionKey,
        events: session.eventChannel,
        rootPid,
      };
    } catch (error) {
      await this.cleanupSession(sessionKey, session);
      throw error;
    }
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      await this.interruptSession(session);
    } finally {
      await this.cleanupSession(sessionId, session);
    }
  }

  async respondToPermission(
    sessionId: string,
    requestId: string,
    response: NormalizedPermissionResponse,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No Codex session: ${sessionId}`);

    const pending = session.pendingApprovals.get(requestId);
    if (!pending) {
      throw new Error(`No pending Codex approval: ${requestId}`);
    }

    if (pending.type === 'mcp-tool-call') {
      // Codex delivers MCP tool-call approvals as an elicitation, so the reply
      // has to be an elicitation result, not an approval `decision`.
      // `allowMode` is honoured locally (below) rather than on the wire: Codex
      // advertises `_meta.persist: ['session','always']` on the request, but
      // the reply shape for taking it is unverified, and sending a guess would
      // silently do nothing. A local allowlist at least makes the button mean
      // what it says for the lifetime of this session. Cross-session
      // persistence is still not wired up for Codex -- it has no rule
      // evaluation on this path -- so "allow for project" lasts this session.
      if (
        response.behavior === 'allow' &&
        response.allowMode !== undefined &&
        pending.allowKey
      ) {
        // Keyed on the request's own server+tool identity rather than the
        // renderer-supplied `toolsToAllow`, whose shape varies between the
        // dedicated session button and the "Allow All" menu entry.
        session.sessionAllowedMcpTools.add(pending.allowKey);
        dbg.agent(
          'Remembering Codex MCP approval for this session tool=%s mode=%s',
          pending.allowKey,
          response.allowMode,
        );
      }
      try {
        await pending.client.respond(pending.rpcId, {
          action: response.behavior === 'deny' ? 'decline' : 'accept',
          content: {},
        });
      } finally {
        await this.resumeCodexElicitation(pending, requestId);
        session.pendingApprovals.delete(requestId);
      }
      return;
    }

    if (pending.type === 'permissions') {
      await pending.client.respond(pending.rpcId, {
        permissions: response.behavior === 'deny' ? {} : pending.permissions ?? {},
        scope: response.allowMode === 'session' ? 'session' : 'turn',
      });
    } else {
      const decision =
        response.behavior === 'deny'
          ? 'decline'
          : response.allowMode === 'session'
            ? 'acceptForSession'
            : 'accept';
      await pending.client.respond(pending.rpcId, { decision });
    }
    session.pendingApprovals.delete(requestId);
  }

  async respondToQuestion(
    sessionId: string,
    requestId: string,
    answer: Record<string, string>,
    _metadata: QuestionResponseMetadata,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No Codex session: ${sessionId}`);

    const pending = session.pendingQuestions.get(requestId);
    if (!pending) throw new Error(`No pending Codex question: ${requestId}`);

    if (pending.kind === 'mcp-elicitation') {
      if (!pending.schema) {
        throw new Error(`Missing Codex elicitation schema: ${requestId}`);
      }
      dbg.agent('Responding to Codex MCP elicitation request=%s', requestId);
      try {
        await pending.client.respond(pending.rpcId, {
          action: 'accept',
          content: codexMcpElicitationContentFromAnswers({
            schema: pending.schema,
            answers: answer,
          }),
        });
      } finally {
        await this.resumeCodexElicitation(pending, requestId);
        session.pendingQuestions.delete(requestId);
      }
      return;
    }

    const answers = Object.fromEntries(
      pending.request.questions.map((question) => [
        question.id ?? question.question,
        { answers: parseQuestionAnswer(answer[question.id ?? question.question]) },
      ]),
    );
    await pending.client.respond(pending.rpcId, { answers });
    session.pendingQuestions.delete(requestId);
  }

  async sendUserMessage(
    sessionId: string,
    parts: PromptPart[],
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session?.threadId || !session.turnId || session.closed) return false;

    dbg.agent(
      'Steering Codex turn session=%s thread=%s turn=%s',
      sessionId,
      session.threadId,
      session.turnId,
    );
    await getOrCreateCodexAppServer(session.env).then(({ client }) =>
      client.request('turn/steer', {
        threadId: session.threadId,
        input: partsToCodexInput(parts),
        expectedTurnId: session.turnId,
      }),
    );
    dbg.agent('Codex turn steer accepted session=%s', sessionId);
    return true;
  }

  async setMode(_sessionId: string, _mode: InteractionMode): Promise<void> {}

  /**
   * Replace the permission-rule snapshot used for runtime evaluation, so a rule
   * the user adds mid-run ("always allow in this project") takes effect on the
   * live session instead of only on the next one. Step-scoped rules are
   * re-appended so they survive the refresh.
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
    session.permissionRules = [...rules, ...session.persistedPermissionRules];
  }

  /**
   * Session-scoped MCP grants, in canonical permission-key form. The agent
   * service reads these at the end of a turn and syncs them into the step's
   * persisted session rules, which is what makes "allow for session" outlive
   * the session.
   */
  getSessionAllowedTools(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    return session ? [...session.sessionAllowedMcpTools] : [];
  }

  async dispose(): Promise<void> {
    await Promise.all(
      Array.from(this.sessions.keys()).map((sessionId) => this.stop(sessionId)),
    );
  }

  private async handleServerRequest(
    session: CodexSessionState,
    client: Awaited<ReturnType<typeof getOrCreateCodexAppServer>>['client'],
    request: CodexJsonRpcRequest,
  ): Promise<void> {
    if (session.closed || !requestBelongsToSession(request, session)) return;

    const params = record(request.params) ?? {};
    const threadId = stringOrNull(params?.threadId);
    const turnId = stringOrNull(params?.turnId);
    const requestId = String(request.id);

    if (request.method === 'item/tool/requestUserInput') {
      const questionRequest = normalizeCodexQuestionRequest({
        requestId,
        params,
      });
      dbg.agent(
        'Codex user-input request received request=%s mode=%s questionCount=%s normalized=%s',
        requestId,
        session.normalizationCtx.interactionMode,
        Array.isArray(params.questions) ? params.questions.length : 0,
        questionRequest ? questionRequest.questions.length : 0,
      );
      if (
        threadId === null ||
        turnId === null ||
        stringOrNull(params.itemId) === null ||
        questionRequest === undefined
      ) {
        void client.respondError(request.id, -32602, 'Invalid question request');
        return;
      }
      session.pendingQuestions.set(requestId, {
        client,
        rpcId: request.id,
        request: questionRequest,
        kind: 'user-input',
      });
      session.eventChannel.push({ type: 'question', request: questionRequest });
      return;
    }

    if (request.method === 'mcpServer/elicitation/request') {
      // Codex reuses the elicitation channel to ask for *approval* of an MCP
      // tool call (`_meta.codex_approval_kind`). Those carry an empty
      // `requestedSchema`, so treating them as questions silently declined
      // every MCP tool call. Route them through the permission pipeline
      // instead -- but only for the one kind verified to arrive here. Any
      // other kind falls through to `normalizeCodexMcpElicitation`, which
      // declines shapes it cannot render rather than answering them with a
      // content-less accept.
      const approvalKind = stringOrNull(record(params._meta)?.codex_approval_kind);
      if (approvalKind === 'mcp_tool_call') {
        const serverName = stringOrNull(params.serverName) ?? 'mcp';
        // `_meta.tool_name` is not sent by codex-cli 0.155.0; fall back to the
        // name captured from this call's `item/started` notification, which
        // always precedes the approval request.
        const toolName =
          stringOrNull(record(params._meta)?.tool_name) ??
          session.inFlightMcpTools.get(serverName) ??
          null;
        // Only fully-qualified keys are remembered, so an unnamed tool call can
        // never be covered by (or added to) a session grant.
        const allowKey = toolName ? `mcp__${serverName}__${toolName}` : null;
        if (isAutoApproveMode(session)) {
          dbg.agent(
            'Auto-approving Codex mcp_tool_call request=%s server=%s tool=%s',
            requestId,
            serverName,
            toolName ?? 'unknown',
          );
          void client.respond(request.id, { action: 'accept', content: {} });
          return;
        }
        const permissionToolName = allowKey ?? `mcp__${serverName}`;
        const toolInput = record(record(params._meta)?.tool_params) ?? {};
        // Persisted rules first: a `deny` must win over an in-memory grant.
        const { tool, matchValue } = normalizeToolRequest(
          permissionToolName,
          toolInput,
        );
        const ruleAction = evaluatePermission(
          session.permissionRules,
          tool,
          matchValue,
        );
        if (ruleAction === 'deny') {
          dbg.agent(
            'Declining Codex mcp_tool_call by permission rule request=%s tool=%s',
            requestId,
            permissionToolName,
          );
          void client.respond(request.id, { action: 'decline' });
          return;
        }
        if (
          ruleAction === 'allow' ||
          (allowKey !== null && session.sessionAllowedMcpTools.has(allowKey))
        ) {
          dbg.agent(
            'Accepting Codex mcp_tool_call without prompting request=%s tool=%s source=%s',
            requestId,
            permissionToolName,
            ruleAction === 'allow' ? 'rule' : 'session-allowlist',
          );
          void client.respond(request.id, { action: 'accept', content: {} });
          return;
        }
        dbg.agent(
          'Codex mcp_tool_call approval request received request=%s server=%s tool=%s',
          requestId,
          serverName,
          toolName ?? 'unknown',
        );
        // A human is about to be asked, so the turn is not idle and Codex's own
        // elicitation timeout must not run out while they decide — same
        // treatment the elicitation-question path below gives.
        this.clearIdleCompletionTimer(session);
        let elicitationPaused = false;
        if (threadId !== null) {
          try {
            await client.request('thread/increment_elicitation', { threadId });
            elicitationPaused = true;
          } catch (error) {
            dbg.agent(
              'Failed to pause Codex elicitation timeout thread=%s error=%O',
              threadId,
              error,
            );
          }
        }
        session.pendingApprovals.set(requestId, {
          client,
          rpcId: request.id,
          type: 'mcp-tool-call',
          elicitationPaused,
          allowKey,
          ...(threadId !== null ? { threadId } : {}),
        });
        session.eventChannel.push({
          type: 'permission-request',
          request: {
            requestId,
            toolName: permissionToolName,
            input: toolInput,
            description: stringOrNull(params.message) ?? undefined,
            // Offered only when the tool is identified, so the button never
            // grants more than the one tool it names.
            ...(allowKey !== null && toolName !== null
              ? {
                  sessionAllowButton: {
                    label: `Allow ${toolName} for Session`,
                    toolsToAllow: [allowKey],
                  },
                }
              : {}),
          },
        });
        return;
      }

      const elicitation = normalizeCodexMcpElicitation({
        requestId,
        params,
      });
      if (!elicitation) {
        dbg.agent(
          'Declining unsupported Codex MCP elicitation request=%s mode=%s',
          requestId,
          params.mode,
        );
        void client.respond(request.id, { action: 'decline' });
        return;
      }
      dbg.agent(
        'Codex MCP elicitation request received request=%s questions=%d',
        requestId,
        elicitation.request.questions.length,
      );
      this.clearIdleCompletionTimer(session);
      dbg.agent(
        'Holding Codex idle completion while question is pending request=%s',
        requestId,
      );
      let elicitationPaused = false;
      if (threadId !== null) {
        try {
          await client.request('thread/increment_elicitation', { threadId });
          elicitationPaused = true;
          dbg.agent('Paused Codex elicitation timeout thread=%s', threadId);
        } catch (error) {
          dbg.agent(
            'Failed to pause Codex elicitation timeout thread=%s error=%O',
            threadId,
            error,
          );
        }
      }
      session.pendingQuestions.set(requestId, {
        client,
        rpcId: request.id,
        request: elicitation.request,
        kind: 'mcp-elicitation',
        schema: elicitation.schema,
        elicitationPaused,
        threadId: threadId ?? undefined,
      });
      session.eventChannel.push({ type: 'question', request: elicitation.request });
      return;
    }

    const isPermissionsRequest =
      request.method === 'item/permissions/requestApproval';
    if (
      !isPermissionsRequest &&
      request.method !== 'item/commandExecution/requestApproval' &&
      request.method !== 'item/fileChange/requestApproval'
    ) {
      void client.respondError(
        request.id,
        -32601,
        `Unsupported Codex server request: ${request.method}`,
      );
      return;
    }

    const itemId = stringOrNull(params?.itemId);
    const requestedPermissions = isPermissionsRequest
      ? record(params.permissions)
      : undefined;
    if (
      threadId === null ||
      turnId === null ||
      itemId === null ||
      (isPermissionsRequest && requestedPermissions === undefined)
    ) {
      void client.respondError(
        request.id,
        -32602,
        `Invalid parameters for ${request.method}`,
      );
      return;
    }

    if (isAutoApproveMode(session)) {
      // Previously `approval_policy=never` made Codex deny these outright
      // without ever asking us. Now that we always ask for an approver, `auto`
      // has to answer for itself to stay prompt-free.
      dbg.agent(
        'Auto-approving Codex %s request=%s',
        request.method,
        requestId,
      );
      void (isPermissionsRequest
        ? client.respond(request.id, {
            permissions: requestedPermissions ?? {},
            scope: 'session',
          })
        : client.respond(request.id, { decision: 'acceptForSession' }));
      return;
    }

    session.pendingApprovals.set(requestId, {
      client,
      rpcId: request.id,
      type: isPermissionsRequest
        ? 'permissions'
        : request.method === 'item/commandExecution/requestApproval'
          ? 'command'
          : 'file-change',
      ...(isPermissionsRequest && requestedPermissions
        ? { permissions: requestedPermissions }
        : {}),
    });
    session.eventChannel.push({
      type: 'permission-request',
      request: {
        requestId,
        toolName:
          request.method === 'item/commandExecution/requestApproval'
            ? 'bash'
            : isPermissionsRequest
              ? 'permissions'
              : 'file_change',
        input: params ?? {},
        description: stringOrNull(params?.reason) ?? undefined,
      },
    });
  }

  private async interruptSession(session: CodexSessionState): Promise<void> {
    if (session.threadId === null || session.turnId === null) {
      return;
    }

    const { client } = await getOrCreateCodexAppServer(session.env);
    await client.request('turn/interrupt', {
      threadId: session.threadId,
      turnId: session.turnId,
    });
  }

  private async handleNotification(
    session: CodexSessionState,
    notification: CodexJsonRpcNotification,
  ): Promise<void> {
    if (session.closed || !notificationMatchesSession(notification, session)) {
      return;
    }
    this.clearIdleCompletionTimer(session);

    let rawMessageId: string;
    try {
      rawMessageId = await this.persistRawNotification(session, notification);
    } catch (error) {
      if (!session.closed) {
        session.eventChannel.push({
          type: 'error',
          error: `Failed to persist Codex raw notification: ${errorMessage(error)}`,
        });
        await this.cleanupSession(session.sessionId, session);
      }
      return;
    }

    if (session.closed) return;

    const normalized = normalizeCodexNotification(
      {
        method: notification.method,
        params: record(notification.params),
      },
      session.normalizationCtx,
    );
    updateItemTracking(session, notification);
    if (normalized.length === 0) {
      this.scheduleIdleCompletionIfNeeded(session);
      return;
    }

    for (const event of normalized) {
      if (session.closed) return;

      if (event.type === 'entry') {
        session.eventChannel.push({ ...event, rawMessageId });
      } else {
        session.eventChannel.push(event as AgentEvent);
      }

      if (event.type === 'complete') {
        session.turnId = null;
        await this.cleanupSession(session.sessionId, session);
        return;
      }
    }

    this.scheduleIdleCompletionIfNeeded(session);
  }

  private enqueueNotification(
    session: CodexSessionState,
    notification: CodexJsonRpcNotification,
  ): void {
    if (session.closed) return;

    // Capture MCP tool names synchronously, BEFORE the async pipeline below.
    // Codex emits `item/started` for the tool call and then immediately
    // requests approval for it, but notifications are processed on the
    // `session.processing` chain (which awaits a raw-message write) while
    // `handleServerRequest` runs on arrival. Tracking this inside
    // `handleNotification` would therefore lose the race and the approval
    // prompt would fall back to naming only the server.
    trackInFlightMcpTool(session, notification);

    session.processing = session.processing
      .catch(() => undefined)
      .then(() => this.handleNotification(session, notification))
      .catch((error: unknown) => {
        if (!session.closed) {
          session.eventChannel.push({
            type: 'error',
            error: `Codex notification processing failed: ${errorMessage(error)}`,
          });
        }
      });
  }

  private async persistRawNotification(
    session: CodexSessionState,
    notification: CodexJsonRpcNotification,
  ): Promise<string> {
    const mergedDeltaId = await this.persistMergedDelta(session, notification);
    if (mergedDeltaId !== null) return mergedDeltaId;

    await this.flushRawDeltaRows(session);

    const messageIndex = session.messageIndex++;
    return this.taskContext.persistRaw({
      messageIndex,
      backendSessionId: session.threadId,
      rawData: notification,
    });
  }

  private async persistMergedDelta(
    session: CodexSessionState,
    notification: CodexJsonRpcNotification,
  ): Promise<string | null> {
    if (
      !this.taskContext.updateRaw ||
      !isCodexDeltaNotification(notification)
    ) {
      return null;
    }

    const key = getCodexDeltaPersistenceKey(notification);
    const existing = session.rawDeltaRows.get(key);
    if (!existing) {
      const messageIndex = session.messageIndex++;
      const rowId = await this.taskContext.persistRaw({
        messageIndex,
        backendSessionId: session.threadId,
        rawData: notification,
      });
      session.rawDeltaRows.set(key, {
        rowId,
        notification: cloneCodexDeltaNotification(notification),
        dirty: false,
      });
      return rowId;
    }

    existing.notification = {
      ...existing.notification,
      params: {
        ...existing.notification.params,
        delta: existing.notification.params.delta + notification.params.delta,
      },
    };
    existing.dirty = true;
    return existing.rowId;
  }

  private async flushRawDeltaRows(session: CodexSessionState): Promise<void> {
    if (!this.taskContext.updateRaw) return;

    for (const deltaRow of session.rawDeltaRows.values()) {
      if (!deltaRow.dirty) continue;

      await this.taskContext.updateRaw({
        rowId: deltaRow.rowId,
        rawData: deltaRow.notification,
      });
      deltaRow.dirty = false;
    }
  }

  private async resumeCodexElicitation(
    pending: {
      client: Awaited<ReturnType<typeof getOrCreateCodexAppServer>>['client'];
      elicitationPaused?: boolean;
      threadId?: string;
    },
    requestId: string,
  ): Promise<void> {
    if (!pending.elicitationPaused || !pending.threadId) return;
    try {
      await pending.client.request('thread/decrement_elicitation', {
        threadId: pending.threadId,
      });
      dbg.agent(
        'Resumed Codex elicitation timeout thread=%s request=%s',
        pending.threadId,
        requestId,
      );
    } catch (error) {
      dbg.agent(
        'Failed to resume Codex elicitation timeout thread=%s request=%s error=%O',
        pending.threadId,
        requestId,
        error,
      );
    }
  }

  private async cleanupSession(
    sessionId: string,
    session: CodexSessionState,
    options: { flushRawDeltas?: boolean } = {},
  ): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    this.clearIdleCompletionTimer(session);
    session.unsubscribe?.();
    session.unsubscribe = null;
    session.unsubscribeRequest?.();
    session.unsubscribeRequest = null;
    await Promise.allSettled(
      [...session.pendingApprovals.values()].map(async (pending) => {
        if (pending.type === 'mcp-tool-call') {
          // Delivered on the elicitation channel, so it must be cancelled with
          // an elicitation result. `{decision:'cancel'}` carries no `action`
          // and leaves Codex's MCP tool call unresolved.
          try {
            await pending.client.respond(pending.rpcId, { action: 'cancel' });
          } finally {
            await this.resumeCodexElicitation(pending, String(pending.rpcId));
          }
          return;
        }
        if (pending.type === 'permissions') {
          await pending.client.respond(pending.rpcId, {
            permissions: {},
            scope: 'turn',
          });
          return;
        }
        await pending.client.respond(pending.rpcId, { decision: 'cancel' });
      }),
    );
    session.pendingApprovals.clear();
    await Promise.allSettled(
      [...session.pendingQuestions.values()].map(async (pending) => {
        if (pending.kind === 'mcp-elicitation') {
          try {
            await pending.client.respond(pending.rpcId, { action: 'cancel' });
          } finally {
            await this.resumeCodexElicitation(pending, String(pending.rpcId));
          }
          return;
        }
        await pending.client.respond(pending.rpcId, { answers: {} });
      }),
    );
    session.pendingQuestions.clear();
    try {
      if (options.flushRawDeltas !== false) {
        await this.flushRawDeltaRows(session);
      }
    } finally {
      session.eventChannel.close();
      this.sessions.delete(sessionId);
    }
  }

  private scheduleIdleCompletionIfNeeded(session: CodexSessionState): void {
    if (
      session.closed ||
      session.turnId === null ||
      !session.sawTurnActivity ||
      session.pendingItemIds.size > 0 ||
      session.pendingQuestions.size > 0 ||
      session.idleCompletionTimer !== null
    ) {
      return;
    }

    session.idleCompletionTimer = setTimeout(() => {
      session.idleCompletionTimer = null;
      if (
        session.closed ||
        session.turnId === null ||
        session.pendingItemIds.size > 0 ||
        session.pendingQuestions.size > 0
      ) {
        return;
      }

      void (async () => {
        try {
          await this.flushRawDeltaRows(session);
          if (session.closed || session.turnId === null) return;

          session.turnId = null;
          session.eventChannel.push({
            type: 'complete',
            result: { isError: false, model: session.normalizationCtx.model },
          });
          await this.cleanupSession(session.sessionId, session);
        } catch (error) {
          if (!session.closed) {
            session.eventChannel.push({
              type: 'error',
              error: `Failed to flush Codex raw deltas: ${errorMessage(error)}`,
            });
            await this.cleanupSession(session.sessionId, session, {
              flushRawDeltas: false,
            });
          }
        }
      })();
    }, CODEX_IDLE_COMPLETION_TIMEOUT_MS);
    session.idleCompletionTimer.unref?.();
  }

  private clearIdleCompletionTimer(session: CodexSessionState): void {
    if (session.idleCompletionTimer === null) return;
    clearTimeout(session.idleCompletionTimer);
    session.idleCompletionTimer = null;
  }
}

function codexImageItem(image: PromptImagePart): unknown {
  return { type: 'image', url: `data:${image.mimeType};base64,${image.data}` };
}

function partsToCodexInput(parts: PromptPart[]): unknown[] {
  // Codex input items are ordered, so images pasted mid-prompt are emitted in
  // their original slot rather than after all the text.
  return interleavePromptParts(parts).map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image') return codexImageItem(part);
    return { type: 'text', text: `Attached file: ${part.filePath}` };
  });
}

function toCodexApprovalPolicy(_mode: InteractionMode): string {
  // Always `on-request`, including for `auto`. Codex treats `never` as "deny
  // anything that needs approval", and it classifies *every* MCP tool call as
  // needing approval — so `never` made the whole MCP surface (jean-claude's own
  // `ask_question`/`run_review`, plus any project MCP server) fail with
  // "MCP tool call requires approval, but approval policy is never".
  // `auto` keeps its no-prompt semantics by auto-approving in
  // `handleServerRequest` instead of by starving Codex of an approver.
  return 'on-request';
}

/** `auto` means bypass: approve without ever surfacing a prompt. */
function isAutoApproveMode(session: CodexSessionState): boolean {
  return session.normalizationCtx.interactionMode === 'auto';
}

function toCodexSandbox(mode: InteractionMode): string {
  if (mode === 'plan') return 'read-only';
  return 'workspace-write';
}

async function createCodexCollaborationMode(
  client: Awaited<ReturnType<typeof getOrCreateCodexAppServer>>['client'],
  config: AgentBackendConfig,
): Promise<{
  mode: 'default' | 'plan';
  settings: {
    model: string;
    reasoning_effort: string | null;
    developer_instructions: null;
  };
}> {
  const mode = config.interactionMode === 'plan' ? 'plan' : 'default';
  let model = config.model;
  if (model === undefined || model === 'default') {
    try {
      const result = (await client.request('model/list', {
        limit: 100,
      })) as { data?: unknown[] };
      const modelIds = (result.data ?? [])
        .map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return undefined;
          }
          const candidate = item as { id?: unknown };
          return typeof candidate.id === 'string' && candidate.id.trim()
            ? candidate.id
            : undefined;
        })
        .filter((id): id is string => id !== undefined);
      const defaultModel = result.data?.find((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return false;
        }
        const candidate = item as { id?: unknown; isDefault?: unknown };
        return (
          candidate.isDefault === true &&
          typeof candidate.id === 'string' &&
          candidate.id.trim().length > 0
        );
      }) as { id: string } | undefined;
      model = defaultModel?.id ?? modelIds[0] ?? 'default';
    } catch (error) {
      dbg.agent('Failed to resolve Codex default model for collaboration mode: %O', error);
      model = 'default';
    }
  }
  dbg.agent(
    'Starting Codex turn collaborationMode=%s model=%s reasoningEffort=%s',
    mode,
    model,
    config.thinkingEffort ?? 'default',
  );
  return {
    mode,
    settings: {
      model,
      reasoning_effort: config.thinkingEffort ?? null,
      developer_instructions: null,
    },
  };
}

function createCodexThreadConfig(config: AgentBackendConfig): {
  cwd: string;
  model: string | undefined;
  approvalPolicy: string;
  sandbox: string;
  config?: Record<string, unknown>;
} {
  const sandbox = toCodexSandbox(config.interactionMode);
  return {
    cwd: config.cwd,
    model: config.model === 'default' ? undefined : config.model,
    approvalPolicy: toCodexApprovalPolicy(config.interactionMode),
    sandbox,
    ...(sandbox === 'workspace-write'
      ? {
          config: {
            sandbox_workspace_write: {
              network_access: true,
              writable_roots: getCodexWritableRoots(config),
            },
            ...(config.mcpServers ? { mcp_servers: config.mcpServers } : {}),
          },
        }
      : config.mcpServers
        ? { config: { mcp_servers: config.mcpServers } }
        : {}),
  };
}

function getCodexWritableRoots(config: AgentBackendConfig): string[] {
  // External directories granted in project/global/session permissions have to
  // be added to the sandbox too — otherwise the grant is accepted by our
  // evaluator but Codex still refuses to write there.
  const allowedDirectories = getAllowedDirectories([
    ...(config.permissionRules ?? []),
    ...flattenScope(config.persistedSessionRules ?? {}),
  ]);

  return Array.from(
    new Set([
      ...getCodexPackageManagerCacheRoots(),
      ...getCodexWorktreeGitWritableRoots(config.cwd),
      ...allowedDirectories,
    ]),
  );
}

function getCodexPackageManagerCacheRoots(): string[] {
  const home = os.homedir();
  return [
    path.join(home, 'Library/pnpm'),
    path.join(home, 'Library/Caches/pnpm'),
    path.join(home, '.local/share/pnpm'),
    path.join(home, '.pnpm-store'),
    path.join(home, '.cache/pnpm'),
    path.join(home, '.npm'),
    path.join(home, '.cache/node-gyp'),
    path.join(home, 'Library/Caches/Yarn'),
    path.join(home, '.cache/yarn'),
    path.join(home, '.yarn/berry/cache'),
    path.join(home, 'Library/Caches/electron'),
    path.join(home, '.cache/electron'),
    path.join(home, 'Library/Caches/electron-builder'),
    path.join(home, '.cache/electron-builder'),
    path.join(home, 'Library/Caches/Cypress'),
    path.join(home, '.cache/Cypress'),
    path.join(home, 'Library/Caches/ms-playwright'),
    path.join(home, '.cache/ms-playwright'),
    path.join(home, 'Library/Caches/puppeteer'),
    path.join(home, '.cache/puppeteer'),
    path.join(home, '.cache/vite'),
    path.join(home, '.cache/turbo'),
    path.join(home, '.turbo'),
    path.join(home, '.cache/esbuild'),
    path.join(home, '.cache/swc'),
    path.join(home, '.cache/parcel'),
    path.join(home, 'Library/Caches/nx'),
    path.join(home, '.cache/nx'),
    path.join(home, '.gradle/caches'),
    path.join(home, 'Library/Caches/Homebrew'),
    path.join(home, '.cargo/registry'),
    path.join(home, '.cargo/git'),
    path.join(home, 'go/pkg/mod'),
    path.join(home, '.m2/repository'),
    path.join(home, '.ivy2/cache'),
  ];
}

function getCodexWorktreeGitWritableRoots(cwd: string): string[] {
  const gitFilePath = path.join(cwd, '.git');
  if (!fs.existsSync(gitFilePath) || !fs.statSync(gitFilePath).isFile()) {
    return [];
  }

  const gitFile = fs.readFileSync(gitFilePath, 'utf8').trim();
  const match = /^gitdir:\s*(.+)$/i.exec(gitFile);
  if (!match) return [];

  const gitDir = path.resolve(cwd, match[1]);
  const roots = [gitDir];
  const commonDirPath = path.join(gitDir, 'commondir');
  if (fs.existsSync(commonDirPath)) {
    const commonDir = fs.readFileSync(commonDirPath, 'utf8').trim();
    if (commonDir) {
      roots.push(path.resolve(gitDir, commonDir));
    }
  }

  return Array.from(new Set(roots));
}

function idFromResult(result: unknown, key: string): string | null {
  const data = record(result);
  const nested = record(data?.[key]);
  return (
    stringOrNull(nested?.id) ??
    stringOrNull(data?.id) ??
    stringOrNull(data?.[`${key}Id`])
  );
}

function threadIdFromNotification(
  notification: CodexJsonRpcNotification,
): string | null {
  const params = record(notification.params);
  const thread = record(params?.thread);
  return (
    stringOrNull(params?.threadId) ??
    stringOrNull(params?.thread_id) ??
    stringOrNull(thread?.id) ??
    (notification.method === 'thread/started' ? stringOrNull(params?.id) : null)
  );
}

function turnIdFromNotification(
  notification: CodexJsonRpcNotification,
): string | null {
  const params = record(notification.params);
  const turn = record(params?.turn);
  return stringOrNull(params?.turnId) ?? stringOrNull(turn?.id);
}

function notificationMatchesSession(
  notification: CodexJsonRpcNotification,
  session: CodexSessionState,
): boolean {
  const threadId = threadIdFromNotification(notification);
  const turnId = turnIdFromNotification(notification);
  let hasScope = false;
  let isChildThread = false;

  if (threadId !== null) {
    if (session.threadId !== null && threadId !== session.threadId) {
      isChildThread =
        notification.method.startsWith('item/') &&
        session.normalizationCtx.subagentToolIdsByThreadId.has(threadId);
      if (!isChildThread) return false;
    }
    hasScope = true;
  }

  if (turnId !== null) {
    if (session.turnId === null && threadId === null) {
      return false;
    }
    if (
      session.turnId !== null &&
      turnId !== session.turnId &&
      !isChildThread
    ) {
      return false;
    }
    hasScope = true;
  }

  return hasScope || !requiresSessionScope(notification.method);
}

function requestBelongsToSession(
  request: CodexJsonRpcRequest,
  session: CodexSessionState,
): boolean {
  const params = record(request.params);
  const threadId = stringOrNull(params?.threadId);
  const turnId = stringOrNull(params?.turnId);

  if (threadId !== null && threadId !== session.threadId) return false;
  if (turnId !== null && turnId !== session.turnId) return false;
  return threadId !== null || turnId !== null;
}

function parseQuestionAnswer(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [];

  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string');
    }
  } catch {
    // Single-choice and free-form answers are plain strings.
  }

  return [value];
}

function requiresSessionScope(method: string): boolean {
  return (
    method.startsWith('item/') ||
    method === 'turn/completed' ||
    method === 'thread/status/changed'
  );
}

function trackInFlightMcpTool(
  session: CodexSessionState,
  notification: CodexJsonRpcNotification,
): void {
  if (
    notification.method !== 'item/started' &&
    notification.method !== 'item/completed'
  ) {
    return;
  }
  const item = record(record(notification.params)?.item);
  if (stringOrNull(item?.type) !== 'mcpToolCall') return;
  const server = stringOrNull(item?.server);
  const tool = stringOrNull(item?.tool);
  if (server === null || tool === null) return;
  if (notification.method === 'item/started') {
    session.inFlightMcpTools.set(server, tool);
  } else {
    session.inFlightMcpTools.delete(server);
  }
}

function updateItemTracking(
  session: CodexSessionState,
  notification: CodexJsonRpcNotification,
): void {
  if (
    notification.method !== 'item/started' &&
    notification.method !== 'item/completed'
  ) {
    return;
  }

  const params = record(notification.params);
  const item = record(params?.item);
  const itemId = stringOrNull(item?.id) ?? stringOrNull(params?.itemId);
  if (itemId === null) return;
  if (isSpeculativeAgentCommandExecution(item)) return;

  session.sawTurnActivity = true;
  if (notification.method === 'item/started') {
    session.pendingItemIds.add(itemId);
  } else {
    session.pendingItemIds.delete(itemId);
  }
}

function isCodexDeltaNotification(
  notification: CodexJsonRpcNotification,
): notification is CodexDeltaNotification {
  if (
    notification.method !== 'item/agentMessage/delta' &&
    notification.method !== 'item/commandExecution/outputDelta'
  ) {
    return false;
  }

  const params = record(notification.params);
  return typeof params?.itemId === 'string' && typeof params.delta === 'string';
}

function getCodexDeltaPersistenceKey(
  notification: CodexDeltaNotification,
): string {
  const { threadId, turnId, itemId } = notification.params;
  return [notification.method, threadId ?? '', turnId ?? '', itemId].join('::');
}

function cloneCodexDeltaNotification(
  notification: CodexDeltaNotification,
): CodexDeltaNotification {
  return {
    method: notification.method,
    params: { ...notification.params },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isSpeculativeAgentCommandExecution(
  item: Record<string, unknown> | undefined,
): boolean {
  return (
    item !== undefined &&
    stringOrNull(item.type) === 'commandExecution' &&
    stringOrNull(item.source) === 'agent' &&
    stringOrNull(item.status) === 'inProgress' &&
    item.processId == null
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
