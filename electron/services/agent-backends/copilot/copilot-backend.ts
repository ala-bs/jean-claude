import path from 'node:path';

import { nanoid } from 'nanoid';

import type {
  AgentBackend,
  AgentBackendConfig,
  AgentEvent,
  AgentSession,
  AgentTaskContext,
  NormalizedPermissionRequest,
  NormalizedPermissionResponse,
  NormalizedQuestionRequest,
  PromptPart,
} from '@shared/agent-backend-types';
import type { InteractionMode, ThinkingEffort } from '@shared/types';
import type { QuestionResponse } from '@shared/agent-types';

import {
  evaluatePermission,
  flattenScope,
  normalizeToolRequest,
} from '../../permission-settings-service';
import { getPromptText } from '../../prompt-utils';
import type { ResolvedPermissionRule } from '../../../../shared/permission-types';

import {
  type CopilotNormalizationContext,
  normalizeCopilotEventV2,
} from './normalize-copilot-message-v2';
import { createCopilotClient } from './copilot-client';

const COPILOT_SESSION_SUMMARY_PROMPT = [
  'Summarize the prior session context for continuation.',
  'Return concise markdown with:',
  '- What was done',
  '- Key decisions',
  '- Files/components touched (if known)',
  '- Open risks or TODOs',
  '',
  'Keep it short and focused for an engineer continuing the task.',
].join('\n');

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

interface CopilotSessionState {
  sessionId: string;
  sdkSessionId: string | null;
  client: CopilotClientLike;
  sdkSession: CopilotSdkSession | null;
  eventChannel: AsyncEventChannel<AgentEvent>;
  unsubscribers: (() => void)[];
  messageIndex: number;
  eventProcessing: Promise<void>;
  closed: boolean;
  ready: boolean;
  startupEvents: AgentEvent[];
  cwd: string;
  mode: InteractionMode;
  permissionRules: ResolvedPermissionRule[];
  sessionAllowedTools: string[];
  pendingPermissions: Map<
    string,
    {
      request: CopilotPermissionRequest;
      sdkSessionPersistable: boolean;
      localSessionToolsToAllow: string[];
      resolve: (decision: CopilotPermissionDecision) => void;
    }
  >;
  pendingQuestions: Map<
    string,
    {
      request: CopilotUserInputRequest;
      resolve: (response: CopilotUserInputResponse) => void;
    }
  >;
  normalizationContext: CopilotNormalizationContext;
  releaseStartupWait?: () => void;
}

type CopilotClientLike = {
  start(): Promise<void>;
  stop?: () => Promise<unknown>;
  createSession(config?: CopilotSessionConfig): Promise<CopilotSdkSession>;
  resumeSession(
    sessionId: string,
    config?: CopilotSessionConfig,
  ): Promise<CopilotSdkSession>;
};

type CopilotSessionConfig = {
  model?: string;
  reasoningEffort?: Exclude<ThinkingEffort, 'default'>;
  agentMode?: CopilotAgentMode;
  mcpServers?: Record<string, CopilotMcpServerConfig>;
  onPermissionRequest?: (
    request: CopilotPermissionRequest,
    invocation?: unknown,
  ) => CopilotPermissionDecision | Promise<CopilotPermissionDecision>;
  onUserInputRequest?: (
    request: CopilotUserInputRequest,
  ) => CopilotUserInputResponse | Promise<CopilotUserInputResponse>;
};

type CopilotSdkSession = {
  sessionId: string;
  on(handler: (event: CopilotSdkEvent) => void): () => void;
  send(options: CopilotMessageOptions): Promise<unknown>;
  sendAndWait?: (options: CopilotMessageOptions) => Promise<unknown>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
};

type CopilotAgentMode = 'interactive' | 'plan' | 'autopilot';

