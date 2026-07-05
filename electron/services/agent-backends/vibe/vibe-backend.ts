import path from 'node:path';

import type {
  AgentBackend,
  AgentBackendConfig,
  AgentEvent,
  AgentSession,
  AgentTaskContext,
  NormalizedPermissionResponse,
  PromptPart,
} from '@shared/agent-backend-types';
import type { InteractionMode } from '@shared/types';
import type { ResolvedPermissionRule } from '@shared/permission-types';

import {
  createVibeNormalizationContext,
  normalizeVibeNotification,
} from './normalize-vibe-message-v2';
import {
  evaluatePermissionWithMatch,
  normalizeToolRequest,
} from '../../permission-settings-service';
import { getOrCreateVibeAcpServer } from './vibe-acp-server';

import type {
  AcpJsonRpcNotification,
  AcpJsonRpcRequest,
} from '../acp-json-rpc-client';
import type { NormalizedResult } from '@shared/normalized-message-v2';
import type { VibeNormalizationContext } from './normalize-vibe-message-v2';

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

type VibeSessionState = {
  sessionId: string;
  client: VibeAcpClient;
  eventChannel: AsyncEventChannel<AgentEvent>;
  normalizationCtx: VibeNormalizationContext;
  latestResultUpdate: NormalizedResult | null;
  permissionRules: ResolvedPermissionRule[];
  messageIndex: number;
  rawChunkRows: Map<
    string,
    { rowId: string; rawData: AcpJsonRpcNotification; dirty: boolean }
  >;
  unsubscribe: (() => void) | null;
  processing: Promise<void>;
  closed: boolean;
  pendingPermissions: Map<
    string,
    {
      jsonRpcId: string | number;
      allowOptionId: string | null;
      denyOptionId: string | null;
      tool: string;
      matchValue: string;
      inFlight: boolean;
    }
  >;
};

type VibeAcpClient = Awaited<
  ReturnType<typeof getOrCreateVibeAcpServer>
>['client'];

type ActiveVibeSession = {
  backend: VibeBackend;
  client: VibeAcpClient;
  session: VibeSessionState;
};

const activeVibeSessions = new Map<string, ActiveVibeSession>();
const vibeRequestRouters = new WeakMap<VibeAcpClient, () => void>();

export class VibeBackend implements AgentBackend {
  private readonly sessions = new Map<string, VibeSessionState>();

  constructor(private readonly taskContext: AgentTaskContext) {}

  async start(
    config: AgentBackendConfig,
    parts: PromptPart[],
  ): Promise<AgentSession> {
    const { client, rootPid } = await getOrCreateVibeAcpServer();
    const mcpServers = toVibeMcpServers(config.mcpServers);
    const sessionResult = config.sessionId
      ? await client.request('session/load', {
          cwd: config.cwd,
          sessionId: config.sessionId,
          mcpServers,
        })
      : await client.request('session/new', {
          cwd: config.cwd,
          mcpServers,
        });
    const sessionId = sessionIdFromResult(sessionResult) ?? config.sessionId;
    if (!sessionId) {
      throw new Error('Vibe session start did not return a session id');
    }

    const session: VibeSessionState = {
      sessionId,
      client,
      eventChannel: new AsyncEventChannel<AgentEvent>(),
      normalizationCtx: {
        ...createVibeNormalizationContext(),
        permissionRules: config.permissionRules ?? [],
      },
      latestResultUpdate: null,
      permissionRules: config.permissionRules ?? [],
      messageIndex:
        this.taskContext.rawSessionStartIndex ?? this.taskContext.sessionStartIndex,
      rawChunkRows: new Map(),
      unsubscribe: null,
      processing: Promise.resolve(),
      closed: false,
      pendingPermissions: new Map(),
    };
    this.sessions.set(sessionId, session);
    activeVibeSessions.set(sessionId, { backend: this, client, session });
    ensureVibeRequestRouter(client);
    session.eventChannel.push({ type: 'session-id', sessionId });

    try {
      session.unsubscribe = client.onNotification((notification) => {
        this.enqueueNotification(session, notification);
      });

      if (config.model && config.model !== 'default') {
        await client.request('session/set_config_option', {
          sessionId,
          configId: 'model',
          value: config.model,
        });
      }

      await client.request('session/set_mode', {
        sessionId,
        modeId: toVibeModeId(config.interactionMode),
      });
      void client
        .request('session/prompt', {
          sessionId,
          prompt: partsToVibePrompt(parts),
        })
        .then(() => this.completePrompt(session))
        .catch((error: unknown) => this.failPrompt(session, error));

      return {
        sessionId,
        events: session.eventChannel,
        rootPid,
      };
    } catch (error) {
      await this.cleanupSession(sessionId, session);
      throw error;
    }
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      await this.cancelPendingPermissions(session, session.client);
      await session.client.notify('session/cancel', { sessionId });
    } catch {
      // Cancellation is best-effort; local cleanup must still happen.
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
    if (!session) {
      throw new Error(`No Vibe session: ${sessionId}`);
    }

    const pending = session.pendingPermissions.get(requestId);
    if (!pending) {
      throw new Error(`No pending Vibe permission request: ${requestId}`);
    }
    if (pending.inFlight) {
      throw new Error(`Vibe permission response already in flight: ${requestId}`);
    }
    pending.inFlight = true;

    const optionId =
      response.behavior === 'allow'
        ? pending.allowOptionId
        : pending.denyOptionId;
    const outcome =
      optionId === null
        ? { outcome: 'cancelled' }
        : { outcome: 'selected', optionId };
    const rollbackPermissionDecision =
      response.behavior === 'allow'
        ? pushPermissionDecision(session, {
            allowedBy: 'agent',
            tool: pending.tool,
            matchValue: pending.matchValue,
          })
        : null;

    try {
      await session.client.respond(pending.jsonRpcId, { outcome });
      session.pendingPermissions.delete(requestId);
    } catch (error) {
      rollbackPermissionDecision?.();
      pending.inFlight = false;
      throw error;
    }
  }