type CopilotMcpServerConfig = {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type CopilotSdkEvent = {
  type?: unknown;
  data?: unknown;
};

type CopilotMessageOptions = {
  prompt: string;
  attachments?: CopilotAttachment[];
  agentMode?: CopilotAgentMode;
};

type CopilotAttachment =
  | { type: 'file'; path: string; displayName?: string }
  | { type: 'blob'; data: string; mimeType: string; displayName?: string };

type CopilotPermissionRequest = {
  kind?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  serverName?: unknown;
  commandIdentifiers?: unknown;
  commands?: unknown;
  fileName?: unknown;
  fullCommandText?: unknown;
  url?: unknown;
  [key: string]: unknown;
};

type CopilotPermissionDecision =
  | { kind: 'approve-once' }
  | { kind: 'approve-for-session'; approval?: unknown; domain?: string }
  | { kind: 'reject'; feedback?: string };

type CopilotUserInputRequest = {
  question?: unknown;
  choices?: unknown;
  allowFreeform?: unknown;
  [key: string]: unknown;
};

type CopilotUserInputResponse = {
  answer: string;
  wasFreeform: boolean;
};

export class CopilotBackend implements AgentBackend {
  private sessions = new Map<string, CopilotSessionState>();
  private completedSessionAllowedTools = new Map<string, string[]>();
  private taskContext: AgentTaskContext;

  constructor(context: AgentTaskContext) {
    this.taskContext = context;
  }

  async start(
    config: AgentBackendConfig,
    parts: PromptPart[],
  ): Promise<AgentSession> {
    const client = createCopilotClient({ cwd: config.cwd });
    const sessionId = nanoid();
    const persistedRules = flattenScope(config.persistedSessionRules ?? {});
    const persistedAllow = persistedRules
      .filter((rule) => rule.action === 'allow')
      .map((rule) =>
        rule.pattern === '*' ? rule.tool : `${rule.tool}:${rule.pattern}`,
      );
    let sdkSession: CopilotSdkSession;
    const session: CopilotSessionState = {
      sessionId,
      sdkSessionId: null,
      client,
      sdkSession: null,
      eventChannel: new AsyncEventChannel<AgentEvent>(),
      unsubscribers: [],
      messageIndex:
        this.taskContext.rawSessionStartIndex ??
        this.taskContext.sessionStartIndex,
      eventProcessing: Promise.resolve(),
      closed: false,
      ready: false,
      startupEvents: [],
      cwd: config.cwd,
      mode: config.interactionMode,
      permissionRules: [...(config.permissionRules ?? []), ...persistedRules],
      sessionAllowedTools: [...new Set(persistedAllow)],
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      normalizationContext: {},
    };
    this.completedSessionAllowedTools.delete(sessionId);
    this.sessions.set(sessionId, session);

    let startupReleased = false;
    const startupWait = new Promise<void>((resolve) => {
      session.releaseStartupWait = () => {
        if (startupReleased) return;
        startupReleased = true;
        resolve();
      };
    });

    const setup = (async () => {
      await client.start();

      const sessionConfig: CopilotSessionConfig = {};
      if (config.model && config.model !== 'default') {
        sessionConfig.model = config.model;
      }
      if (config.thinkingEffort && config.thinkingEffort !== 'default') {
        sessionConfig.reasoningEffort = config.thinkingEffort;
      }
      sessionConfig.agentMode = toCopilotAgentMode(config.interactionMode);
      if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
        sessionConfig.mcpServers = toCopilotMcpServers(config.mcpServers);
      }
      sessionConfig.onPermissionRequest = (request) => {
        return this.handlePermissionRequest(session, request);
      };
      sessionConfig.onUserInputRequest = (request) => {
        return this.handleUserInputRequest(session, request);
      };
      sdkSession = config.sessionId
        ? await client.resumeSession(config.sessionId, sessionConfig)
        : await client.createSession(sessionConfig);

      session.sdkSessionId = sdkSession.sessionId || null;
      session.sdkSession = sdkSession;
      if (session.sdkSessionId) {
        session.eventChannel.push({
          type: 'session-id',
          sessionId: session.sdkSessionId,
        });
      }
      session.ready = true;
      for (const event of session.startupEvents) {
        session.eventChannel.push(event);
      }
      session.startupEvents = [];
      session.unsubscribers.push(
        sdkSession.on((event) => {
          this.queueSdkEvent(session, event);
        }),
      );

      void sdkSession
        .send(toCopilotMessage(parts, session.mode))
        .catch((error: unknown) => {
          session.eventChannel.push({
            type: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
          session.eventChannel.push({
            type: 'complete',
            result: {
              isError: true,
              text: error instanceof Error ? error.message : String(error),
            },
          });
          void this.cleanupSession(session, {
            disconnect: true,
            stopClient: true,
          });
        });
    })().catch(async (error: unknown) => {
      if (!startupReleased) {
        await this.cleanupSession(session, {
          disconnect: true,
          stopClient: true,
        });
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      session.eventChannel.push({ type: 'error', error: message });
      session.eventChannel.push({
        type: 'complete',
        result: { isError: true, text: message },
      });
      await this.cleanupSession(session, {
        disconnect: true,
        stopClient: true,
      });
    });

    try {
      await Promise.race([setup, startupWait]);
    } catch (error) {
      this.sessions.delete(sessionId);
      throw error;
    }

    return {
      sessionId,
      events: session.eventChannel,
    };
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.completedSessionAllowedTools.delete(sessionId);
      return;
    }

    await this.cleanupSession(session, {
      abort: true,
      disconnect: true,
      stopClient: true,
    });
    this.completedSessionAllowedTools.delete(sessionId);
  }

  async respondToPermission(
    sessionId: string,
    requestId: string,
    response: NormalizedPermissionResponse,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`No Copilot session: ${sessionId}`);
    }

    const pending = session.pendingPermissions.get(requestId);
    if (!pending) {
      throw new Error(`No pending permission request: ${requestId}`);
    }

    if (response.allowMode === 'session' && response.toolsToAllow) {
      const localSessionToolsToAllow = new Set(
        pending.localSessionToolsToAllow,
      );
      session.sessionAllowedTools.push(
        ...response.toolsToAllow.filter((tool) =>
          localSessionToolsToAllow.has(tool),
        ),
      );
    }

    session.pendingPermissions.delete(requestId);
    pending.resolve(
      toCopilotPermissionDecision(
        response,
        pending.request,
        pending.sdkSessionPersistable,
      ),
    );
  }

  async respondToQuestion(
    sessionId: string,
    requestId: string,
    answer: Record<string, string>,
    metadata?: Pick<QuestionResponse, 'wasFreeform' | 'wasFreeformByQuestion'>,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`No Copilot session: ${sessionId}`);
    }

    const pending = session.pendingQuestions.get(requestId);
    if (!pending) {
      throw new Error(`No pending question request: ${requestId}`);
    }

    session.pendingQuestions.delete(requestId);
    pending.resolve(
      toCopilotUserInputResponse(answer, pending.request, metadata),
    );
  }

  async setMode(sessionId: string, mode: InteractionMode): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.mode = mode;
    }
    // Copilot SDK 1.0 has no session-level mode mutator; agentMode is sent with
    // create/resume and each message instead.
  }

  static async compactRawMessagesForTask(_taskId: string): Promise<void> {
    // Copilot raw events are already compact per SDK event; no compaction needed.
  }

  async summarizeSession({
    sessionId,
    cwd,
    model,
  }: {
    sessionId: string;
    cwd: string;
    model?: string;
  }): Promise<string> {
    const client = createCopilotClient({ cwd });
    let session: CopilotSdkSession | null = null;
    let unsubscribe: (() => void) | null = null;
    let assistantContent = '';

    try {
      await client.start();

      const sessionConfig: CopilotSessionConfig = {};
      if (model && model !== 'default') {
        sessionConfig.model = model;
      }
      session = sessionId
        ? await client.resumeSession(sessionId, sessionConfig)
        : await client.createSession(sessionConfig);
      unsubscribe = session.on((event) => {
        const content = extractCopilotAssistantContent(event)?.trim();
        if (content) {
          assistantContent = content;
        }
      });

      const prompt = COPILOT_SESSION_SUMMARY_PROMPT;
      if (!session.sendAndWait) {
        await session.send({ prompt });
        return assistantContent;
      }

      const response = await session.sendAndWait({ prompt });
      return (
        extractCopilotAssistantContent(response)?.trim() ?? assistantContent
      );
    } finally {
      unsubscribe?.();
      if (session) {
        await this.ignoreCleanupError(session.disconnect());
      }
      await this.ignoreCleanupError(client.stop?.());
    }
  }

  getSessionAllowedTools(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    return (
      session?.sessionAllowedTools ??
      this.completedSessionAllowedTools.get(sessionId) ??
      []
    );
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
    this.completedSessionAllowedTools.clear();
  }

  private queueSdkEvent(session: CopilotSessionState, event: CopilotSdkEvent) {
    if (session.closed) return;
    session.eventProcessing = session.eventProcessing
      .then(() => this.handleSdkEvent(session, event))
      .catch((error: unknown) =>
        this.handleEventProcessingError(session, error),
      );
  }

  private async handleSdkEvent(
    session: CopilotSessionState,
    event: CopilotSdkEvent,
  ): Promise<void> {
    if (session.closed) return;
    const messageIndex = session.messageIndex;
    session.messageIndex += 1;
    const rawMessageId = await this.taskContext.persistRaw({
      messageIndex,
      backendSessionId: session.sdkSessionId,
      rawData: event,
    });

    for (const normalized of normalizeCopilotEventV2(
      event,
      session.normalizationContext,
    )) {
      if (normalized.type === 'entry') {
        session.eventChannel.push({ ...normalized, rawMessageId });
      } else {
        session.eventChannel.push(normalized);
      }
    }

    if (event.type === 'session.idle') {
      await this.cleanupSession(session, {
        disconnect: true,
        stopClient: true,
      });
    } else if (event.type === 'session.error') {
      await this.cleanupSession(session, {
        disconnect: true,
        stopClient: true,
      });
    }
  }

  private async handleEventProcessingError(
    session: CopilotSessionState,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    session.eventChannel.push({ type: 'error', error: message });
    session.eventChannel.push({
      type: 'complete',
      result: { isError: true, text: message },
    });
    await this.cleanupSession(session, { disconnect: true, stopClient: true });
  }

  private async cleanupSession(
    session: CopilotSessionState,
    options: {
      abort?: boolean;
      disconnect?: boolean;
      stopClient?: boolean;
    } = {},
  ): Promise<void> {
    this.closeSession(session.sessionId, session);
    if (options.abort) {
      await this.ignoreCleanupError(session.sdkSession?.abort());
    }
    if (options.disconnect) {
      await this.ignoreCleanupError(session.sdkSession?.disconnect());
    }
    if (options.stopClient) {
      await this.ignoreCleanupError(session.client.stop?.());
    }
  }

  private closeSession(
    sessionId: string,
    session: CopilotSessionState,
    options: { preserveAllowedTools?: boolean } = {},
  ) {
    if (session.closed) return;
    session.closed = true;
    for (const [, pending] of session.pendingPermissions) {
      pending.resolve({ kind: 'reject', feedback: 'Session stopped' });
    }
    session.pendingPermissions.clear();
    for (const [, pending] of session.pendingQuestions) {
      pending.resolve({ answer: '', wasFreeform: true });
    }
    session.pendingQuestions.clear();
    for (const unsubscribe of session.unsubscribers) {
      try {
        unsubscribe();
      } catch {
        // Best-effort cleanup: channel/map must close even if SDK teardown fails.
      }
    }
    session.unsubscribers = [];
    session.startupEvents = [];
    session.eventChannel.close();
    this.sessions.delete(sessionId);
    if (
      options.preserveAllowedTools !== false &&
      session.sessionAllowedTools.length > 0
    ) {
      this.completedSessionAllowedTools.set(sessionId, [
        ...session.sessionAllowedTools,
      ]);
    } else {
      this.completedSessionAllowedTools.delete(sessionId);
    }
  }

  private async ignoreCleanupError(
    promise: Promise<unknown> | undefined,
  ): Promise<void> {
    try {
      await promise;
    } catch {
      // Best-effort cleanup: channel/map must close even if SDK teardown fails.
    }
  }

  private handlePermissionRequest(
    session: CopilotSessionState,
    request: CopilotPermissionRequest,
  ): Promise<CopilotPermissionDecision> | CopilotPermissionDecision {
    const normalized = toNormalizedPermissionRequest(request, session.cwd);
    const candidates = getPermissionCandidates(session.cwd, normalized);
    const action = evaluateCopilotPermission(
      session.permissionRules,
      candidates,
    );

    if (action === 'allow') {
      return { kind: 'approve-once' };
    }
    if (action === 'deny') {
      return {
        kind: 'reject',
        feedback: `Tool "${normalized.toolName}" is denied by permission rules`,
      };
    }

    if (isSessionAllowed(session.sessionAllowedTools, candidates)) {
      return { kind: 'approve-once' };
    }

    normalized.requestId = getUniqueRequestId(
      normalized.requestId,
      session.pendingPermissions,
    );

    return new Promise<CopilotPermissionDecision>((resolve) => {
      session.pendingPermissions.set(normalized.requestId, {
        request,
        sdkSessionPersistable: isSdkSessionPersistableCopilotRequest(request),
        localSessionToolsToAllow:
          normalized.sessionAllowButton?.toolsToAllow ?? [],
        resolve,
      });
      this.pushSessionEvent(session, {
        type: 'permission-request',
        request: normalized,
      });
    });
  }

  private handleUserInputRequest(
    session: CopilotSessionState,
    request: CopilotUserInputRequest,
  ): Promise<CopilotUserInputResponse> {
    const normalized = toNormalizedQuestionRequest(request);
    normalized.requestId = getUniqueRequestId(
      normalized.requestId,
      session.pendingQuestions,
    );

    return new Promise<CopilotUserInputResponse>((resolve) => {
      session.pendingQuestions.set(normalized.requestId, { request, resolve });
      this.pushSessionEvent(session, { type: 'question', request: normalized });
    });
  }

  private pushSessionEvent(session: CopilotSessionState, event: AgentEvent) {
    if (
      !session.ready &&
      (event.type === 'permission-request' || event.type === 'question')
    ) {
      session.eventChannel.push(event);
      session.releaseStartupWait?.();
      return;
    }

    if (session.ready) {
      session.eventChannel.push(event);
    } else {
      session.startupEvents.push(event);
    }
  }
}

function toCopilotMessage(
  parts: PromptPart[],
  mode?: InteractionMode,
): CopilotMessageOptions {
  const attachments: CopilotAttachment[] = [];

  for (const part of parts) {
    if (part.type === 'file') {
      attachments.push({
        type: 'file',
        path: part.filePath,
        displayName: part.filename,
      });
    } else if (part.type === 'image') {
      attachments.push({
        type: 'blob',
        data: part.data,
        mimeType: part.mimeType,
        displayName: part.filename,
      });
    }
  }

  const message: CopilotMessageOptions = {
    prompt: getPromptText(parts),
  };
  if (mode) {
    message.agentMode = toCopilotAgentMode(mode);
  }
  if (attachments.length > 0) {
    message.attachments = attachments;
  }
  return message;
}

function toCopilotAgentMode(mode: InteractionMode): CopilotAgentMode {
  if (mode === 'ask') return 'interactive';
  if (mode === 'auto') return 'autopilot';
  return 'plan';
}

function toCopilotMcpServers(
  servers: NonNullable<AgentBackendConfig['mcpServers']>,
): Record<string, CopilotMcpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      {
        type: 'stdio',
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: server.env } : {}),
      },
    ]),
  );
}

function extractCopilotAssistantContent(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (!isRecord(value)) {
    return null;
  }

  const directContent = textFromCopilotContent(value.content);
  if (directContent) {
    return directContent;
  }

  const dataContent = extractCopilotAssistantContent(value.data);
  if (dataContent) {
    return dataContent;
  }

  const messageContent = extractCopilotAssistantContent(value.message);
  if (messageContent) {
    return messageContent;
  }

  if (Array.isArray(value.messages)) {
    const assistantMessages = value.messages
      .map((message) => extractCopilotAssistantContent(message))
      .filter((content): content is string => Boolean(content?.trim()));
    return assistantMessages.at(-1) ?? null;
  }

  return null;
}