  async respondToQuestion(
    _sessionId: string,
    _requestId: string,
    _answer: Record<string, string>,
  ): Promise<void> {}

  async setMode(
    sessionId: string,
    mode: InteractionMode,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    await session.client.request('session/set_mode', {
      sessionId,
      modeId: toVibeModeId(mode),
    });
  }

  async dispose(): Promise<void> {
    await Promise.all(
      Array.from(this.sessions.keys()).map((sessionId) => this.stop(sessionId)),
    );
  }

  private enqueueNotification(
    session: VibeSessionState,
    notification: AcpJsonRpcNotification,
  ): void {
    if (session.closed) return;

    session.processing = session.processing
      .catch(() => undefined)
      .then(() => this.handleNotification(session, notification))
      .catch((error: unknown) => {
        if (!session.closed) {
          session.eventChannel.push({
            type: 'error',
            error: `Vibe notification processing failed: ${errorMessage(error)}`,
          });
        }
      });
  }

  private async handleNotification(
    session: VibeSessionState,
    notification: AcpJsonRpcNotification,
  ): Promise<void> {
    if (session.closed || !notificationMatchesSession(notification, session.sessionId)) {
      return;
    }

    let rawMessageId: string;
    try {
      rawMessageId = await this.persistRawNotification(session, notification);
    } catch (error) {
      if (!session.closed) {
        session.eventChannel.push({
          type: 'error',
          error: `Failed to persist Vibe raw notification: ${errorMessage(error)}`,
        });
        await this.cleanupSession(session.sessionId, session);
      }
      return;
    }

    if (session.closed) return;

    for (const event of normalizeVibeNotification(
      {
        method: notification.method,
        params: record(notification.params),
      },
      session.normalizationCtx,
    )) {
      if (session.closed) return;

      if (event.type === 'entry') {
        session.eventChannel.push({ ...event, rawMessageId });
      } else if (event.type === 'result-update') {
        session.latestResultUpdate = event.result;
        session.eventChannel.push(event as AgentEvent);
      } else {
        session.eventChannel.push(event as AgentEvent);
      }

      if (event.type === 'complete' || event.type === 'error') {
        await this.cleanupSession(session.sessionId, session);
        return;
      }
    }
  }

  async handleRoutedRequest(
    session: VibeSessionState,
    client: VibeAcpClient,
    request: AcpJsonRpcRequest,
  ): Promise<void> {
    if (session.closed) {
      await respondRequestError(
        client,
        request.id,
        -32000,
        'Vibe session is closed',
      );
      return;
    }

    if (request.method !== 'session/request_permission') {
      await respondRequestError(client, request.id, -32601, 'Method not found');
      return;
    }

    if (!requestMatchesSession(request, session.sessionId)) {
      if (requestHasSessionId(request)) return;
      await respondRequestError(
        client,
        request.id,
        -32602,
        'Invalid session/request_permission params',
      );
      return;
    }

    const params = record(request.params);
    const requestId =
      stringOrUndefined(params?.requestId) ??
      stringOrUndefined(params?.request_id) ??
      stringOrUndefined(params?.id);
    if (!requestId) {
      await respondRequestError(
        client,
        request.id,
        -32602,
        'Invalid session/request_permission params',
      );
      return;
    }

    await this.handlePermissionRequest(session, client, request);
  }

  private async handlePermissionRequest(
    session: VibeSessionState,
    client: VibeAcpClient,
    request: AcpJsonRpcRequest,
  ): Promise<void> {
    const params = record(request.params) ?? {};
    const requestId =
      stringOrUndefined(params.requestId) ??
      stringOrUndefined(params.request_id) ??
      stringOrUndefined(params.id);
    if (!requestId) return;

    if (session.pendingPermissions.has(requestId)) {
      await respondRequestError(
        client,
        request.id,
        -32000,
        `Duplicate Vibe permission request: ${requestId}`,
      );
      return;
    }

    const toolCall = record(params.toolCall) ?? record(params.tool_call);
    const options = arrayOfRecords(params.options);
    const tool = toolFromPermissionParams(params, toolCall);
    const toolMatch = normalizeToolRequest(tool.toolName, tool.input);
    const permissionDecision = evaluatePermissionWithMatch(
      session.permissionRules,
      toolMatch.tool,
      toolMatch.matchValue,
    );
    if (permissionDecision.action !== 'ask') {
      const optionId =
        permissionDecision.action === 'allow'
          ? findPermissionOptionId(options, 'allow')
          : findPermissionOptionId(options, 'deny');
      const rollbackPermissionDecision =
        permissionDecision.action === 'allow'
          ? pushPermissionDecision(
              session,
              permissionDecision.matchedRule
                ? {
                    allowedBy: 'system',
                    tool: toolMatch.tool,
                    matchValue: toolMatch.matchValue,
                    rule: {
                      tool: permissionDecision.matchedRule.tool,
                      pattern: permissionDecision.matchedRule.pattern,
                    },
                  }
                : {
                    allowedBy: 'system',
                    tool: toolMatch.tool,
                    matchValue: toolMatch.matchValue,
                  },
            )
          : null;
      try {
        await client.respond(request.id, {
          outcome:
            optionId === null
              ? { outcome: 'cancelled' }
              : { outcome: 'selected', optionId },
        });
      } catch (error) {
        rollbackPermissionDecision?.();
        throw error;
      }
      return;
    }

    session.pendingPermissions.set(requestId, {
      jsonRpcId: request.id,
      allowOptionId: findPermissionOptionId(options, 'allow'),
      denyOptionId: findPermissionOptionId(options, 'deny'),
      tool: toolMatch.tool,
      matchValue: toolMatch.matchValue,
      inFlight: false,
    });

    session.eventChannel.push({
      type: 'permission-request',
      request: {
        requestId,
        toolName: tool.toolName,
        input: tool.input,
        description:
          stringOrUndefined(params.description) ??
          stringOrUndefined(params.title) ??
          stringOrUndefined(toolCall?.title),
      },
    });
  }