function textFromCopilotContent(content: unknown): string | null {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((part) => (isRecord(part) ? getString(part.text) : null))
    .filter((part): part is string => Boolean(part))
    .join('');
  return text || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toNormalizedPermissionRequest(
  request: CopilotPermissionRequest,
  cwd: string,
): NormalizedPermissionRequest {
  const kind = getString(request.kind) ?? 'unknown';
  const requestId = getString(request.toolCallId) ?? nanoid();
  const toolName = getString(request.toolName);
  const fileName = getString(request.fileName);
  const requestPath = getString(request.path);
  const fullCommandText = getString(request.fullCommandText);

  switch (kind) {
    case 'commands':
    case 'shell': {
      const input = { command: fullCommandText ?? '' };
      return {
        requestId,
        toolName: 'Bash',
        input,
        ...(fullCommandText
          ? { sessionAllowButton: buildSessionAllowButton('Bash', input) }
          : {}),
      };
    }
    case 'write': {
      const mappedTool = toolName?.toLowerCase().includes('edit')
        ? 'Edit'
        : 'Write';
      const input = { filePath: normalizeCopilotPath(fileName, cwd) };
      return {
        requestId,
        toolName: mappedTool,
        input,
        sessionAllowButton: buildSessionAllowButton(mappedTool, input),
      };
    }
    case 'read': {
      const input = {
        filePath: normalizeCopilotPath(requestPath ?? fileName, cwd),
      };
      return {
        requestId,
        toolName: 'Read',
        input,
        sessionAllowButton: buildSessionAllowButton('Read', input),
      };
    }
    case 'mcp': {
      const mappedTool = toolName ?? 'mcp';
      const input = { toolName: mappedTool, raw: request };
      return {
        requestId,
        toolName: mappedTool,
        input,
        description: `Copilot MCP tool request: ${mappedTool}`,
        sessionAllowButton: buildSessionAllowButton(mappedTool, input),
      };
    }
    default: {
      const mappedTool = `copilot:${kind}`;
      const input = {
        kind,
        ...(toolName ? { toolName } : {}),
        ...(fileName ? { filePath: normalizeCopilotPath(fileName, cwd) } : {}),
        ...(fullCommandText ? { command: fullCommandText } : {}),
        ...(getString(request.url) ? { url: getString(request.url) } : {}),
        raw: request,
      };
      return {
        requestId,
        toolName: mappedTool,
        input,
        description: `Copilot ${kind} permission request`,
      };
    }
  }
}

function toNormalizedQuestionRequest(
  request: CopilotUserInputRequest,
): NormalizedQuestionRequest {
  const question = getString(request.question) ?? 'Copilot needs input';
  const choices = getStringArray(request.choices);
  return {
    requestId: nanoid(),
    questions: [
      {
        question,
        header: question,
        options: choices.map((choice) => ({ label: choice, description: '' })),
        multiSelect: false,
        allowFreeform: request.allowFreeform !== false,
      },
    ],
  };
}

function isSdkSessionPersistableCopilotRequest(
  request: CopilotPermissionRequest,
): boolean {
  return Boolean(toCopilotSessionApproval(request));
}

function buildSessionAllowButton(
  toolName: string,
  input: Record<string, unknown>,
): NormalizedPermissionRequest['sessionAllowButton'] {
  const { tool, matchValue } = normalizeToolRequest(toolName, input);
  return {
    label: `Allow ${toolName} for Session`,
    toolsToAllow: [matchValue ? `${tool}:${matchValue}` : tool],
  };
}

function normalizeCopilotPath(
  filePath: string | undefined,
  cwd: string,
): string {
  if (!filePath) return '';
  if (!path.isAbsolute(filePath)) return filePath;
  const relativePath = path.relative(cwd, filePath);
  return relativePath &&
    !relativePath.startsWith('..') &&
    !path.isAbsolute(relativePath)
    ? relativePath
    : filePath;
}

function getPermissionCandidates(
  cwd: string,
  request: NormalizedPermissionRequest,
): { tool: string; matchValue: string }[] {
  const primary = normalizeToolRequest(request.toolName, request.input);
  const filePath = request.input.filePath;
  if (typeof filePath !== 'string' || filePath.length === 0) return [primary];

  const alternatePath = path.isAbsolute(filePath)
    ? normalizeCopilotPath(filePath, cwd)
    : path.join(cwd, filePath);
  if (alternatePath === filePath) return [primary];

  return [
    primary,
    normalizeToolRequest(request.toolName, {
      ...request.input,
      filePath: alternatePath,
    }),
  ];
}

function evaluateCopilotPermission(
  rules: ResolvedPermissionRule[],
  candidates: { tool: string; matchValue: string }[],
) {
  let allowed = false;
  for (const candidate of candidates) {
    const action = evaluatePermission(
      rules,
      candidate.tool,
      candidate.matchValue,
    );
    if (action === 'deny') return 'deny';
    if (action === 'allow') allowed = true;
  }
  return allowed ? 'allow' : 'ask';
}

function isSessionAllowed(
  sessionAllowedTools: string[],
  candidates: { tool: string; matchValue: string }[],
): boolean {
  return candidates.some(({ tool, matchValue }) => {
    const canonicalPermission = matchValue ? `${tool}:${matchValue}` : tool;
    return (
      sessionAllowedTools.includes(canonicalPermission) ||
      (matchValue.length > 0 && sessionAllowedTools.includes(tool))
    );
  });
}

function getUniqueRequestId(
  requestId: string,
  pendingRequests: ReadonlyMap<string, unknown>,
): string {
  if (!pendingRequests.has(requestId)) return requestId;
  let uniqueRequestId = `${requestId}-${nanoid()}`;
  while (pendingRequests.has(uniqueRequestId)) {
    uniqueRequestId = `${requestId}-${nanoid()}`;
  }
  return uniqueRequestId;
}

function toCopilotUserInputResponse(
  answer: Record<string, string>,
  request: CopilotUserInputRequest,
  metadata?: Pick<QuestionResponse, 'wasFreeform' | 'wasFreeformByQuestion'>,
): CopilotUserInputResponse {
  const entries = Object.entries(answer);

  return {
    answer:
      entries.length === 1
        ? entries[0][1]
        : entries.map(([label, value]) => `${label}: ${value}`).join('\n'),
    wasFreeform: getWasFreeform(entries, request, metadata),
  };
}

function getWasFreeform(
  entries: [string, string][],
  request: CopilotUserInputRequest,
  metadata?: Pick<QuestionResponse, 'wasFreeform' | 'wasFreeformByQuestion'>,
): boolean {
  if (entries.length === 1) {
    const [question, value] = entries[0];
    const perQuestion = metadata?.wasFreeformByQuestion?.[question];
    if (perQuestion !== undefined) return perQuestion;
    if (metadata?.wasFreeform !== undefined) return metadata.wasFreeform;

    const choices = getStringArray(request.choices);
    if (request.allowFreeform === false && choices.includes(value)) {
      return false;
    }
    return true;
  }

  if (metadata?.wasFreeformByQuestion) {
    return entries.some(
      ([question]) => metadata.wasFreeformByQuestion?.[question],
    );
  }
  return metadata?.wasFreeform ?? true;
}

function toCopilotPermissionDecision(
  response: NormalizedPermissionResponse,
  request: CopilotPermissionRequest,
  persistable: boolean,
): CopilotPermissionDecision {
  if (response.behavior === 'deny') {
    return { kind: 'reject', feedback: response.message };
  }
  if (persistable && response.allowMode === 'session') {
    const approval = toCopilotSessionApproval(request);
    if (approval) return { kind: 'approve-for-session', approval };
  }
  return { kind: 'approve-once' };
}

function toCopilotSessionApproval(
  request: CopilotPermissionRequest,
): unknown | undefined {
  const kind = getString(request.kind) ?? 'unknown';
  if (kind === 'commands' || kind === 'shell') {
    return undefined;
  }

  if (kind === 'mcp') {
    const serverName = getString(request.serverName);
    const toolName = getString(request.toolName);
    return serverName && toolName
      ? { kind: 'mcp', serverName, toolName }
      : undefined;
  }

  if (kind === 'custom-tool') {
    const toolName = getString(request.toolName);
    return toolName ? { kind: 'custom-tool', toolName } : undefined;
  }

  return undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === 'string' && item.length > 0,
      )
    : [];
}