  private async cleanupSession(
    sessionId: string,
    session: VibeSessionState,
  ): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    await this.flushRawChunkRows(session);
    await this.cancelPendingPermissions(session, session.client);
    activeVibeSessions.delete(sessionId);
    session.unsubscribe?.();
    session.unsubscribe = null;
    session.eventChannel.close();
    this.sessions.delete(sessionId);
  }

  private async persistRawNotification(
    session: VibeSessionState,
    notification: AcpJsonRpcNotification,
  ): Promise<string> {
    const chunk = getTextChunkPersistenceInfo(notification);
    if (!this.taskContext.updateRaw || !chunk) {
      await this.flushRawChunkRows(session);
      return this.taskContext.persistRaw({
        messageIndex: session.messageIndex++,
        backendSessionId: session.sessionId,
        rawData: notification,
      });
    }

    const existing = session.rawChunkRows.get(chunk.key);
    if (!existing) {
      const rowId = await this.taskContext.persistRaw({
        messageIndex: session.messageIndex++,
        backendSessionId: session.sessionId,
        rawData: notification,
      });
      session.rawChunkRows.set(chunk.key, {
        rowId,
        rawData: cloneNotification(notification),
        dirty: false,
      });
      return rowId;
    }

    appendTextChunk(existing.rawData, chunk.text);
    existing.dirty = true;
    return existing.rowId;
  }

  private async flushRawChunkRows(session: VibeSessionState): Promise<void> {
    if (!this.taskContext.updateRaw) return;

    for (const row of session.rawChunkRows.values()) {
      if (!row.dirty) continue;

      try {
        await this.taskContext.updateRaw({ rowId: row.rowId, rawData: row.rawData });
      } catch (error) {
        if (!session.closed) throw error;
        continue;
      }
      row.dirty = false;
    }
  }

  private async completePrompt(session: VibeSessionState): Promise<void> {
    await session.processing.catch(() => undefined);
    if (session.closed) return;

    session.eventChannel.push({
      type: 'complete',
      result: { ...session.latestResultUpdate, isError: false },
    });
    await this.cleanupSession(session.sessionId, session);
  }

  private async failPrompt(
    session: VibeSessionState,
    error: unknown,
  ): Promise<void> {
    await session.processing.catch(() => undefined);
    if (session.closed) return;

    const message = errorMessage(error);
    session.eventChannel.push({ type: 'error', error: message });
    session.eventChannel.push({
      type: 'complete',
      result: { isError: true, text: message },
    });
    await this.cleanupSession(session.sessionId, session);
  }

  private async cancelPendingPermissions(
    session: VibeSessionState,
    client: VibeAcpClient,
  ): Promise<void> {
    const pending = Array.from(session.pendingPermissions.values()).filter(
      (permission) => !permission.inFlight,
    );
    session.pendingPermissions.clear();
    await Promise.all(
      pending.map((permission) =>
        client
          .respond(permission.jsonRpcId, { outcome: { outcome: 'cancelled' } })
          .catch(() => undefined),
      ),
    );
  }
}

function ensureVibeRequestRouter(client: VibeAcpClient): void {
  if (vibeRequestRouters.has(client)) return;

  const unsubscribe = client.onRequest((request) => {
    void routeVibeRequest(client, request);
  });
  vibeRequestRouters.set(client, unsubscribe);
}

async function routeVibeRequest(
  client: VibeAcpClient,
  request: AcpJsonRpcRequest,
): Promise<void> {
  const sessionId = sessionIdFromRequest(request);
  if (sessionId !== undefined) {
    const active = activeVibeSessions.get(sessionId);
    if (active !== undefined && active.client === client) {
      await active.backend.handleRoutedRequest(active.session, client, request);
      return;
    }

    await respondRequestError(client, request.id, -32000, 'Unknown Vibe session');
    return;
  }

  await respondRequestError(client, request.id, -32601, 'Method not found');
}

async function respondRequestError(
  client: VibeAcpClient,
  id: string | number,
  code: number,
  message: string,
): Promise<void> {
  try {
    await client.respondError(id, { code, message });
  } catch {
    // Server request errors are best-effort; stream errors surface separately.
  }
}

function partsToVibePrompt(parts: PromptPart[]): unknown[] {
  return parts.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image') {
      return { type: 'image', mimeType: part.mimeType, data: part.data };
    }
    return { type: 'text', text: `Attached file: ${part.filePath}` };
  });
}

function toVibeMcpServers(
  mcpServers: AgentBackendConfig['mcpServers'],
): Array<{
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}> {
  return Object.entries(mcpServers ?? {}).map(([name, server]) => {
    const command = resolveMcpCommand(server.command);
    const args =
      command === server.command || server.command === 'node'
        ? (server.args ?? [])
        : [server.command, ...(server.args ?? [])];
    return {
      name,
      command,
      args,
      env: Object.entries(server.env ?? {}).map(([envName, value]) => ({
        name: envName,
        value,
      })),
    };
  });
}

function resolveMcpCommand(command: string): string {
  if (command === 'node') return process.execPath;
  if (path.isAbsolute(command)) return command;
  return '/usr/bin/env';
}

function toVibeModeId(mode: InteractionMode): string {
  if (mode === 'plan') return 'plan';
  if (mode === 'auto') return 'auto-approve';
  return 'default';
}

function sessionIdFromResult(result: unknown): string | undefined {
  return sessionIdFromParams(record(result));
}

function notificationMatchesSession(
  notification: AcpJsonRpcNotification,
  sessionId: string,
): boolean {
  if (notification.method !== 'session/update') {
    return false;
  }

  const params = record(notification.params);
  return sessionIdFromParams(params) === sessionId;
}

function requestMatchesSession(
  request: AcpJsonRpcRequest,
  sessionId: string,
): boolean {
  return sessionIdFromRequest(request) === sessionId;
}

function sessionIdFromRequest(request: AcpJsonRpcRequest): string | undefined {
  return sessionIdFromParams(record(request.params));
}

function requestHasSessionId(request: AcpJsonRpcRequest): boolean {
  return sessionIdFromParams(record(request.params)) !== undefined;
}

function sessionIdFromParams(
  params: Record<string, unknown> | undefined,
): string | undefined {
  const session = record(params?.session);
  return (
    stringOrUndefined(params?.sessionId) ??
    stringOrUndefined(params?.session_id) ??
    stringOrUndefined(session?.id)
  );
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object',
      )
    : [];
}

function findPermissionOptionId(
  options: Array<Record<string, unknown>>,
  behavior: 'allow' | 'deny',
): string | null {
  const semanticFields = ['optionId', 'option_id', 'id', 'kind', 'outcome'];
  const labelFields = ['label', 'name'];
  const option =
    options.find((candidate) =>
      semanticFields.some((field) =>
        permissionTextMatches(candidate[field], behavior, false),
      ),
    ) ??
    options.find((candidate) =>
      labelFields.some((field) =>
        permissionTextMatches(candidate[field], behavior, true),
      ),
    );

  return (
    stringOrUndefined(option?.optionId) ??
    stringOrUndefined(option?.option_id) ??
    stringOrUndefined(option?.id) ??
    null
  );
}

function permissionTextMatches(
  value: unknown,
  behavior: 'allow' | 'deny',
  isLabel: boolean,
): boolean {
  if (typeof value !== 'string') return false;

  const text = value.toLowerCase();
  if (isNegativeAllowText(text)) return behavior === 'deny';

  const tokens = text.match(/[a-z0-9]+/g) ?? [];
  const allowWords = ['allow', 'approve', 'accept', 'yes'];
  const denyWords = ['deny', 'reject', 'cancel', 'no'];
  const words = behavior === 'allow' ? allowWords : denyWords;
  const oppositeWords = behavior === 'allow' ? denyWords : allowWords;

  if (behavior === 'allow' && tokens.some((token) => denyWords.includes(token))) {
    return false;
  }

  if (!isLabel && tokens.some((token) => oppositeWords.includes(token))) {
    return false;
  }

  return tokens.some((token) => words.includes(token));
}

function isNegativeAllowText(text: string): boolean {
  return /\b(do\s*not|don't|dont|never)\s+allow\b/.test(text);
}

function toolFromPermissionParams(
  params: Record<string, unknown>,
  toolCall: Record<string, unknown> | undefined,
): { toolName: string; input: Record<string, unknown> } {
  const input =
    record(toolCall?.input) ??
    record(params.input) ??
    parseJsonRecord(toolCall?.rawInput) ??
    parseJsonRecord(toolCall?.raw_input) ??
    parseJsonRecord(params.rawInput) ??
    parseJsonRecord(params.raw_input) ??
    {};
  const explicitName =
    stringOrUndefined(params.toolName) ??
    stringOrUndefined(params.tool_name) ??
    stringOrUndefined(record(params._meta)?.tool_name) ??
    stringOrUndefined(toolCall?.name) ??
    stringOrUndefined(record(toolCall?._meta)?.tool_name) ??
    toolNameFromKind(stringOrUndefined(params.kind)) ??
    toolNameFromKind(stringOrUndefined(toolCall?.kind));
  if (explicitName) return { toolName: explicitName, input };

  const title = stringOrUndefined(toolCall?.title) ?? stringOrUndefined(params.title);
  const parsed = parseToolTitle(title);
  if (parsed === null) {
    return { toolName: title ?? 'tool', input };
  }

  if (Object.keys(input).length > 0) {
    return { toolName: parsed.toolName, input };
  }

  if (parsed.toolName === 'bash') {
    return { toolName: 'bash', input: { command: parsed.value } };
  }

  return { toolName: parsed.toolName, input: { value: parsed.value } };
}

function pushPermissionDecision(
  session: VibeSessionState,
  decision: NonNullable<
    VibeNormalizationContext['pendingToolPermissionDecisions']
  >[number],
): () => void {
  const decisions = (session.normalizationCtx.pendingToolPermissionDecisions ??= []);
  decisions.push(decision);
  return () => {
    const index = decisions.indexOf(decision);
    if (index !== -1) decisions.splice(index, 1);
  };
}

function toolNameFromKind(kind: string | undefined): string | undefined {
  if (kind === 'execute') return 'bash';
  if (kind === 'read') return 'read';
  return undefined;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  const valueRecord = record(value);
  if (valueRecord !== undefined) return valueRecord;

  const json = stringOrUndefined(value);
  if (json === undefined) return undefined;

  try {
    return record(JSON.parse(json));
  } catch {
    return undefined;
  }
}

function parseToolTitle(
  title: string | undefined,
): { toolName: string; value: string } | null {
  if (!title) return null;

  const match = /^\s*([\w.-]+)(?::|\s+)\s*(.+)\s*$/.exec(title);
  if (!match) return null;

  return { toolName: match[1].toLowerCase(), value: match[2] };
}

function getTextChunkPersistenceInfo(
  notification: AcpJsonRpcNotification,
): { key: string; text: string } | null {
  if (notification.method !== 'session/update') return null;

  const update = getNotificationUpdate(record(notification.params));
  const updateType =
    stringOrUndefined(update?.sessionUpdate) ??
    stringOrUndefined(update?.session_update) ??
    stringOrUndefined(update?.type);
  if (
    updateType !== 'agent_message_chunk' &&
    updateType !== 'agent_thought_chunk'
  ) {
    return null;
  }

  const messageId =
    stringOrUndefined(update?.messageId) ??
    stringOrUndefined(update?.message_id) ??
    stringOrUndefined(update?.id) ??
    stringOrUndefined(record(update?.message)?.id);
  const text = textChunkFromUpdate(update);
  if (!messageId || text === undefined) return null;

  return { key: `${updateType}:${messageId}`, text };
}

function getNotificationUpdate(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const update =
    record(params?.update) ??
    record(params?.sessionUpdate) ??
    record(params?.session_update) ??
    params;
  const updateType =
    stringOrUndefined(update?.sessionUpdate) ??
    stringOrUndefined(update?.session_update) ??
    stringOrUndefined(update?.type);

  return (
    record(update?.sessionUpdate) ??
    record(update?.session_update) ??
    (updateType ? update : undefined)
  );
}

function textChunkFromUpdate(
  update: Record<string, unknown> | undefined,
): string | undefined {
  if (!update) return undefined;

  return (
    textFromChunkValue(update.content) ??
    stringOrUndefined(update.text) ??
    stringOrUndefined(update.delta) ??
    stringOrUndefined(update.chunk) ??
    textFromChunkValue(record(update.message)?.content)
  );
}

function textFromChunkValue(value: unknown): string | undefined {
  const direct = stringOrUndefined(value);
  if (direct !== undefined) return direct;

  if (Array.isArray(value)) {
    const parts = value.flatMap((item) => {
      const text = textFromChunkValue(item);
      return text === undefined ? [] : [text];
    });
    return parts.length > 0 ? parts.join('') : undefined;
  }

  const valueRecord = record(value);
  if (!valueRecord) return undefined;

  return (
    stringOrUndefined(valueRecord.text) ??
    stringOrUndefined(valueRecord.content) ??
    textFromChunkValue(valueRecord.content)
  );
}

function appendTextChunk(
  notification: AcpJsonRpcNotification,
  text: string,
): void {
  const update = getNotificationUpdate(record(notification.params));
  if (!update) return;

  const content = record(update.content);
  if (typeof content?.text === 'string') {
    content.text += text;
    return;
  }

  for (const field of ['text', 'delta', 'chunk']) {
    if (typeof update[field] === 'string') {
      update[field] += text;
      return;
    }
  }

  update.content = { type: 'text', text };
}

function cloneNotification(
  notification: AcpJsonRpcNotification,
): AcpJsonRpcNotification {
  return JSON.parse(JSON.stringify(notification)) as AcpJsonRpcNotification;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
